"""Business rules, independent of HTTP and persistence. Times are epoch milliseconds."""
import copy
import json
import math
import re
import time
from decimal import Decimal, InvalidOperation
from pathlib import Path
from uuid import uuid4


class AppError(Exception):
    def __init__(self, message, status=409):
        super().__init__(message)
        self.status = status


def now_ms():
    return time.time_ns() // 1_000_000


def fresh():
    seed = json.loads(Path(__file__).with_name('seed.json').read_text())
    return dict(**seed, capacity=50, catalogVersion=0, pausedUntil=0, slotCapacities={},
                orders=[], holds={}, notifications=[], next=1001, revision=0)


def clean(s, now):
    s['holds'] = {k: h for k, h in s['holds'].items() if h['expires'] > now}
    s['slotCapacities'] = {k: v for k, v in s['slotCapacities'].items() if int(k) >= now - 86400000}
    base = ((now + 720000 + 599999) // 600000) * 600000
    s['slots'] = [base + i * 600000 for i in range(8)]


def integer(n, lo, hi, message):
    if type(n) is not int or not lo <= n <= hi:
        raise AppError(message, 400)
    return n


def validate_items(s, items):
    if not isinstance(items, dict) or not items:
        raise AppError('Le panier est vide.', 400)
    ids = {r['id'] for r in s['catalog'] if r.get('active', True)}
    for key, n in items.items():
        if key not in ids:
            raise AppError('Recette inconnue ou masquée.', 400)
        integer(n, 1, 50, 'Quantité invalide.')
    if sum(items.values()) > 50:
        raise AppError('Maximum 50 pizzas par commande.', 400)
    return items


def required(s, items):
    out = {}
    for r in s['catalog']:
        for key, n in r['bom'].items():
            if items.get(r['id'], 0):
                out[key] = out.get(key, 0) + n * items[r['id']]
    return out


def frozen(s, items):
    lines = [dict(id=r['id'], name=r['name'], qty=items[r['id']], price=r['price'])
             for r in s['catalog'] if items.get(r['id'])]
    return dict(lines=lines, totalCents=sum(int(Decimal(str(r['price'])) * 100) * r['qty'] for r in lines),
                ingredients=required(s, items))


def available(s, items, skip=None, ingredients=None):
    need = dict(ingredients if ingredients is not None else required(s, items))
    for visitor, hold in s['holds'].items():
        if visitor != skip:
            for key, n in hold['ingredients'].items():
                need[key] = need.get(key, 0) + n
    return all(s['stock'][k]['qty'] >= n for k, n in need.items())


def capacity(s, slot):
    return s['slotCapacities'].get(str(slot), s['capacity'])


def used(s, slot):
    return sum(sum(o['items'].values()) for o in s['orders'] if o['slot'] == slot and o['status'] != 'CANCELLED') + sum(
        sum(h['items'].values()) for h in s['holds'].values() if h['slot'] == slot)


def check_basket(s, items, slot, now=None):
    now = now if now is not None else now_ms()
    clean(s, now)
    validate_items(s, items)
    integer(slot, 0, 2**53-1, 'Créneau invalide.')
    stock_ok, opened = available(s, items), s['pausedUntil'] <= now
    slots = [dict(slot=t, capacity=capacity(s, t), used=used(s, t)) for t in s['slots']]
    feasible = [t['slot'] for t in slots if t['used'] + sum(items.values()) <= t['capacity']]
    slot_ok = slot in feasible
    nxt = next((t for t in feasible if t >= slot), feasible[0] if feasible else None)
    message = ('La prise de commandes est suspendue.' if not opened else
               'Stock insuffisant pour le panier cumulé : plusieurs recettes utilisent les mêmes ingrédients.' if not stock_ok else
               'Créneau complet ou expiré.' if not slot_ok else
               'Panier cumulé disponible. Validation définitive lors de la réservation.')
    return dict(ok=stock_ok and opened and slot_ok, stockOK=stock_ok, slotOK=slot_ok,
                nextSlot=nxt if stock_ok and opened else None, slots=slots,
                totalCents=frozen(s, items)['totalCents'], message=message, revision=s['revision'])


def snapshot(s, visitor, role='client', now=None):
    now = now if now is not None else now_ms()
    clean(s, now)
    other = [h for k, h in s['holds'].items() if k != visitor]
    reserved, all_reserved = {}, {}
    for key, h in s['holds'].items():
        for ingredient, n in h['ingredients'].items():
            all_reserved[ingredient] = all_reserved.get(ingredient, 0) + n
            if key != visitor:
                reserved[ingredient] = reserved.get(ingredient, 0) + n
    orders = []
    for o in s['orders']:
        if role == 'manager' or o['session'] == visitor:
            orders.append({**{k: v for k, v in o.items() if k not in ('session', 'ingredients')},
                           'client': o['session'] == visitor, 'clientId': o['session']})
    menu = [{k: v for k, v in r.items() if role == 'manager' or k != 'bom'} for r in s['catalog']]
    availability = {r['id']: max(0, min((s['stock'][k]['qty'] - all_reserved.get(k, 0)) // n
                                      for k, n in r['bom'].items())) if r.get('active', True) else 0 for r in s['catalog']}
    hold = s['holds'].get(visitor)
    result = dict(revision=s['revision'], serverTime=now, role=role, clientId=visitor,
                  catalog=menu, catalogVersion=s['catalogVersion'], capacity=s['capacity'],
                  pausedUntil=s['pausedUntil'], slotCapacities=s['slotCapacities'], orders=orders,
                  availability=availability, hold={k: v for k, v in hold.items() if k != 'ingredients'} if hold else None,
                  slots=s['slots'], slotLoads={str(t): used(s, t) for t in s['slots']},
                  slotHolds={str(t): sum(sum(h['items'].values()) for h in other if h['slot'] == t) for t in s['slots']})
    if role == 'manager':
        result.update(stock=s['stock'], reservedOther=reserved, notifications=s['notifications'])
    return result


def apply(s, action, p, visitor, now=None):
    now = now if now is not None else now_ms()
    clean(s, now)
    if action == 'reserve':
        if s['pausedUntil'] > now:
            raise AppError('La prise de commandes est suspendue.')
        items = validate_items(s, p.get('items'))
        if visitor in s['holds']:
            raise AppError('Vous avez déjà un panier réservé. Reprenez ou annulez le paiement.')
        slot = integer(p.get('slot'), 0, 2**53-1, 'Créneau invalide.')
        if slot not in s['slots']:
            raise AppError('Ce créneau est expiré ou indisponible.')
        if not available(s, items):
            raise AppError('Stock insuffisant. Modifiez votre panier.')
        if used(s, slot) + sum(items.values()) > capacity(s, slot):
            raise AppError('Ce créneau est complet. Choisissez le suivant.')
        h = dict(id=str(uuid4()), items=copy.deepcopy(items), **frozen(s, items), slot=slot,
                 expires=now+300000, clientId=visitor)
        s['holds'][visitor] = h
        return dict(reservationId=h['id'])
    if action == 'release':
        h = s['holds'].get(visitor)
        if h and h['id'] != p.get('reservationId'):
            raise AppError('La réservation a changé.')
        s['holds'].pop(visitor, None)
        return {}
    if action == 'pay':
        h = s['holds'].get(visitor)
        if not h or h['id'] != p.get('reservationId'):
            raise AppError('La réservation a expiré.')
        name = p.get('name')
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60:
            raise AppError('Indiquez un prénom de 1 à 60 caractères.', 400)
        if not available(s, h['items'], visitor, h['ingredients']):
            raise AppError('Un ingrédient est passé en rupture. Annulez la réservation.')
        for key, n in h['ingredients'].items():
            s['stock'][key]['qty'] -= n
        order_id = s['next']
        s['next'] += 1
        s['orders'].append(dict(id=order_id, name=name.strip(), items=h['items'], lines=h['lines'],
                               totalCents=h['totalCents'], ingredients=h['ingredients'], slot=h['slot'],
                               status='QUEUED', session=visitor, clientId=visitor, sequence=h.get('sequence'),
                               receivedAt=h.get('receivedAt', now), createdAt=now))
        del s['holds'][visitor]
        return dict(orderId=order_id)
    if action in ('advance', 'delay', 'cancel'):
        order_id = integer(p.get('id'), 1, 2**53-1, 'Identifiant commande invalide.')
        o = next((o for o in s['orders'] if o['id'] == order_id), None)
        if not o:
            raise AppError('Commande introuvable.', 404)
        if o['status'] in ('CANCELLED', 'COLLECTED'):
            raise AppError('La commande est terminée.')
        if action == 'advance':
            if o['status'] != p.get('expectedStatus'):
                raise AppError('Cette commande a déjà été modifiée.')
            if o['status'] == 'QUEUED' and o['slot'] + o.get('delay', 0) - 720000 > now:
                raise AppError('Il est trop tôt pour commencer cette commande.')
            o['status'] = dict(QUEUED='PREPARING', PREPARING='BAKING', BAKING='READY', READY='COLLECTED')[o['status']]
            if o['status'] == 'BAKING':
                o['bakedAt'] = now
            if o['status'] == 'READY':
                s['notifications'].append(dict(at=now, text=f'Commande #{order_id} : votre commande est prête au comptoir !'))
            return dict(status=o['status'])
        if action == 'delay':
            o['delay'] = o.get('delay', 0) + 300000
            text = f'Commande #{order_id} : retrait décalé de 5 minutes.'
        else:
            if o['status'] == 'QUEUED':
                for key, n in o['ingredients'].items():
                    s['stock'][key]['qty'] += n
            o['status'] = 'CANCELLED'
            text = f'Commande #{order_id} annulée. Remboursement simulé.'
        s['notifications'].append(dict(at=now, text=text))
        return {}
    if action == 'stock':
        if not isinstance(p.get('id'), str) or p['id'] not in s['stock']:
            raise AppError('Ingrédient inconnu.', 400)
        s['stock'][p['id']]['qty'] = integer(p.get('qty'), 0, 10000000, 'Quantité de stock invalide.')
    elif action == 'capacity':
        s['capacity'] = integer(p.get('capacity'), 1, 200, 'Capacité entre 1 et 200 pizzas.')
    elif action == 'slot_capacity':
        slot = integer(p.get('slot'), 0, 2**53-1, 'Créneau invalide.')
        if slot not in s['slots']:
            raise AppError('Créneau expiré.', 400)
        if p.get('capacity') is None:
            s['slotCapacities'].pop(str(slot), None)
        else:
            s['slotCapacities'][str(slot)] = integer(p['capacity'], 0, 200, 'Capacité entre 0 et 200.')
    elif action == 'pause':
        minutes = integer(p.get('minutes'), 0, 60, 'Durée de pause invalide.')
        if minutes not in (0, 15, 30, 60):
            raise AppError('Durée de pause invalide.', 400)
        s['pausedUntil'] = now + minutes * 60000 if minutes else 0
    elif action == 'catalog':
        if type(p.get('version')) is not int or p['version'] != s['catalogVersion']:
            raise AppError('Le catalogue a changé. Rechargez avant de modifier.')
        r = p.get('recipe')
        if not isinstance(r, dict) or not isinstance(r.get('id'), str) or not re.fullmatch(r'[a-z][a-z0-9_-]{1,39}', r['id']) or r['id'] in ('constructor', 'prototype', '__proto__'):
            raise AppError('Identifiant recette invalide.', 400)
        for key, maximum in (('name', 80), ('desc', 400), ('tag', 80)):
            if not isinstance(r.get(key), str) or len(r[key]) > maximum or (key == 'name' and not r[key].strip()):
                raise AppError('Texte recette invalide.', 400)
        try:
            cents = Decimal(str(r.get('price'))) * 100
            if type(r.get('price')) not in (float, int) or not cents.is_finite() or cents != cents.to_integral_value() or not 1 <= cents <= 100000:
                raise ValueError()
        except (InvalidOperation, ValueError):
            raise AppError('Prix invalide.', 400)
        if not isinstance(r.get('bom'), dict) or not r['bom']:
            raise AppError('Ajoutez au moins un ingrédient.', 400)
        for key, n in r['bom'].items():
            if key not in s['stock']:
                raise AppError('Ingrédient inconnu.', 400)
            integer(n, 1, 100000, 'Quantité recette invalide.')
        if type(r.get('active')) is not bool:
            raise AppError('Statut recette invalide.', 400)
        value = dict(id=r['id'], name=r['name'].strip(), desc=r['desc'], tag=r['tag'], price=float(cents/100), bom=dict(r['bom']), active=r['active'])
        index = next((i for i, old in enumerate(s['catalog']) if old['id'] == r['id']), None)
        if index is None:
            if len(s['catalog']) >= 100:
                raise AppError('Maximum 100 recettes.', 400)
            s['catalog'].append(value)
        else:
            s['catalog'][index] = value
        s['catalogVersion'] += 1
    else:
        raise AppError('Action inconnue.', 400)
    return {}
