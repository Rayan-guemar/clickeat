"""PostgreSQL storage. Each mutation is a durable ticket, committed in FIFO order.

A transaction-level advisory lock protects business decisions across API workers.
A second short lock orders ticket insertion/commit (sequences alone don't do this).
Reads use repeatable-read snapshots. No SQLite and no application-wide JSON row.
"""
import copy
import hashlib
from decimal import Decimal
from pathlib import Path
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb
from .domain import AppError, apply, check_basket, fresh, now_ms, snapshot

MUTATION_LOCK = 48192001
ENQUEUE_LOCK = 48192002
MIGRATION_LOCK = 48192003


async def rows(conn, query, params=()):
    return await (await conn.execute(query, params)).fetchall()


async def one(conn, query, params=()):
    return await (await conn.execute(query, params)).fetchone()


class Repository:
    def __init__(self, pool):
        self.pool = pool

    async def init(self):
        async with self.pool.connection() as conn:
            async with conn.transaction():
                await conn.execute('SELECT pg_advisory_xact_lock(%s)', (MIGRATION_LOCK,))
                await conn.execute('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL)')
                for path in sorted(Path(__file__).with_name('migrations').glob('*.sql')):
                    sql = path.read_text()
                    checksum = hashlib.sha256(sql.encode()).hexdigest()
                    previous = await one(conn, 'SELECT checksum FROM schema_migrations WHERE name=%s', (path.name,))
                    if previous:
                        if previous['checksum'] != checksum:
                            raise RuntimeError('Migration déjà appliquée modifiée : '+path.name)
                        continue
                    await conn.execute(sql, prepare=False)
                    await conn.execute('INSERT INTO schema_migrations VALUES (%s,%s)', (path.name, checksum))
                if not await one(conn, 'SELECT id FROM settings WHERE id=1'):
                    s = fresh()
                    await conn.execute('INSERT INTO settings(id,capacity) VALUES (1,%s)', (s['capacity'],))
                    for key, item in s['stock'].items():
                        await conn.execute('INSERT INTO ingredients VALUES (%s,%s,%s,%s,%s)',
                                           (key, item['name'], item['qty'], item['unit'], item['alert']))
                    for index, recipe in enumerate(s['catalog']):
                        await self.save_recipe(conn, recipe, index)

    async def visitor(self, cookie):
        auth_key = hashlib.sha256(cookie.encode()).hexdigest()
        async with self.pool.connection() as conn:
            existing = await one(conn, 'SELECT id FROM visitors WHERE auth_key=%s', (auth_key,))
            if existing:
                return str(existing['id'])
            await conn.execute('INSERT INTO visitors VALUES (%s,%s,%s) ON CONFLICT (auth_key) DO NOTHING',
                               (uuid4(), auth_key, now_ms()))
            return str((await one(conn, 'SELECT id FROM visitors WHERE auth_key=%s', (auth_key,)))['id'])

    async def load(self, conn):
        settings = await one(conn, 'SELECT * FROM settings WHERE id=1')
        s = dict(capacity=settings['capacity'], revision=settings['revision'], pausedUntil=settings['paused_until'],
                 catalogVersion=settings['catalog_version'], next=settings['next_order'], orders=[], holds={},
                 notifications=[], stock={}, catalog=[], slotCapacities={})
        s['stock'] = {r['id']: {k: v for k, v in r.items() if k != 'id'} for r in await rows(conn, 'SELECT * FROM ingredients')}
        bom = {}
        for r in await rows(conn, 'SELECT * FROM recipe_ingredients'):
            bom.setdefault(r['recipe_id'], {})[r['ingredient_id']] = r['quantity']
        for r in await rows(conn, 'SELECT * FROM recipes ORDER BY position,id'):
            s['catalog'].append(dict(id=r['id'], name=r['name'], desc=r['description'], tag=r['tag'],
                                     price=r['price_cents']/100, active=r['active'], bom=bom[r['id']]))
        s['slotCapacities'] = {str(r['slot']): r['capacity'] for r in await rows(conn, 'SELECT * FROM slot_capacities')}
        s['orders'] = [r['data'] for r in await rows(conn, 'SELECT data FROM orders ORDER BY id')]
        s['holds'] = {str(r['visitor_id']): r['data'] for r in await rows(conn, 'SELECT visitor_id,data FROM reservations')}
        s['notifications'] = [dict(at=r['at'], text=r['text']) for r in await rows(conn, 'SELECT at,text FROM notifications ORDER BY id')]
        return s

    async def save_recipe(self, conn, r, position):
        await conn.execute('''INSERT INTO recipes VALUES (%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description,
            tag=EXCLUDED.tag, price_cents=EXCLUDED.price_cents, active=EXCLUDED.active''',
            (r['id'], r['name'], r['desc'], r['tag'], int(Decimal(str(r['price']))*100), r.get('active', True), position))
        await conn.execute('DELETE FROM recipe_ingredients WHERE recipe_id=%s', (r['id'],))
        for key, n in r['bom'].items():
            await conn.execute('INSERT INTO recipe_ingredients VALUES (%s,%s,%s)', (r['id'], key, n))

    async def persist(self, conn, before, s):
        await conn.execute('''UPDATE settings SET revision=%s,capacity=%s,paused_until=%s,
            catalog_version=%s,next_order=%s WHERE id=1''',
            (s['revision'], s['capacity'], s['pausedUntil'], s['catalogVersion'], s['next']))
        for key, item in s['stock'].items():
            if item != before['stock'].get(key):
                await conn.execute('UPDATE ingredients SET qty=%s WHERE id=%s', (item['qty'], key))
        old_recipes = {r['id']: r for r in before['catalog']}
        for position, recipe in enumerate(s['catalog']):
            if recipe != old_recipes.get(recipe['id']):
                await self.save_recipe(conn, recipe, position)
        for key in before['slotCapacities'].keys() - s['slotCapacities'].keys():
            await conn.execute('DELETE FROM slot_capacities WHERE slot=%s', (int(key),))
        for key, n in s['slotCapacities'].items():
            if n != before['slotCapacities'].get(key):
                await conn.execute('INSERT INTO slot_capacities VALUES (%s,%s) ON CONFLICT (slot) DO UPDATE SET capacity=EXCLUDED.capacity', (int(key), n))
        for visitor in before['holds'].keys() - s['holds'].keys():
            await conn.execute('DELETE FROM reservations WHERE visitor_id=%s', (visitor,))
        for visitor, h in s['holds'].items():
            if h != before['holds'].get(visitor):
                await conn.execute('''INSERT INTO reservations VALUES (%s,%s,%s,%s,%s)
                    ON CONFLICT (visitor_id) DO UPDATE SET id=EXCLUDED.id,slot=EXCLUDED.slot,
                    expires=EXCLUDED.expires,data=EXCLUDED.data''', (visitor, h['id'], h['slot'], h['expires'], Jsonb(h)))
        old_orders = {o['id']: o for o in before['orders']}
        for o in s['orders']:
            if o != old_orders.get(o['id']):
                await conn.execute('''INSERT INTO orders VALUES (%s,%s,%s,%s,%s)
                    ON CONFLICT (id) DO UPDATE SET slot=EXCLUDED.slot,status=EXCLUDED.status,data=EXCLUDED.data''',
                    (o['id'], o['session'], o['slot'], o['status'], Jsonb(o)))
        for notice in s['notifications'][len(before['notifications']):]:
            await conn.execute('INSERT INTO notifications(at,text) VALUES (%s,%s)', (notice['at'], notice['text']))

    async def view(self, conn, s, visitor, role):
        result = snapshot(s, visitor, role)
        query = "SELECT * FROM requests WHERE action='reserve'"
        params = ()
        if role != 'manager':
            query += ' AND visitor_id=%s'
            params = (visitor,)
        tickets = await rows(conn, query+' ORDER BY sequence DESC LIMIT '+('30' if role == 'manager' else '1'), params)
        result['reservationQueue'] = [dict(sequence=t['sequence'], clientId=str(t['visitor_id']),
            requestId=str(t['request_id']), receivedAt=t['received_at'], status=t['status'],
            reason=t['error']['message'] if t['error'] else None) for t in tickets]
        return result

    async def get(self, visitor, role='client'):
        async with self.pool.connection() as conn:
            async with conn.transaction():
                await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
                return await self.view(conn, await self.load(conn), visitor, role)

    async def check(self, items, slot):
        async with self.pool.connection() as conn:
            async with conn.transaction():
                await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
                return check_basket(await self.load(conn), items, slot)

    async def enqueue(self, visitor, request_id, action, payload):
        try:
            request_id = UUID(request_id)
        except (ValueError, TypeError, AttributeError):
            raise AppError('Identifiant de requête invalide.', 400)
        async with self.pool.connection() as conn:
            async with conn.transaction():
                await conn.execute('SELECT pg_advisory_xact_lock(%s)', (ENQUEUE_LOCK,))
                await conn.execute('''INSERT INTO requests(visitor_id,request_id,action,payload,received_at)
                    VALUES (%s,%s,%s,%s,%s) ON CONFLICT (visitor_id,request_id) DO NOTHING''',
                    (visitor, request_id, action, Jsonb(payload), now_ms()))
                ticket = await one(conn, 'SELECT * FROM requests WHERE visitor_id=%s AND request_id=%s', (visitor, request_id))
                if ticket['action'] != action or ticket['payload'] != payload:
                    raise AppError('Identifiant déjà utilisé pour une autre action.')
                return ticket['sequence']

    async def drain(self):
        async with self.pool.connection() as conn:
            async with conn.transaction():
                await conn.execute('SELECT pg_advisory_xact_lock(%s)', (MUTATION_LOCK,))
                pending = await rows(conn, "SELECT * FROM requests WHERE status='PENDING' ORDER BY sequence LIMIT 64")
                if not pending:
                    return
                state = await self.load(conn)
                before = copy.deepcopy(state)
                for ticket in pending:
                    candidate = copy.deepcopy(state)
                    visitor = str(ticket['visitor_id'])
                    result, error = None, None
                    try:
                        result = apply(candidate, ticket['action'], ticket['payload'], visitor)
                        if ticket['action'] == 'reserve':
                            candidate['holds'][visitor].update(sequence=ticket['sequence'], receivedAt=ticket['received_at'])
                            result.update(sequence=ticket['sequence'], clientId=visitor)
                        state = candidate
                    except AppError as exc:
                        error = dict(message=str(exc), status=exc.status)
                    state['revision'] += 1
                    await conn.execute('UPDATE requests SET status=%s,result=%s,error=%s WHERE sequence=%s',
                        ('REFUSED' if error else 'ACCEPTED', Jsonb(result), Jsonb(error), ticket['sequence']))
                await self.persist(conn, before, state)

    async def mutate(self, visitor, request_id, action, payload, role='client'):
        sequence = await self.enqueue(visitor, request_id, action, payload)
        await self.drain()
        async with self.pool.connection() as conn:
            async with conn.transaction():
                await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
                ticket = await one(conn, 'SELECT * FROM requests WHERE sequence=%s', (sequence,))
                if ticket['status'] == 'PENDING':
                    return dict(pending=True, sequence=sequence)
                if ticket['error']:
                    raise AppError(ticket['error']['message'], ticket['error']['status'])
                return dict(result=ticket['result'], state=await self.view(conn, await self.load(conn), visitor, role))
