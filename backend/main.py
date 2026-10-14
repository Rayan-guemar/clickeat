"""HTTP API compatible with the existing client and pizzeria screens."""
import asyncio
import base64
import binascii
import hashlib
import hmac
import json
import logging
import os
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from uuid import UUID, uuid4
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from psycopg import OperationalError
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool, PoolTimeout
from .domain import AppError
from .repository import Repository

log = logging.getLogger('click-eat')
STATIC = Path(__file__).resolve().parent.parent / 'dist'
ASSETS = {'app.js', 'server-client.js', 'style.css', 'sw.js', 'pizza.jpg'}
CLIENT_ACTIONS = {'reserve', 'release', 'pay'}
MANAGER_ACTIONS = {'advance', 'delay', 'cancel', 'stock', 'capacity', 'pause', 'catalog', 'slot_capacity'}


def authenticate(header, password):
    if not password or not header.startswith('Basic '):
        return False
    try:
        value = base64.b64decode(header[6:], validate=True)
    except (ValueError, binascii.Error):
        return False
    return hmac.compare_digest(hashlib.sha256(value).digest(), hashlib.sha256(('admin:'+password).encode()).digest())


def create_app(repository=None, password=None, public_origin=None):
    # Injectable repository only for tests; production always opens PostgreSQL.
    password = password if password is not None else os.getenv('PILOTAGE_PASSWORD', '')
    public_origin = public_origin if public_origin is not None else os.getenv('PUBLIC_ORIGIN', '')
    public_origin = public_origin.rstrip('/')
    if public_origin:
        parts = urlsplit(public_origin)
        if parts.scheme not in ('http', 'https') or not parts.netloc or parts.path or parts.query or parts.fragment or parts.username:
            raise ValueError('PUBLIC_ORIGIN doit être une origine HTTP(S), sans chemin.')

    @asynccontextmanager
    async def lifespan(app):
        if len(password) < 16:
            raise RuntimeError('PILOTAGE_PASSWORD doit contenir au moins 16 caractères.')
        pool, worker = None, None
        if repository is None:
            conninfo = os.getenv('DATABASE_URL') or make_conninfo(
                host=os.getenv('PGHOST', 'db'), port=os.getenv('PGPORT', '5432'),
                dbname=os.getenv('PGDATABASE', 'clickeat'), user=os.getenv('PGUSER', 'clickeat'),
                password=os.getenv('PGPASSWORD', ''), connect_timeout=5)
            pool = AsyncConnectionPool(conninfo, min_size=1, max_size=10, max_waiting=100,
                                       timeout=10, open=False, kwargs={'row_factory': dict_row, 'autocommit': True})
            await pool.open()
            try:
                await pool.wait(timeout=30)
                app.state.repo = Repository(pool)
                await app.state.repo.init()
            except Exception:
                await pool.close()
                raise
            async def recover_queue():
                while True:
                    try:
                        await app.state.repo.drain()
                    except Exception:
                        log.exception('Traitement de la file interrompu ; nouvelle tentative prévue.')
                    await asyncio.sleep(1)
            worker = asyncio.create_task(recover_queue())
        else:
            app.state.repo = repository
        try:
            yield
        finally:
            if worker:
                worker.cancel()
                with suppress(asyncio.CancelledError):
                    await worker
            if pool:
                await pool.close()

    app = FastAPI(title='Click Eat API', lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware('http')
    async def security(request, call_next):
        path = request.url.path
        is_manager = path in ('/pilotage', '/pilotage/') or path.startswith('/api/pilotage/')
        if is_manager and not authenticate(request.headers.get('authorization', ''), password):
            return JSONResponse({'error': 'Authentification propriétaire requise.'}, status_code=401,
                headers={'WWW-Authenticate': 'Basic realm="Click Eat Pilotage", charset="UTF-8"', 'Cache-Control': 'no-store'})
        cookie = request.cookies.get('ce_session', '')
        try:
            cookie = str(UUID(cookie))
        except (ValueError, TypeError):
            cookie = str(uuid4())
        request.state.cookie = cookie
        try:
            response = await call_next(request)
        except (OperationalError, PoolTimeout):
            response = JSONResponse({'error': 'Base temporairement indisponible. Réessayez.'}, status_code=503)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Cache-Control'] = 'no-store' if path.startswith('/api/') or is_manager else 'no-cache'
        response.headers['Vary'] = 'Cookie, Authorization'
        if request.cookies.get('ce_session') != cookie:
            response.set_cookie('ce_session', cookie, max_age=31536000, httponly=True, samesite='strict',
                                secure=(public_origin or str(request.base_url)).startswith('https://'))
        return response

    @app.exception_handler(AppError)
    async def app_error(request, exc):
        return JSONResponse({'error': str(exc)}, status_code=exc.status)

    @app.get('/api/health')
    async def health():
        repo = app.state.repo
        if hasattr(repo, 'pool'):
            async with repo.pool.connection() as conn:
                await conn.execute('SELECT 1')
        return {'ok': True, 'database': 'postgresql'}

    @app.get('/api/state')
    @app.get('/api/pilotage/state')
    async def state(request: Request):
        role = 'manager' if request.url.path.startswith('/api/pilotage/') else 'client'
        visitor = await app.state.repo.visitor(request.state.cookie)
        return await app.state.repo.get(visitor, role)

    @app.post('/api/action')
    @app.post('/api/pilotage/action')
    @app.post('/api/check')
    async def action(request: Request):
        origin = public_origin or str(request.base_url).rstrip('/')
        if request.headers.get('origin') != origin or request.headers.get('x-click-eat') != '1':
            raise AppError('Origine non autorisée.', 403)
        if request.headers.get('content-type', '').split(';')[0].strip() != 'application/json':
            raise AppError('JSON requis.', 415)
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 16384:
                raise AppError('Requête trop volumineuse.', 413)
        def reject_constant(value):
            raise ValueError('Non finite JSON')
        try:
            body = json.loads(raw, parse_constant=reject_constant)
        except (ValueError, UnicodeError):
            raise AppError('JSON invalide.', 400)
        if not isinstance(body, dict) or not isinstance(body.get('payload'), dict):
            raise AppError('Requête invalide.', 400)
        repo = app.state.repo
        if request.url.path == '/api/check':
            return await repo.check(body['payload'].get('items'), body['payload'].get('slot'))
        role = 'manager' if request.url.path.startswith('/api/pilotage/') else 'client'
        if not isinstance(body.get('action'), str) or body['action'] not in (MANAGER_ACTIONS if role == 'manager' else CLIENT_ACTIONS):
            raise AppError('Action non autorisée pour cet espace.', 403)
        visitor = await repo.visitor(request.state.cookie)
        result = await repo.mutate(visitor, body.get('requestId'), body['action'], body['payload'], role)
        return JSONResponse(result, status_code=202 if result.get('pending') else 200)

    @app.get('/index.html')
    @app.get('/')
    @app.get('/client')
    @app.get('/client/')
    @app.get('/pilotage')
    @app.get('/pilotage/')
    async def index():
        return FileResponse(STATIC / 'index.html')

    @app.get('/{asset}')
    async def asset(asset: str):
        if asset not in ASSETS:
            return PlainTextResponse('Not found', status_code=404)
        return FileResponse(STATIC / asset)

    return app
