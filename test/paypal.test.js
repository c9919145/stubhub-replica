'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTestApp, login, ticketTypeId, createPayPalMock, ADMIN_EMAIL, ADMIN_PASSWORD } = require('./helpers');

async function cookieFor(app, email, password) {
  const res = await login(app, email, password);
  return res.headers['set-cookie'][0].split(';')[0];
}

const CUSTOMER = ['customer@stubhub.test', 'password123'];

/** Creates a PayPal order via the API and returns { orderNumber, tt, order }. */
async function paypalOrder(app, cookie, eventId = 70103, quantity = 1) {
  const tt = await ticketTypeId(app, eventId);
  const res = await app.app.post('/api/orders/paypal').set('Cookie', cookie)
    .send({ eventId, items: [{ ticketTypeId: tt, quantity }] });
  assert.equal(res.status, 200);
  const order = app.db.prepare('SELECT * FROM orders WHERE order_number = ?').get(res.body.orderNumber);
  return { orderNumber: res.body.orderNumber, approveUrl: res.body.approveUrl, tt, order };
}

function paypalCaptureEvent({ id = 'evt_capture', customId, captureId = 'CAP-XYZ', captureAmountDollars = '99.99' }) {
  return {
    id,
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: {
      id: captureId,
      custom_id: customId,
      amount: { currency_code: 'USD', value: captureAmountDollars },
      status: 'COMPLETED'
    }
  };
}

function paypalRefundEvent(captureId, id = 'evt_refund') {
  return { id, event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: captureId } };
}

function paypalDeniedEvent(customId, id = 'evt_denied') {
  return { id, event_type: 'PAYMENT.CAPTURE.DENIED', resource: { custom_id: customId, status: 'DENIED' } };
}

async function postPayPalWebhook(app, event, paypal = app.paypal) {
  return app.app.post('/webhook/paypal')
    .set('Content-Type', 'application/json')
    .set('paypal-transmission-id', 'transmission-1')
    .set('paypal-transmission-time', new Date().toISOString())
    .set('paypal-cert-url', 'https://api.sandbox.paypal.com/cert')
    .set('paypal-auth-algo', 'SHA256withRSA')
    .set('paypal-transmission-sig', 'abc123')
    .send(JSON.stringify(event));
}

function ttRow(app, id) {
  return app.db.prepare('SELECT reserved_quantity, sold_quantity FROM ticket_types WHERE id = ?').get(id);
}

test('POST /api/orders/paypal creates a PayPal order and records it', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app, ...CUSTOMER);
  const { orderNumber, approveUrl, tt, order } = await paypalOrder(app, customer);

  assert.match(approveUrl, /https:\/\/paypal\.stubhub\.test\/approve\/1/);
  assert.equal(order.payment_method, 'paypal');

  const payment = app.db.prepare("SELECT * FROM payments WHERE order_id = ? AND provider = 'paypal'").get(order.id);
  assert.ok(payment);
  assert.equal(payment.status, 'pending');
  assert.ok(payment.provider_order_id);

  // Inventory reserved, not sold, for paypal orders too.
  assert.equal(ttRow(app, tt).reserved_quantity, 1);
  assert.equal(ttRow(app, tt).sold_quantity, 0);
});

test('capturing a PayPal order pays it, sells tickets, and is idempotent', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app, ...CUSTOMER);
  const { orderNumber, tt, order } = await paypalOrder(app, customer);
  const before = { ...ttRow(app, tt) };

  const cap = await app.app.post(`/api/orders/${orderNumber}/paypal/capture`).set('Cookie', customer);
  assert.equal(cap.status, 200);
  assert.equal(cap.body.status, 'paid');

  const paid = app.db.prepare('SELECT * FROM orders WHERE order_number = ?').get(orderNumber);
  assert.equal(paid.status, 'paid');
  assert.ok(paid.payment_intent_id);

  const payment = app.db.prepare("SELECT * FROM payments WHERE order_id = ? AND provider = 'paypal' ORDER BY id DESC LIMIT 1").get(order.id);
  assert.equal(payment.status, 'succeeded');
  assert.equal(payment.amount_cents, order.total_cents);

  const after = ttRow(app, tt);
  assert.equal(after.sold_quantity, before.sold_quantity + 1);
  assert.equal(after.reserved_quantity, before.reserved_quantity - 1);

  // Second capture is idempotent and does not double-sell.
  const again = await app.app.post(`/api/orders/${orderNumber}/paypal/capture`).set('Cookie', customer);
  assert.equal(again.status, 200);
  assert.equal(again.body.status, 'paid');
  assert.equal(again.body.idempotent, true);
  assert.equal(ttRow(app, tt).sold_quantity, after.sold_quantity);
});

test('capture fails without an existing PayPal order', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app, ...CUSTOMER);
  const tt = await ticketTypeId(app, 70103);
  const order = await app.app.post('/api/orders').set('Cookie', customer)
    .send({ eventId: 70103, items: [{ ticketTypeId: tt, quantity: 1 }] });
  const res = await app.app.post(`/api/orders/${order.body.orderNumber}/paypal/capture`).set('Cookie', customer);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'NO_PAYPAL_ORDER');
});

test('PayPal capture webhook pays the order (duplicate-safe)', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app, ...CUSTOMER);
  const { orderNumber, tt, order } = await paypalOrder(app, customer);

  const event = paypalCaptureEvent({
    id: 'evt_capture_1',
    customId: orderNumber,
    captureId: 'CAP-WEBHOOK'
  });
  const res = await postPayPalWebhook(app, event);
  assert.equal(res.status, 200);
  assert.equal(res.body.idempotent, false);

  const paid = app.db.prepare('SELECT * FROM orders WHERE order_number = ?').get(orderNumber);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.payment_intent_id, 'CAP-WEBHOOK');

  // Duplicate webhook does not double-sell.
  const again = await postPayPalWebhook(app, event);
  assert.equal(again.status, 200);
  assert.equal(again.body.idempotent, true);
  assert.equal(ttRow(app, tt).sold_quantity, 1);
});

test('PayPal webhook requires a valid signature', async (t) => {
  const app = createTestApp({ paypal: createPayPalMock({ invalidSignature: true }) });
  t.after(() => app.close());
  const res = await postPayPalWebhook(app, paypalCaptureEvent({ customId: 'SH-UNKNOWN' }));
  assert.equal(res.status, 500);
});

test('a denied capture releases the reservation', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app, ...CUSTOMER);
  const { orderNumber, tt } = await paypalOrder(app, customer);
  const before = { ...ttRow(app, tt) };

  const res = await postPayPalWebhook(app, paypalDeniedEvent(orderNumber));
  assert.equal(res.status, 200);

  const order = app.db.prepare('SELECT status FROM orders WHERE order_number = ?').get(orderNumber);
  assert.equal(order.status, 'failed');
  const after = ttRow(app, tt);
  assert.equal(after.reserved_quantity, before.reserved_quantity - 1);
});

test('paying the remainder after a gift card with PayPal', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app, ...CUSTOMER);
  const tt = await ticketTypeId(app, 70103);

  // Apply a gift card to a pending order first.
  const admin = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
  const gcCreate = await app.app.post('/api/admin/gift-cards').set('Cookie', admin).send({ valueCents: 1000, count: 1 });
  const code = gcCreate.body.codes[0];

  const buy = await app.app.post('/api/orders/gift-card').set('Cookie', customer)
    .send({ eventId: 70103, items: [{ ticketTypeId: tt, quantity: 1 }], code });
  const orderNumber = buy.body.orderNumber;
  const remaining = buy.body.remainingCents;
  assert.ok(remaining > 0);

  const pp = await app.app.post(`/api/orders/${orderNumber}/pay-remaining/paypal`).set('Cookie', customer);
  assert.equal(pp.status, 200);
  assert.equal(pp.body.approveUrl, 'https://paypal.stubhub.test/approve/1');

  const created = app.paypal._created[0];
  assert.equal(created.orderNumber, orderNumber);
  assert.equal(created.amountCents, remaining);

  const cap = await app.app.post(`/api/orders/${orderNumber}/paypal/capture`).set('Cookie', customer);
  assert.equal(cap.status, 200);
  const order = app.db.prepare('SELECT * FROM orders WHERE order_number = ?').get(orderNumber);
  assert.equal(order.status, 'paid');
  assert.equal(order.gift_card_cents, 1000);

  // Gift portion redeemed, paypal portion captured for the remainder.
  const norm = String(code).trim().toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '');
  const hash = require('node:crypto').createHash('sha256').update(norm).digest('hex');
  const gc = app.db.prepare('SELECT original_value_cents, redeemed_cents, held_cents FROM gift_cards WHERE code_hash = ?').get(hash);
  assert.equal(gc.held_cents, 0);
  assert.equal(gc.redeemed_cents, 1000);
});

test('refunding a PayPal order marks it refunded and restores gift funds', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app, ...CUSTOMER);
  const { orderNumber, order } = await paypalOrder(app, customer);

  const cap = await app.app.post(`/api/orders/${orderNumber}/paypal/capture`).set('Cookie', customer);
  assert.equal(cap.status, 200);
  const captureId = app.db.prepare('SELECT payment_intent_id FROM orders WHERE order_number = ?').get(orderNumber).payment_intent_id;
  assert.ok(captureId);
  assert.equal(captureId, 'CAP-1');

  const admin = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
  const refund = await app.app.post(`/api/admin/orders/${orderNumber}/refund`).set('Cookie', admin);
  assert.equal(refund.status, 200);
  assert.equal(refund.body.order.status, 'refunded');

  // PayPal capture was refunded through the PayPal API.
  assert.equal(app.paypal._captured.length, 1);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS c FROM payments WHERE order_id = ? AND status = ?').get(order.id, 'refunded').c, 1);
});

test('PayPal capture refund webhook marks a paid order refunded (idempotent)', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app, ...CUSTOMER);
  const { orderNumber } = await paypalOrder(app, customer);

  // Pay via webhook capture completed.
  await postPayPalWebhook(app, paypalCaptureEvent({ customId: orderNumber, captureId: 'CAP-REFUNDABLE' }));
  assert.equal(app.db.prepare('SELECT status FROM orders WHERE order_number = ?').get(orderNumber).status, 'paid');

  const refund = await postPayPalWebhook(app, paypalRefundEvent('CAP-REFUNDABLE'));
  assert.equal(refund.status, 200);
  assert.equal(refund.body.idempotent, false);
  assert.equal(app.db.prepare('SELECT status FROM orders WHERE order_number = ?').get(orderNumber).status, 'refunded');

  const dup = await postPayPalWebhook(app, paypalRefundEvent('CAP-REFUNDABLE'));
  assert.equal(dup.body.idempotent, true);
  assert.equal(app.db.prepare('SELECT status FROM orders WHERE order_number = ?').get(orderNumber).status, 'refunded');
});