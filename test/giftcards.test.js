'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTestApp, login, ticketTypeId, ADMIN_EMAIL, ADMIN_PASSWORD, checkoutSessionCompleted } = require('./helpers');

async function cookieFor(app, email, password) {
  const res = await login(app, email, password);
  return res.headers['set-cookie'][0].split(';')[0];
}

const CUSTOMER = ['customer@ticketvault.test', 'password123'];

async function adminCreateCard(app, valueCents, count = 1) {
  const admin = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
  const res = await app.app.post('/api/admin/gift-cards')
    .set('Cookie', admin)
    .send({ valueCents, count });
  return { admin, res };
}

async function makeOrder(app, cookie, eventId = 70103, quantity = 1) {
  const tt = await ticketTypeId(app, eventId);
  const res = await app.app.post('/api/orders').set('Cookie', cookie)
    .send({ eventId, items: [{ ticketTypeId: tt, quantity }] });
  assert.equal(res.status, 200);
  return res.body.orderNumber;
}

function cardRow(app, code) {
  const norm = String(code).trim().toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '');
  const out = app.db.prepare(
    'SELECT id FROM gift_cards WHERE code_hash = ?').get(require('node:crypto').createHash('sha256').update(norm).digest('hex')
  );
  return app.db.prepare('SELECT * FROM gift_cards WHERE id = ?').get(out.id);
}

function ttRow(app, id) {
  return app.db.prepare('SELECT reserved_quantity, sold_quantity FROM ticket_types WHERE id = ?').get(id);
}

test('admin creates gift cards; the full code is only ever returned once; list is masked', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const { admin, res } = await adminCreateCard(app, 50000, 2);
  assert.equal(res.status, 201);
  assert.equal(res.body.codes.length, 2);
  assert.match(res.body.codes[0], /^GC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const list = await app.app.get('/api/admin/gift-cards').set('Cookie', admin);
  assert.equal(list.status, 200);
  assert.equal(list.body.giftCards.length, 2);
  for (const gc of list.body.giftCards) {
    assert.match(gc.code_masked, /^GC-····-····-····-[A-Z2-9]{4}$/);
    assert.ok(!('code_hash' in gc));
  }
});

test('validate endpoint reports available balance', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app, ...CUSTOMER);
  const { res } = await adminCreateCard(app, 4321);
  const code = res.body.codes[0];

  const ok = await app.app.get('/api/gift-cards/validate?code=' + encodeURIComponent(code)).set('Cookie', customer);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.availableCents, 4321);
  assert.match(ok.body.maskedCode, /GC-····-····-····-....$/);

  const bad = await app.app.get('/api/gift-cards/validate?code=GC-0000-0000-0000-0000').set('Cookie', customer);
  assert.equal(bad.status, 404);
  assert.equal(bad.body.code, 'GIFT_CARD_NOT_FOUND');

  const garbage = await app.app.get('/api/gift-cards/validate?code=abc').set('Cookie', customer);
  assert.equal(garbage.status, 400);
});

test('checkout applies a gift card hold and records a hold redemption', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app, ...CUSTOMER);
  const { res } = await adminCreateCard(app, 12345);
  const code = res.body.codes[0];

  const tt = await ticketTypeId(app, 70103);
  const buy = await app.app.post('/api/orders/gift-card').set('Cookie', customer)
    .send({ eventId: 70103, items: [{ ticketTypeId: tt, quantity: 1 }], code });
  assert.equal(buy.status, 200);
  assert.ok(buy.body.orderNumber);
  assert.equal(buy.body.remainingCents, buy.body.totalCents - buy.body.appliedCents);
  assert.ok(buy.body.giftCardCovered === (buy.body.remainingCents <= 0));

  const order = app.db.prepare('SELECT * FROM orders WHERE order_number = ?').get(buy.body.orderNumber);
  assert.equal(order.status, 'pending');
  assert.equal(order.gift_card_cents, Math.min(12345, order.total_cents));
  assert.equal(order.payment_method, 'gift_card');

  const holds = app.db.prepare("SELECT amount_cents, kind FROM gift_card_redemptions WHERE order_id = ?").all(order.id);
  assert.equal(holds.length, 1);
  assert.equal(holds[0].kind, 'hold');

  // Inventory is still reserved but not sold.
  assert.equal(ttRow(app, tt).reserved_quantity, 1);
  assert.equal(ttRow(app, tt).sold_quantity, 0);
});

test('applying the same gift card twice is idempotent (no double hold)', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app, ...CUSTOMER);
  const { res } = await adminCreateCard(app, 99999);
  const code = res.body.codes[0];
  const tt = await ticketTypeId(app, 70103);
  const payload = { eventId: 70103, items: [{ ticketTypeId: tt, quantity: 1 }], code };

  const first = await app.app.post('/api/orders/gift-card').set('Cookie', customer).send(payload);
  const second = await app.app.post('/api/orders/gift-card').set('Cookie', customer).send(payload);
  assert.equal(second.body.orderNumber, first.body.orderNumber);
  assert.equal(second.body.appliedCents, first.body.appliedCents);

  const gc = cardRow(app, code);
  const holds = app.db.prepare("SELECT COUNT(*) AS c FROM gift_card_redemptions WHERE gift_card_id = ? AND kind = 'hold'").get(gc.id);
  assert.equal(holds.c, 1);
});

test('a fully covered gift-card order completes, redeems the hold, and sells tickets', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app, ...CUSTOMER);

  const orderNumber = await makeOrder(app, customer);
  const total = app.db.prepare('SELECT total_cents FROM orders WHERE order_number = ?').get(orderNumber).total_cents;

  const { res } = await adminCreateCard(app, total);
  const code = res.body.codes[0];
  const tt = await ticketTypeId(app, 70103);

  const buy = await app.app.post('/api/orders/gift-card').set('Cookie', customer)
    .send({ eventId: 70103, items: [{ ticketTypeId: tt, quantity: 1 }], code });
  assert.equal(buy.body.remainingCents, 0);
  assert.equal(buy.body.giftCardCovered, true);

  const before = { ...ttRow(app, tt) };
  const done = await app.app.post(`/api/orders/${buy.body.orderNumber}/gift-card/complete`).set('Cookie', customer);
  assert.equal(done.status, 200);
  assert.equal(done.body.order.status, 'paid');

  // Held amount is now redeemed, and tickets sold.
  const gc = cardRow(app, code);
  assert.equal(gc.redeemed_cents, total);
  assert.equal(gc.held_cents, 0);
  const after = ttRow(app, tt);
  assert.equal(after.sold_quantity, before.sold_quantity + 1);
  assert.equal(after.reserved_quantity, before.reserved_quantity - 1);

  // Calling complete again is idempotent.
  const again = await app.app.post(`/api/orders/${buy.body.orderNumber}/gift-card/complete`).set('Cookie', customer);
  assert.equal(again.status, 200);
  assert.equal(again.body.idempotent, true);

  // Only a zero-balance card remains on record.
  assert.equal(cardRow(app, code).original_value_cents - cardRow(app, code).redeemed_cents - cardRow(app, code).held_cents, 0);
});

test('a partially covered order pays the remainder by card', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app, ...CUSTOMER);

  const orderNumber = await makeOrder(app, customer);
  const total = app.db.prepare('SELECT total_cents FROM orders WHERE order_number = ?').get(orderNumber).total_cents;
  const giftValue = 5000;
  assert.ok(giftValue < total, 'test setup: gift value should be below order total');

  const { res } = await adminCreateCard(app, giftValue);
  const code = res.body.codes[0];
  const tt = await ticketTypeId(app, 70103);

  const buy = await app.app.post('/api/orders/gift-card').set('Cookie', customer)
    .send({ eventId: 70103, items: [{ ticketTypeId: tt, quantity: 1 }], code });
  const remaining = buy.body.remainingCents;
  assert.equal(remaining, total - giftValue);
  assert.equal(buy.body.giftCardCovered, false);

  const pay = await app.app.post(`/api/orders/${buy.body.orderNumber}/pay-remaining/card`).set('Cookie', customer);
  assert.equal(pay.status, 200);
  assert.match(pay.body.checkoutUrl, /https:\/\/pay\.ticketvault\.test\/c\/\d+/);
  const captured = app.stripe._created;
  const session = [...captured].reverse().find(s => s.client_reference_id === buy.body.orderNumber);
  assert.equal(session.line_items.length, 1);
  assert.equal(session.line_items[0].price_data.unit_amount, remaining);

  // Complete via webhook (Stripe mock).
  const webhook = await app.app.post('/webhook/stripe')
    .set('stripe-signature', 'ok')
    .send(checkoutSessionCompleted({
      orderNumber: buy.body.orderNumber,
      paymentIntent: 'pi_gc_remainder',
      sessionId: 'cs_gc_remainder'
    }));
  assert.equal(webhook.status, 200);

  const order = app.db.prepare('SELECT * FROM orders WHERE order_number = ?').get(buy.body.orderNumber);
  assert.equal(order.status, 'paid');
  assert.equal(order.payment_intent_id, 'pi_gc_remainder');
  assert.equal(order.gift_card_cents, giftValue);

  // Gift portion redeemed, card portion recorded separately.
  const gc = cardRow(app, code);
  assert.equal(gc.redeemed_cents, giftValue);
  const cardPayment = app.db.prepare("SELECT amount_cents FROM payments WHERE order_id = ? AND provider = 'stripe'").get(order.id);
  assert.equal(cardPayment.amount_cents, remaining);
});

test('refunding a gift-card-paid order restores the card balance', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app, ...CUSTOMER);
  const orderNumber = await makeOrder(app, customer);
  const total = app.db.prepare('SELECT total_cents FROM orders WHERE order_number = ?').get(orderNumber).total_cents;

  const { res } = await adminCreateCard(app, total + 500);
  const code = res.body.codes[0];
  const tt = await ticketTypeId(app, 70103);

  const buy = await app.app.post('/api/orders/gift-card').set('Cookie', customer)
    .send({ eventId: 70103, items: [{ ticketTypeId: tt, quantity: 1 }], code });
  await app.app.post(`/api/orders/${buy.body.orderNumber}/gift-card/complete`).set('Cookie', customer);
  assert.equal(cardRow(app, code).redeemed_cents, total);

  const admin = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
  const refund = await app.app.post(`/api/admin/orders/${buy.body.orderNumber}/refund`).set('Cookie', admin);
  assert.equal(refund.status, 200);
  assert.equal(refund.body.order.status, 'refunded');

  const gc = cardRow(app, code);
  assert.equal(gc.redeemed_cents, 0);
  assert.equal(gc.original_value_cents - gc.redeemed_cents - gc.held_cents, gc.original_value_cents);
});

test('refunding a partially gift-card-paid order restores only the used portion', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app, ...CUSTOMER);
  const orderNumber = await makeOrder(app, customer);
  const total = app.db.prepare('SELECT total_cents FROM orders WHERE order_number = ?').get(orderNumber).total_cents;
  const giftValue = 2500;

  const { res } = await adminCreateCard(app, giftValue);
  const code = res.body.codes[0];
  const tt = await ticketTypeId(app, 70103);
  const buy = await app.app.post('/api/orders/gift-card').set('Cookie', customer)
    .send({ eventId: 70103, items: [{ ticketTypeId: tt, quantity: 1 }], code });
  await app.app.post(`/api/orders/${buy.body.orderNumber}/pay-remaining/card`).set('Cookie', customer);
  await app.app.post('/webhook/stripe').set('stripe-signature', 'ok')
    .send(checkoutSessionCompleted({ orderNumber: buy.body.orderNumber, paymentIntent: 'pi_gc_partial' }));

  const admin = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
  const refund = await app.app.post(`/api/admin/orders/${buy.body.orderNumber}/refund`).set('Cookie', admin);
  assert.equal(refund.status, 200);

  const gc = cardRow(app, code);
  assert.equal(gc.redeemed_cents, 0);
  assert.equal(gc.original_value_cents - gc.redeemed_cents - gc.held_cents, giftValue);
});

test('cancelling a gift-card pending order releases the hold and inventory', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app, ...CUSTOMER);
  const { res } = await adminCreateCard(app, 99999);
  const code = res.body.codes[0];
  const tt = await ticketTypeId(app, 70103);
  const buy = await app.app.post('/api/orders/gift-card').set('Cookie', customer)
    .send({ eventId: 70103, items: [{ ticketTypeId: tt, quantity: 1 }], code });
  const orderId = app.db.prepare('SELECT id FROM orders WHERE order_number = ?').get(buy.body.orderNumber).id;

  const before = { ...ttRow(app, tt) };
  const cancel = await app.app.post('/webhook/stripe').set('stripe-signature', 'ok')
    .send({ id: 'evt_gc_cancel', type: 'payment_intent.canceled', data: { object: { metadata: { order_number: buy.body.orderNumber } } } });
  assert.equal(cancel.status, 200);

  assert.equal(app.db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId).status, 'cancelled');
  const gc = cardRow(app, code);
  assert.equal(gc.held_cents, 0);
  const after = ttRow(app, tt);
  assert.equal(after.reserved_quantity, before.reserved_quantity - 1);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS c FROM gift_card_redemptions WHERE order_id = ? AND kind = 'release'").get(orderId).c, 1);
});

test('deactivated gift cards cannot be used', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const admin = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
  const { res } = await adminCreateCard(app, 5000);
  const code = res.body.codes[0];
  const id = cardRow(app, code).id;

  const toggle = await app.app.post(`/api/admin/gift-cards/${id}/toggle`).set('Cookie', admin);
  assert.equal(toggle.status, 200);
  assert.equal(toggle.body.giftCard.is_active, 0);

  const customer = await cookieFor(app, ...CUSTOMER);
  const tt = await ticketTypeId(app, 70103);
  const buy = await app.app.post('/api/orders/gift-card').set('Cookie', customer)
    .send({ eventId: 70103, items: [{ ticketTypeId: tt, quantity: 1 }], code });
  assert.equal(buy.status, 409);
  assert.equal(buy.body.code, 'GIFT_CARD_INACTIVE');

  const toggleBack = await app.app.post(`/api/admin/gift-cards/${id}/toggle`).set('Cookie', admin);
  assert.equal(toggleBack.body.giftCard.is_active, 1);
});

test('an expired gift card errors with a hold', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const admin = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
  const { res } = await adminCreateCard(app, 100000);
  const code = res.body.codes[0];
  const norm = String(code).trim().toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '');
  app.db.prepare('UPDATE gift_cards SET expires_at = ? WHERE code_hash = ?').run('2000-01-01 00:00:00',
    require('node:crypto').createHash('sha256').update(norm).digest('hex'));

  const customer = await cookieFor(app, ...CUSTOMER);
  const tt = await ticketTypeId(app, 70103);
  const buy = await app.app.post('/api/orders/gift-card').set('Cookie', customer)
    .send({ eventId: 70103, items: [{ ticketTypeId: tt, quantity: 1 }], code });
  assert.equal(buy.status, 409);
  assert.equal(buy.body.code, 'GIFT_CARD_EXPIRED');
  assert.equal(cardRow(app, code).held_cents, 0);
});

test('gift card redemption history is visible to admins with order references', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app, ...CUSTOMER);
  const admin = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
  const orderNumber = await makeOrder(app, customer);
  const total = app.db.prepare('SELECT total_cents FROM orders WHERE order_number = ?').get(orderNumber).total_cents;
  const { res } = await adminCreateCard(app, total);
  const code = res.body.codes[0];
  const tt = await ticketTypeId(app, 70103);
  const buy = await app.app.post('/api/orders/gift-card').set('Cookie', customer)
    .send({ eventId: 70103, items: [{ ticketTypeId: tt, quantity: 1 }], code });
  await app.app.post(`/api/orders/${buy.body.orderNumber}/gift-card/complete`).set('Cookie', customer);

  const id = cardRow(app, code).id;
  const hist = await app.app.get(`/api/admin/gift-cards/${id}/redemptions`).set('Cookie', admin);
  assert.equal(hist.status, 200);
  // The pending "hold" row transitions to "redeem" once the order is paid.
  const kinds = hist.body.redemptions.map(r => r.kind);
  assert.deepEqual(kinds, ['redeem']);
  for (const r of hist.body.redemptions) {
    assert.equal(r.order_number, buy.body.orderNumber);
  }
});