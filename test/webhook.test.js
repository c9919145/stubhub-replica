'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTestApp, createStripeMock, login, ticketTypeId } = require('./helpers');

async function loggedIn(app) {
  const res = await login(app);
  return res.headers['set-cookie'][0].split(';')[0];
}

/** Creates an order via the API. Returns { order, ticketTypeId }. */
async function createOrder(app, cookie, eventId = 70103, quantity = 1) {
  const tt = app.db.prepare('SELECT id FROM ticket_types WHERE event_id = ? ORDER BY price_cents ASC LIMIT 1').get(eventId);
  const res = await app.app.post('/api/orders').set('Cookie', cookie)
    .send({ eventId, items: [{ ticketTypeId: tt.id, quantity }] });
  assert.equal(res.status, 200);
  const order = app.db.prepare('SELECT * FROM orders WHERE order_number = ?').get(res.body.orderNumber);
  return { order, ticketTypeId: tt.id };
}

function ttRow(app, id) {
  return app.db.prepare('SELECT reserved_quantity, sold_quantity FROM ticket_types WHERE id = ?').get(id);
}

test('webhook route requires a Stripe signature header', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const res = await app.app.post('/webhook/stripe').send({ type: 'checkout.session.completed' });
  assert.equal(res.status, 400);
});

test('webhook route rejects an invalid signature', async (t) => {
  const app = createTestApp({ stripe: createStripeMock({ invalidSignature: true }) });
  t.after(() => app.close());
  const res = await app.app.post('/webhook/stripe')
    .set('stripe-signature', 'bad-signature')
    .send(JSON.stringify({ type: 'checkout.session.completed' }));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_SIGNATURE');
});

test('checkout.session.completed pays the order, sells tickets, and persists a payment', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const cookie = await loggedIn(app);
  const { order, ticketTypeId } = await createOrder(app, cookie, 70103, 2);

  const before = { ...ttRow(app, ticketTypeId) };

  const session = {
    id: 'cs_test_completed',
    client_reference_id: order.order_number,
    payment_status: 'paid',
    payment_intent: 'pi_test_abc123',
    metadata: { order_number: order.order_number }
  };
  const res = await app.app.post('/webhook/stripe')
    .set('stripe-signature', 'ok')
    .send({ id: 'evt_unique_1', type: 'checkout.session.completed', data: { object: session } });

  assert.equal(res.status, 200);
  assert.equal(res.body.received, true);
  assert.equal(res.body.idempotent, false);

  const after = { ...ttRow(app, ticketTypeId) };
  assert.deepEqual(
    { sold: after.sold_quantity, reserved: after.reserved_quantity },
    { sold: before.sold_quantity + 2, reserved: before.reserved_quantity - 2 }
  );

  const updated = app.db.prepare('SELECT * FROM orders WHERE order_number = ?').get(order.order_number);
  assert.equal(updated.status, 'paid');
  assert.equal(updated.payment_intent_id, 'pi_test_abc123');

  const payment = app.db.prepare('SELECT * FROM payments WHERE order_id = ?').get(order.id);
  assert.equal(payment.status, 'succeeded');
  assert.equal(payment.provider_payment_id, 'pi_test_abc123');
  assert.equal(payment.amount_cents, updated.total_cents);
});

test('the same Stripe event delivered twice is idempotent', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const cookie = await loggedIn(app);
  const { order, ticketTypeId } = await createOrder(app, cookie, 70103, 1);

  const payload = {
    id: 'evt_duplicate_1',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_dup', client_reference_id: order.order_number, payment_status: 'paid', payment_intent: 'pi_test_dup', metadata: { order_number: order.order_number } } }
  };

  const first = await app.app.post('/webhook/stripe').set('stripe-signature', 'ok').send(payload);
  const second = await app.app.post('/webhook/stripe').set('stripe-signature', 'ok').send(payload);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.idempotent, false);
  assert.equal(second.body.idempotent, true);

  const after = ttRow(app, ticketTypeId);
  assert.equal(after.sold_quantity, 1);
});

test('unpaid sessions are ignored and do not sell tickets', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const cookie = await loggedIn(app);
  const { order } = await createOrder(app, cookie, 70103, 1);

  const res = await app.app.post('/webhook/stripe').set('stripe-signature', 'ok')
    .send({ id: 'evt_unpaid', type: 'checkout.session.completed', data: { object: { client_reference_id: order.order_number, payment_status: 'unpaid', payment_intent: null, metadata: { order_number: order.order_number } } } });
  assert.equal(res.status, 200);
  assert.equal(res.body.ignored, true);

  const updated = app.db.prepare('SELECT status FROM orders WHERE order_number = ?').get(order.order_number);
  assert.equal(updated.status, 'pending');
});

test('payment failure fails the order and releases the reservation', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const cookie = await loggedIn(app);
  const { order, ticketTypeId } = await createOrder(app, cookie, 70103, 3);

  const res = await app.app.post('/webhook/stripe').set('stripe-signature', 'ok')
    .send({ id: 'evt_pi_fail', type: 'payment_intent.payment_failed', data: { object: { metadata: { order_number: order.order_number }, last_payment_error: { message: 'card_declined' } } } });
  assert.equal(res.status, 200);
  assert.equal(res.body.idempotent, false);

  const updated = app.db.prepare('SELECT status FROM orders WHERE order_number = ?').get(order.order_number);
  assert.equal(updated.status, 'failed');

  const tt = ttRow(app, ticketTypeId);
  assert.equal(tt.reserved_quantity, 0);
  assert.equal(tt.sold_quantity, 0);

  const payment = app.db.prepare('SELECT * FROM payments WHERE order_id = ?').get(order.id);
  assert.equal(payment.status, 'failed');
});

test('checkout.session.expired releases the reservation', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const cookie = await loggedIn(app);
  const { order, ticketTypeId } = await createOrder(app, cookie, 70103, 2);

  const res = await app.app.post('/webhook/stripe').set('stripe-signature', 'ok')
    .send({ id: 'evt_exp', type: 'checkout.session.expired', data: { object: { client_reference_id: order.order_number, metadata: { order_number: order.order_number } } } });
  assert.equal(res.status, 200);

  const updated = app.db.prepare('SELECT status FROM orders WHERE order_number = ?').get(order.order_number);
  assert.equal(updated.status, 'expired');
  assert.equal(ttRow(app, ticketTypeId).reserved_quantity, 0);
});

test('payment_intent.canceled cancels the order and releases inventory', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const cookie = await loggedIn(app);
  const { order, ticketTypeId } = await createOrder(app, cookie, 70103, 1);

  const res = await app.app.post('/webhook/stripe').set('stripe-signature', 'ok')
    .send({ id: 'evt_pi_cancel', type: 'payment_intent.canceled', data: { object: { metadata: { order_number: order.order_number } } } });
  assert.equal(res.status, 200);

  const updated = app.db.prepare('SELECT status FROM orders WHERE order_number = ?').get(order.order_number);
  assert.equal(updated.status, 'cancelled');
  assert.equal(ttRow(app, ticketTypeId).reserved_quantity, 0);
});

test('charge.refunded marks a paid order as refunded', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const cookie = await loggedIn(app);
  const { order } = await createOrder(app, cookie, 70103, 1);

  app.db.prepare(`UPDATE orders SET status = 'paid', payment_intent_id = 'pi_test_refundable' WHERE order_number = ?`).run(order.order_number);

  const res = await app.app.post('/webhook/stripe').set('stripe-signature', 'ok')
    .send({ id: 'evt_refund', type: 'charge.refunded', data: { object: { id: 'ch_test_refund', payment_intent: 'pi_test_refundable' } } });
  assert.equal(res.status, 200);
  assert.equal(res.body.idempotent, false);

  const updated = app.db.prepare('SELECT status FROM orders WHERE order_number = ?').get(order.order_number);
  assert.equal(updated.status, 'refunded');
});

test('webhook for an unknown order returns 404 without crashing', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const res = await app.app.post('/webhook/stripe').set('stripe-signature', 'ok')
    .send({ id: 'evt_unknown', type: 'checkout.session.completed', data: { object: { client_reference_id: 'SH-MISSING', payment_status: 'paid', metadata: { order_number: 'SH-MISSING' } } } });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'ORDER_NOT_FOUND');
});

test('successful payment async ordering is still safe (payment_intent.succeeded path)', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const cookie = await loggedIn(app);
  const { order } = await createOrder(app, cookie, 70103, 1);

  const res = await app.app.post('/webhook/stripe').set('stripe-signature', 'ok')
    .send({ id: 'evt_pi_success', type: 'payment_intent.succeeded', data: { object: { id: 'pi_test_async', metadata: { order_number: order.order_number } } } });
  assert.equal(res.status, 200);

  const updated = app.db.prepare('SELECT status FROM orders WHERE order_number = ?').get(order.order_number);
  assert.equal(updated.status, 'paid');
});