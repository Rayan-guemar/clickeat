import copy
import pytest
from backend.domain import AppError, apply, check_basket, clean, fresh, snapshot

NOW = 1790756000000


def state():
    s = fresh()
    clean(s, NOW)
    return s


def reserve(s, visitor='a', items=None, slot=None):
    return apply(s, 'reserve', {'items': items or {'marg': 1}, 'slot': slot or s['slots'][0]}, visitor, NOW)


def pay(s, visitor='a'):
    return apply(s, 'pay', {'reservationId': s['holds'][visitor]['id'], 'name': 'Client'}, visitor, NOW)


def test_cumulative_bom_stock_and_expiry():
    s = state()
    s['stock']['dough']['qty'] = 1
    assert check_basket(s, {'marg': 1}, s['slots'][0], NOW)['ok']
    assert not check_basket(s, {'marg': 1, 'regina': 1}, s['slots'][0], NOW)['stockOK']
    reserve(s)
    with pytest.raises(AppError, match='Stock insuffisant'):
        reserve(s, 'b')
    clean(s, NOW+300001)
    assert not s['holds']
    reserve(s, 'b')
    assert len(s['holds']) == 1


def test_different_slots_and_grandfathered_hold():
    s = state()
    a, b = s['slots'][:2]
    apply(s, 'slot_capacity', {'slot': a, 'capacity': 0}, 'm', NOW)
    assert check_basket(s, {'marg': 1}, a, NOW)['nextSlot'] == b
    reserve(s, slot=b)
    apply(s, 'slot_capacity', {'slot': b, 'capacity': 0}, 'm', NOW)
    pay(s)
    assert len(s['orders']) == 1
    apply(s, 'slot_capacity', {'slot': a, 'capacity': None}, 'm', NOW)
    assert str(a) not in s['slotCapacities']


def test_catalog_prices_and_bom_frozen_until_pay_and_cancel():
    s = state()
    reserve(s, items={'marg': 2})
    r = copy.deepcopy(s['catalog'][0])
    r.update(name='Modifiée', price=25, bom={'dough': 3}, active=True)
    apply(s, 'catalog', {'version': 0, 'recipe': r}, 'm', NOW)
    with pytest.raises(AppError, match='catalogue a changé'):
        apply(s, 'catalog', {'version': 0, 'recipe': r}, 'm', NOW)
    pay(s)
    o = s['orders'][0]
    assert o['totalCents'] == 2200 and o['lines'][0]['name'] == 'Margherita'
    assert s['stock']['dough']['qty'] == 418
    apply(s, 'cancel', {'id': o['id']}, 'm', NOW)
    assert s['stock']['dough']['qty'] == 420
    r['active'] = False
    apply(s, 'catalog', {'version': 1, 'recipe': r}, 'm', NOW)
    with pytest.raises(AppError):
        reserve(s, 'b')


def test_manual_lifecycle_and_cross_session_privacy():
    s = state()
    reserve(s)
    with pytest.raises(AppError):
        apply(s, 'pay', {'reservationId': s['holds']['a']['id'], 'name': 'B'}, 'b', NOW)
    pay(s)
    o = s['orders'][0]
    o['slot'] = NOW+600000
    for old in ('QUEUED', 'PREPARING', 'BAKING', 'READY'):
        apply(s, 'advance', {'id': o['id'], 'expectedStatus': old}, 'm', NOW)
        with pytest.raises(AppError):
            apply(s, 'advance', {'id': o['id'], 'expectedStatus': old}, 'm', NOW)
    assert o['status'] == 'COLLECTED' and len(s['notifications']) == 1
    assert snapshot(s, 'b', now=NOW)['orders'] == []
    a = snapshot(s, 'a', now=NOW)
    assert 'stock' not in a and 'bom' not in a['catalog'][0]
    assert 'ingredients' not in a['orders'][0] and 'session' not in a['orders'][0]
    assert len(snapshot(s, 'm', 'manager', NOW)['orders']) == 1


@pytest.mark.parametrize('items', [None, [], {}, {'marg': 0}, {'marg': -1}, {'marg': True}, {'marg': 1.5}, {'unknown': 1}, {'marg': 51}])
def test_invalid_baskets(items):
    s = state()
    with pytest.raises(AppError):
        check_basket(s, items, s['slots'][0], NOW)


def test_pause_and_stock_revision():
    s = state()
    apply(s, 'pause', {'minutes': 15}, 'm', NOW)
    with pytest.raises(AppError):
        reserve(s)
    apply(s, 'pause', {'minutes': 0}, 'm', NOW)
    reserve(s)
    apply(s, 'stock', {'id': 'dough', 'qty': 0}, 'm', NOW)
    with pytest.raises(AppError):
        pay(s)
    assert not s['orders']
