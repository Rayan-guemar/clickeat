import copy
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from backend.main import create_app
from backend.domain import fresh, snapshot, check_basket, apply

PASSWORD = 'test-only-password-123456'


class MemoryRepository:
    """HTTP contract tests only; SQL/concurrency tests use real PostgreSQL separately."""
    def __init__(self):
        self.s = fresh()
        self.identities = {}
    async def visitor(self, cookie):
        return self.identities.setdefault(cookie, str(uuid4()))
    async def get(self, visitor, role):
        return {**snapshot(copy.deepcopy(self.s), visitor, role), 'reservationQueue': []}
    async def check(self, items, slot):
        return check_basket(copy.deepcopy(self.s), items, slot)
    async def mutate(self, visitor, key, action, payload, role):
        result = apply(self.s, action, payload, visitor)
        self.s['revision'] += 1
        return {'result': result, 'state': await self.get(visitor, role)}


@pytest.fixture
def client():
    with TestClient(create_app(MemoryRepository(), PASSWORD)) as client:
        yield client


def test_routes_auth_cookie_and_no_source_exposure(client):
    assert client.get('/').status_code == 200
    assert client.get('/index.html').status_code == 200
    assert client.get('/sw.js').status_code == 200
    assert client.get('/pilotage').status_code == 401
    assert client.get('/pilotage', auth=('admin', PASSWORD)).status_code == 200
    assert client.get('/api/pilotage/state', auth=('admin', 'bad')).status_code == 401
    assert client.get('/api/pilotage/state', headers={'oai-authenticated-user-id': 'owner', 'oai-authenticated-user-email': 'owner@test'}).status_code == 401
    assert client.get('/api/pilotage/state', auth=('admin', PASSWORD)).json()['role'] == 'manager'
    a = client.get('/api/state').json()
    assert 'stock' not in a
    assert client.get('/api/state').json()['clientId'] == a['clientId']
    for path in ('/.env', '/server/index.js', '/backend/seed.json', '/data/click-eat.sqlite'):
        assert client.get(path).status_code == 404
    cookie = client.get('/api/state', headers={'cookie': 'ce_session=bad'}).headers['set-cookie']
    assert 'HttpOnly' in cookie and 'SameSite=strict' in cookie


def test_basket_and_complete_checkout_contract(client):
    s = client.get('/api/state').json()
    headers = {'Origin': 'http://testserver', 'X-Click-Eat': '1'}
    payload = {'items': {'marg': 1, 'regina': 1}, 'slot': s['slots'][0]}
    r = client.post('/api/check', json={'payload': payload}, headers=headers)
    assert r.status_code == 200 and r.json()['totalCents'] == 2500
    r = client.post('/api/action', json={'action': 'reserve', 'requestId': str(uuid4()), 'payload': payload}, headers=headers)
    assert r.status_code == 200
    hold = r.json()['state']['hold']
    r = client.post('/api/action', json={'action': 'pay', 'requestId': str(uuid4()), 'payload': {'name': 'Client', 'reservationId': hold['id']}}, headers=headers)
    assert r.status_code == 200 and len(r.json()['state']['orders']) == 1


def test_http_validation(client):
    headers = {'Origin': 'http://testserver', 'X-Click-Eat': '1'}
    assert client.post('/api/action', json={}).status_code == 403
    assert client.post('/api/action', json={'payload': {}, 'action': 'stock'}, headers=headers).status_code == 403
    assert client.post('/api/check', content='{', headers={**headers, 'Content-Type': 'application/json'}).status_code == 400
    assert client.post('/api/check', content='{}', headers=headers).status_code == 415
    assert client.post('/api/check', content='x'*17000, headers={**headers, 'Content-Type': 'application/json'}).status_code == 413
    assert client.post('/api/check', content='{"payload":{"items":{"marg":NaN}}}', headers={**headers, 'Content-Type': 'application/json'}).status_code == 400


def test_password_required():
    with pytest.raises(RuntimeError, match='16 caractères'):
        with TestClient(create_app(MemoryRepository(), 'short')):
            pass
