"""Integration suite: TEST_DATABASE_URL is required; uses a new disposable schema."""
import asyncio
import os
from uuid import uuid4
import pytest
import pytest_asyncio
from psycopg import AsyncConnection, sql
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from backend.repository import Repository, one
from backend.domain import AppError

pytestmark = pytest.mark.postgres


@pytest_asyncio.fixture
async def repo():
    dsn = os.getenv('TEST_DATABASE_URL')
    if not dsn:
        pytest.skip('Set TEST_DATABASE_URL to run real PostgreSQL integration tests')
    schema = 'test_'+uuid4().hex
    admin = await AsyncConnection.connect(dsn, autocommit=True)
    await admin.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
    pool = AsyncConnectionPool(dsn, open=False, min_size=1, max_size=12,
        kwargs={'autocommit': True, 'row_factory': dict_row, 'options': '-c search_path='+schema})
    await pool.open()
    await pool.wait()
    repository = Repository(pool)
    try:
        await repository.init()
        yield repository
    finally:
        await pool.close()
        await admin.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))
        await admin.close()


async def user(repo):
    return await repo.visitor(str(uuid4()))


async def change(repo, visitor, action, payload, key=None):
    return await repo.mutate(visitor, key or str(uuid4()), action, payload, 'manager')


async def test_thirty_concurrent_clients_fifo_and_stock(repo):
    manager = await user(repo)
    await change(repo, manager, 'stock', {'id': 'burrata', 'qty': 3})
    clients = [await user(repo) for _ in range(30)]
    slot = (await repo.get(manager))['slots'][0]
    payload = {'items': {'burrata': 1}, 'slot': slot}
    async def reserve(client):
        try:
            return await repo.mutate(client, str(uuid4()), 'reserve', payload)
        except AppError as error:
            return error
    results = await asyncio.gather(*(reserve(c) for c in clients))
    accepted = sorted(r['result']['sequence'] for r in results if isinstance(r, dict))
    assert len(accepted) == 3
    view = await repo.get(manager, 'manager')
    earliest = sorted(t['sequence'] for t in view['reservationQueue'])[:3]
    assert accepted == earliest
    assert sum(isinstance(r, AppError) for r in results) == 27
    assert view['stock']['burrata']['qty'] == 3  # reservation isn't payment


async def test_pending_ticket_recovery_idempotency_and_no_double_payment(repo):
    visitor = await user(repo)
    view = await repo.get(visitor)
    key = str(uuid4())
    payload = {'items': {'marg': 2}, 'slot': view['slots'][0]}
    seq = await repo.enqueue(visitor, key, 'reserve', payload)
    new_process = Repository(repo.pool)
    await new_process.init()  # migration and seed are repeatable
    await new_process.drain()  # simulate recovery after API restart
    held = await new_process.mutate(visitor, key, 'reserve', payload)
    assert held['result']['sequence'] == seq
    pay_key = str(uuid4())
    data = {'reservationId': held['state']['hold']['id'], 'name': 'A'}
    paid = await asyncio.gather(*(new_process.mutate(visitor, pay_key, 'pay', data) for _ in range(5)))
    assert len({r['result']['orderId'] for r in paid}) == 1
    final = await repo.get(visitor, 'manager')
    assert len(final['orders']) == 1 and final['stock']['dough']['qty'] == 418
    with pytest.raises(AppError):
        await repo.mutate(visitor, pay_key, 'pay', {**data, 'name': 'B'})


async def test_catalog_quota_expiry_and_atomic_rollback(repo):
    visitor, manager = await user(repo), await user(repo)
    s = await repo.get(visitor, 'manager')
    a, b = s['slots'][:2]
    await change(repo, manager, 'slot_capacity', {'slot': a, 'capacity': 0})
    assert (await repo.check({'marg': 1}, a))['nextSlot'] == b
    reserve = await change(repo, visitor, 'reserve', {'items': {'marg': 1}, 'slot': b})
    recipe = {**s['catalog'][0], 'price': 30, 'bom': {'dough': 3}, 'active': True}
    await change(repo, manager, 'catalog', {'version': 0, 'recipe': recipe})
    paid = await change(repo, visitor, 'pay', {'reservationId': reserve['state']['hold']['id'], 'name': 'A'})
    assert paid['state']['orders'][0]['totalCents'] == 1100
    assert paid['state']['stock']['dough']['qty'] == 419
    await change(repo, manager, 'cancel', {'id': paid['result']['orderId']})
    assert (await repo.get(manager, 'manager'))['stock']['dough']['qty'] == 420
    with pytest.raises(AppError):
        await change(repo, manager, 'catalog', {'version': 1, 'recipe': {**recipe, 'bom': {'missing': 1}}})
    assert (await repo.get(manager, 'manager'))['catalogVersion'] == 1
    await change(repo, visitor, 'reserve', {'items': {'marg': 1}, 'slot': b})
    async with repo.pool.connection() as conn:
        await conn.execute("UPDATE reservations SET expires=0,data=jsonb_set(data,'{expires}','0') WHERE visitor_id=%s", (visitor,))
    assert (await repo.get(visitor))['hold'] is None
    # Expired hold is cleaned and replaced transactionally.
    await change(repo, visitor, 'reserve', {'items': {'marg': 1}, 'slot': b})
    assert (await repo.get(visitor))['hold'] is not None


async def test_client_isolation_and_catalog_conflict(repo):
    a, b = await user(repo), await user(repo)
    s = await repo.get(a, 'manager')
    r = {**s['catalog'][0], 'active': True, 'price': 15}
    results = await asyncio.gather(*(change(repo, v, 'catalog', {'version': 0, 'recipe': r}) for v in (a, b)), return_exceptions=True)
    assert sum(isinstance(r, AppError) for r in results) == 1
    held = await repo.mutate(a, str(uuid4()), 'reserve', {'items': {'marg': 1}, 'slot': s['slots'][0]})
    with pytest.raises(AppError):
        await repo.mutate(b, str(uuid4()), 'pay', {'reservationId': held['result']['reservationId'], 'name': 'B'})
    other = await repo.get(b)
    assert other['hold'] is None and other['orders'] == [] and 'stock' not in other


async def test_concurrent_capacity_and_failed_transaction_recovery(repo, monkeypatch):
    manager = await user(repo)
    await change(repo, manager, 'capacity', {'capacity': 2})
    clients = [await user(repo) for _ in range(12)]
    slot = (await repo.get(manager))['slots'][0]
    results = await asyncio.gather(*(repo.mutate(c, str(uuid4()), 'reserve', {'items': {'marg': 1}, 'slot': slot}) for c in clients), return_exceptions=True)
    assert sum(isinstance(r, dict) for r in results) == 2
    assert (await repo.get(manager, 'manager'))['slotLoads'][str(slot)] == 2
    before = await repo.get(manager, 'manager')
    persist = repo.persist
    async def fail_after_writes(conn, old, new):
        await persist(conn, old, new)
        raise RuntimeError('Simulated interrupted transaction')
    monkeypatch.setattr(repo, 'persist', fail_after_writes)
    request_id = str(uuid4())
    with pytest.raises(RuntimeError):
        await change(repo, manager, 'stock', {'id': 'dough', 'qty': 111}, request_id)
    after = await repo.get(manager, 'manager')
    assert after['revision'] == before['revision']
    assert after['stock']['dough']['qty'] == before['stock']['dough']['qty']
    monkeypatch.setattr(repo, 'persist', persist)
    await repo.drain()
    assert (await repo.get(manager, 'manager'))['stock']['dough']['qty'] == 111
    replay = await change(repo, manager, 'stock', {'id': 'dough', 'qty': 111}, request_id)
    assert replay['state']['stock']['dough']['qty'] == 111


async def test_fastapi_http_with_real_postgres(repo):
    import httpx
    from backend.main import create_app
    password = 'integration-only-secret-1234'
    app = create_app(repo, password)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://testserver') as client:
            assert (await client.get('/api/health')).json()['database'] == 'postgresql'
            assert (await client.get('/api/pilotage/state')).status_code == 401
            s = (await client.get('/api/state')).json()
            headers = {'Origin': 'http://testserver', 'X-Click-Eat': '1'}
            key = str(uuid4())
            request = {'action': 'reserve', 'requestId': key, 'payload': {'items': {'regina': 1}, 'slot': s['slots'][0]}}
            reserved = await client.post('/api/action', json=request, headers=headers)
            assert reserved.status_code == 200
            assert (await client.post('/api/action', json=request, headers=headers)).json()['result'] == reserved.json()['result']
            pay = await client.post('/api/action', json={'action': 'pay', 'requestId': str(uuid4()), 'payload': {'reservationId': reserved.json()['result']['reservationId'], 'name': 'Client'}}, headers=headers)
            assert pay.status_code == 200
            manager = (await client.get('/api/pilotage/state', auth=('admin', password))).json()
            assert manager['orders'][0]['totalCents'] == 1400
            assert manager['stock']['dough']['qty'] == 419


async def test_production_lifespan_restart_and_queue_worker(repo, monkeypatch):
    import httpx
    from backend.main import create_app
    from psycopg.conninfo import make_conninfo
    async with repo.pool.connection() as conn:
        schema = (await one(conn, 'SELECT current_schema() AS name'))['name']
    monkeypatch.setenv('DATABASE_URL', make_conninfo(repo.pool.conninfo, options='-c search_path='+schema))
    monkeypatch.setenv('PILOTAGE_PASSWORD', 'restart-test-password-1234')
    visitor = await user(repo)
    view = await repo.get(visitor)
    await repo.enqueue(visitor, str(uuid4()), 'reserve', {'items': {'marg': 1}, 'slot': view['slots'][0]})
    for _ in range(2):
        app = create_app()
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://testserver') as client:
                assert (await client.get('/api/health')).status_code == 200
                for attempt in range(30):
                    if (await repo.get(visitor))['hold']:
                        break
                    await asyncio.sleep(.1)
                else:
                    pytest.fail('Background worker failed to recover pending ticket')
                assert (await repo.get(visitor))['hold']['items'] == {'marg': 1}
