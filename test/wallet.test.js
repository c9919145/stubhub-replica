'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createTestApp,
  login,
  ticketTypeId,
  makeEvent,
  checkoutSessionCompleted,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  CUSTOMER_EMAIL,
  CUSTOMER_PASSWORD
} = require('./helpers');

async function cookieFor(app, email = CUSTOMER_EMAIL, password = CUSTOMER_PASSWORD) {
  const res = await login(app, email, password);
  return res.headers['set-cookie'][0].split(';')[0];
}

function userIdFor(app, email) {
  return app.db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
}

function balanceOf(app, email) {
  const id = userIdFor(app, email);
  return app.db.prepare('SELECT balance_cents FROM wallets WHERE user_id = ?').get(id)?.balance_cents ?? 0;
}

function txnsOf(app, email) {
  const id = userIdFor(app, email);
  return app.db.prepare(
    'SELECT txn_id, kind, amount_cents, method, status FROM wallet_transactions WHERE user_id = ? ORDER BY id'
  ).all(id);
}

function ttRow(app, id) {
  return app.db.prepare('SELECT reserved_quantity, sold_quantity FROM ticket_types WHERE id = ?').get(id);
}

function walletSessionCompleted(txnId, paymentIntent = 'pi_deposit_' + Math.random()) {
  return makeEvent('evt_walldep_' + Math.random(), 'checkout.session.completed', {
    id: 'cs_deposit_' + Math.random(),
    client_reference_id: txnId,
    payment_status: 'paid',
    payment_intent: paymentIntent,
    metadata: { wallet_deposit: '1', wallet_txn_id: txnId }
  });
}

/* ---------------- signup ---------------- */

test('register accepts firstName/lastName (membership form), requires a name', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());

  const ok = await app.app.post('/api/auth/register')
    .send({ email: 'jane@x.dev', password: 'supersecret1', firstName: 'Jane', lastName: 'Doe' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.user.name, 'Jane Doe');

  assert.equal((await app.app.post('/api/auth/register')
    .send({ email: 'noname@x.dev', password: 'supersecret1' })).status, 400);
  assert.equal((await app.app.post('/api/auth/register')
    .send({ email: 'dup@x.dev', password: 'supersecret1', name: 'A B' })).status, 201);
  const dup = await app.app.post('/api/auth/register')
    .send({ email: 'DUP@x.dev', password: 'supersecret1', name: 'A B' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'EMAIL_TAKEN');
});

test('wallet endpoints require authentication', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());

  assert.equal((await app.app.get('/api/wallet')).status, 401);
  assert.equal((await app.app.post('/api/wallet/deposits').send({ amountCents: 5000, method: 'card' })).status, 401);
  assert.equal((await app.app.post('/api/orders/wallet').send({ eventId: 70103, items: [] })).status, 401);
  assert.equal((await app.app.post('/api/orders/crypto').send({ eventId: 70103, items: [], method: 'btc' })).status, 401);
});

test('wallet is created on first access with zero balance', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const cookie = await cookieFor(app);

  const res = await app.app.get('/api/wallet').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.equal(res.body.wallet.balanceCents, 0);
  assert.deepEqual(res.body.wallet.transactions, []);
});

/* ---------------- deposits ---------------- */

test('rejects invalid amounts and unavailable methods', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const cookie = await cookieFor(app);

  assert.equal((await app.app.post('/api/wallet/deposits').set('Cookie', cookie).send({ amountCents: 0, method: 'card' })).status, 400);
  assert.equal((await app.app.post('/api/wallet/deposits').set('Cookie', cookie).send({ amountCents: 999999999, method: 'card' })).status, 400);
  assert.equal((await app.app.post('/api/wallet/deposits').set('Cookie', cookie).send({ amountCents: 5000, method: 'usdt' })).status, 409);
  assert.equal((await app.app.post('/api/wallet/deposits').set('Cookie', cookie).send({ amountCents: 5000, method: 'paypal' })).status, 400);
  assert.equal((await app.app.post('/api/wallet/deposits').set('Cookie', cookie).send({ amountCents: 'garbage', method: 'card' })).status, 400);
});

test('card deposit is NOT credited until the Stripe webhook confirms, and is credited only once', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const cookie = await cookieFor(app);

  const res = await app.app.post('/api/wallet/deposits').set('Cookie', cookie).send({ amountCents: 5000, method: 'card' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'pending');
  assert.match(res.body.checkoutUrl, /^https:/);
  const txnId = res.body.txnId;

  // Not credited before the webhook fires.
  assert.equal(balanceOf(app, CUSTOMER_EMAIL), 0);
  const pending = txnsOf(app, CUSTOMER_EMAIL);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'pending');

  // Session params must carry the deposit reference and amount.
  const created = app.stripe._created[0];
  assert.ok(created);
  assert.equal(created.metadata.wallet_deposit, '1');
  assert.equal(created.metadata.wallet_txn_id, txnId);
  assert.equal(created.line_items[0].price_data.unit_amount, 5000);
  assert.equal(created.client_reference_id, txnId);

  const event = walletSessionCompleted(txnId);
  const wh = await app.app.post('/webhook/stripe')
    .set('stripe-signature', 'test-signature')
    .send(event);
  assert.equal(wh.status, 200);

  assert.equal(balanceOf(app, CUSTOMER_EMAIL), 5000);
  const after = txnsOf(app, CUSTOMER_EMAIL);
  assert.equal(after[0].status, 'completed');
  assert.equal(after[0].kind, 'deposit');
  assert.equal(after[0].amount_cents, 5000);

  // Replaying any confirmation for the same deposit must not double-credit.
  const replay = await app.app.post('/webhook/stripe')
    .set('stripe-signature', 'test-signature')
    .send(walletSessionCompleted(txnId, 'pi_replay_1'));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.walletDeposit.idempotent, true);
  assert.equal(balanceOf(app, CUSTOMER_EMAIL), 5000);

  // A deposit with the same txn_id cannot be created twice (unique).
  const again = await app.app.post('/api/wallet/deposits').set('Cookie', cookie).send({ amountCents: 2000, method: 'eth' });
  assert.equal(again.status, 200);
  assert.notEqual(again.body.txnId, txnId);
});

test('crypto deposit stays PENDING until an admin confirms on-chain confirmation; never by the button', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app);
  const admin = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);

  const res = await app.app.post('/api/wallet/deposits').set('Cookie', customer).send({ amountCents: 10000, method: 'btc' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.requiresVerification, true);
  assert.equal(res.body.payment.address, 'bc1q82haxrn0a0utrm3usnq7ajecumvqzk453v54vu');
  assert.equal(res.body.payment.network, 'Bitcoin (BTC)');
  assert.match(res.body.payment.qrImage, /qr-btc\.png$/);
  const txnId = res.body.txnId;

  // No credit without confirmation.
  assert.equal(balanceOf(app, CUSTOMER_EMAIL), 0);
  assert.equal(txnsOf(app, CUSTOMER_EMAIL)[0].status, 'pending');

  // A customer cannot confirm their own deposit (admin-only endpoint).
  const forbidden = await app.app.post(`/api/admin/wallet/deposits/${txnId}/confirm`)
    .set('Cookie', customer).send({ outcome: 'completed' });
  assert.equal(forbidden.status, 403);

  // Admin confirms; balance credited once.
  const confirm = await app.app.post(`/api/admin/wallet/deposits/${txnId}/confirm`)
    .set('Cookie', admin).send({ outcome: 'completed' });
  assert.equal(confirm.status, 200);
  assert.equal(balanceOf(app, CUSTOMER_EMAIL), 10000);

  const confirmAgain = await app.app.post(`/api/admin/wallet/deposits/${txnId}/confirm`)
    .set('Cookie', admin).send({ outcome: 'completed' });
  assert.equal(confirmAgain.body.idempotent, true);
  assert.equal(balanceOf(app, CUSTOMER_EMAIL), 10000);

  // Invalid outcome is rejected.
  const bad = await app.app.post(`/api/admin/wallet/deposits/${txnId}/confirm`)
    .set('Cookie', admin).send({ outcome: 'maybe' });
  assert.equal(bad.status, 400);
});

test('a failed deposit never credits the wallet', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app);
  const admin = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);

  const dep = await app.app.post('/api/wallet/deposits').set('Cookie', customer).send({ amountCents: 3000, method: 'eth' });
  const txnId = dep.body.txnId;

  const fail = await app.app.post(`/api/admin/wallet/deposits/${txnId}/confirm`)
    .set('Cookie', admin).send({ outcome: 'failed' });
  assert.equal(fail.status, 200);
  assert.equal(balanceOf(app, CUSTOMER_EMAIL), 0);
  assert.equal(txnsOf(app, CUSTOMER_EMAIL)[0].status, 'failed');

  // Completing a failed deposit is not allowed (avoids manual double-credit fraud).
  const complete = await app.app.post(`/api/admin/wallet/deposits/${txnId}/confirm`)
    .set('Cookie', admin).send({ outcome: 'completed' });
  assert.equal(complete.status, 409);
  assert.equal(balanceOf(app, CUSTOMER_EMAIL), 0);
});

/* ---------------- wallet checkout ---------------- */

async function createPendingOrder(app, cookie, eventId = 70103, quantity = 1) {
  const tt = await ticketTypeId(app, eventId);
  const res = await app.app.post('/api/orders').set('Cookie', cookie)
    .send({ eventId, items: [{ ticketTypeId: tt, quantity }] });
  assert.equal(res.status, 200);
  const order = app.db.prepare('SELECT * FROM orders WHERE order_number = ?').get(res.body.orderNumber);
  return { order, ttId: tt };
}

test('wallet checkout is rejected with insufficient balance and sells nothing', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app);

  const { order, ttId } = await createPendingOrder(app, customer);
  assert.equal(balanceOf(app, CUSTOMER_EMAIL), 0);
  const soldBefore = ttRow(app, ttId).sold_quantity;

  const pay = await app.app.post('/api/orders/wallet').set('Cookie', customer).send({
    eventId: 70103,
    items: [{ ticketTypeId: ttId, quantity: 1 }]
  });
  assert.equal(pay.status, 409);
  assert.equal(pay.body.code, 'INSUFFICIENT_WALLET_BALANCE');
  assert.equal(balanceOf(app, CUSTOMER_EMAIL), 0);
  assert.equal(ttRow(app, ttId).sold_quantity, soldBefore);
  assert.equal(app.db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'pending');
});

test('wallet pays an order atomically: debits balance, sells tickets, idempotent on retry', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app);

  // Fund the wallet with a real (webhook-confirmed) card top-up.
  const dep = await app.app.post('/api/wallet/deposits').set('Cookie', customer).send({ amountCents: 200000, method: 'card' });
  await app.app.post('/webhook/stripe')
    .set('stripe-signature', 'test-signature')
    .send(walletSessionCompleted(dep.body.txnId));
  assert.equal(balanceOf(app, CUSTOMER_EMAIL), 200000);

  const { order, ttId } = await createPendingOrder(app, customer);
  const total = order.total_cents;
  const soldBefore = ttRow(app, ttId).sold_quantity;
  const reservedBefore = ttRow(app, ttId).reserved_quantity;

  const pay = await app.app.post('/api/orders/wallet').set('Cookie', customer).send({
    eventId: 70103,
    items: [{ ticketTypeId: ttId, quantity: 1 }]
  });
  assert.equal(pay.status, 200);
  assert.equal(pay.body.order.status, 'paid');
  assert.equal(pay.body.order.paymentMethod, 'wallet');

  assert.equal(balanceOf(app, CUSTOMER_EMAIL), 200000 - total);
  assert.equal(ttRow(app, ttId).sold_quantity, soldBefore + 1);
  assert.equal(ttRow(app, ttId).reserved_quantity, reservedBefore - 1);

  const orderTxn = txnsOf(app, CUSTOMER_EMAIL).find(t => t.kind === 'order_payment');
  assert.ok(orderTxn);
  assert.equal(orderTxn.amount_cents, total);
  assert.equal(orderTxn.status, 'completed');
  assert.equal(pay.body.order.payment.transactionId, orderTxn.txn_id);

  // Retrying the wallet payment must not double-debit or double-sell.
  const retry = await app.app.post('/api/orders/wallet').set('Cookie', customer).send({
    eventId: 70103,
    items: [{ ticketTypeId: ttId, quantity: 1 }]
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.idempotent, true);
  assert.equal(balanceOf(app, CUSTOMER_EMAIL), 200000 - total);
  assert.equal(ttRow(app, ttId).sold_quantity, soldBefore + 1);
});

test('a customer cannot pay for another customer\'s order with their wallet', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const alice = await cookieFor(app, CUSTOMER_EMAIL, CUSTOMER_PASSWORD);
  const bobRes = await app.app.post('/api/auth/register')
    .send({ email: 'bob@w.dev', password: 'supersecret1', name: 'Bob' });
  const bobCookie = bobRes.headers['set-cookie'][0].split(';')[0];

  const { order, ttId } = await createPendingOrder(app, bobCookie);

  const pay = await app.app.post('/api/orders/wallet').set('Cookie', alice).send({
    eventId: 70103,
    items: [{ ticketTypeId: ttId, quantity: 1 }]
  });
  // The wallet route creates a NEW order for alice and (with zero balance) fails.
  assert.equal(pay.status, 409);
  assert.equal(pay.body.code, 'INSUFFICIENT_WALLET_BALANCE');
  assert.equal(app.db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'pending');
  assert.equal(txnsOf(app, 'bob@w.dev').length, 0);
});

test('wallet checkout is refused when the order already has a payment started', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app);

  const dep = await app.app.post('/api/wallet/deposits').set('Cookie', customer).send({ amountCents: 200000, method: 'card' });
  await app.app.post('/webhook/stripe')
    .set('stripe-signature', 'test-signature')
    .send(walletSessionCompleted(dep.body.txnId));

  // Mark a crypto payment as started against a pending order.
  const { order, ttId } = await createPendingOrder(app, customer);
  app.db.prepare(
    `INSERT INTO payments (order_id, provider, provider_order_id, amount_cents, currency, status)
     VALUES (?, 'crypto', ?, ?, 'usd', 'pending')`
  ).run(order.id, order.order_number, order.total_cents);

  const pay = await app.app.post('/api/orders/wallet').set('Cookie', customer).send({
    eventId: 70103,
    items: [{ ticketTypeId: ttId, quantity: 1 }]
  });
  assert.equal(pay.status, 409);
  assert.equal(pay.body.code, 'PAYMENT_ALREADY_STARTED');
  assert.equal(balanceOf(app, CUSTOMER_EMAIL), 200000);
});

test('wallet checkout is refused when a gift card was already applied to the order', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app);
  const admin = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);

  const gcRes = await app.app.post('/api/admin/gift-cards').set('Cookie', admin).send({ valueCents: 100, count: 1 });
  const code = gcRes.body.codes[0];

  const tt = await ticketTypeId(app);
  const gcCheckout = await app.app.post('/api/orders/gift-card').set('Cookie', customer).send({
    eventId: 70103,
    items: [{ ticketTypeId: tt, quantity: 1 }],
    code
  });
  assert.equal(gcCheckout.status, 200);

  const pay = await app.app.post('/api/orders/wallet').set('Cookie', customer).send({
    eventId: 70103,
    items: [{ ticketTypeId: tt, quantity: 1 }]
  });
  assert.equal(pay.status, 409);
  assert.equal(pay.body.code, 'GIFT_CARD_APPLIED');
});

test('wallet order refund credits the customer wallet exactly once', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app);
  const admin = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);

  const dep = await app.app.post('/api/wallet/deposits').set('Cookie', customer).send({ amountCents: 100000, method: 'card' });
  await app.app.post('/webhook/stripe')
    .set('stripe-signature', 'test-signature')
    .send(walletSessionCompleted(dep.body.txnId));

  const { order } = await createPendingOrder(app, customer);
  const pay = await app.app.post('/api/orders/wallet').set('Cookie', customer).send({
    eventId: 70103,
    items: [{ ticketTypeId: (await ticketTypeId(app)), quantity: 1 }]
  });

  const balanceAfterPay = balanceOf(app, CUSTOMER_EMAIL);
  const refund = await app.app.post(`/api/admin/orders/${order.order_number}/refund`).set('Cookie', admin);
  assert.equal(refund.status, 200);
  assert.equal(refund.body.order.status, 'refunded');
  assert.equal(balanceOf(app, CUSTOMER_EMAIL), balanceAfterPay + order.total_cents);

  // Re-running the refund is idempotent and does not double-credit.
  const refundAgain = await app.app.post(`/api/admin/orders/${order.order_number}/refund`).set('Cookie', admin);
  assert.equal(refundAgain.status, 409); // order is now refunded, not paid
  assert.equal(balanceOf(app, CUSTOMER_EMAIL), balanceAfterPay + order.total_cents);
});

/* ---------------- crypto orders ---------------- */

test('crypto checkout stays PENDING; only an admin can complete it after on-chain verification', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app);
  const admin = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);

  const tt = await ticketTypeId(app);
  const res = await app.app.post('/api/orders/crypto').set('Cookie', customer).send({
    eventId: 70103,
    items: [{ ticketTypeId: tt, quantity: 1 }],
    method: 'btc'
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.requiresVerification, true);
  assert.equal(res.body.payment.address, 'bc1q82haxrn0a0utrm3usnq7ajecumvqzk453v54vu');
  const orderNumber = res.body.orderNumber;

  const order = app.db.prepare('SELECT * FROM orders WHERE order_number = ?').get(orderNumber);
  assert.equal(order.status, 'pending');
  const pendingPay = app.db.prepare(
    `SELECT * FROM payments WHERE order_id = ? AND provider = 'crypto'`
  ).get(order.id);
  assert.ok(pendingPay);
  assert.equal(pendingPay.status, 'pending');

  // Creating the crypto order again does not duplicate the payment record.
  await app.app.post('/api/orders/crypto').set('Cookie', customer).send({
    eventId: 70103,
    items: [{ ticketTypeId: tt, quantity: 1 }],
    method: 'btc'
  });
  const count = app.db.prepare(`SELECT count(*) AS c FROM payments WHERE order_id = ? AND provider = 'crypto'`)
    .get(order.id).c;
  assert.equal(count, 1);

  // The customer cannot complete it themselves.
  const asCustomer = await app.app.post(`/api/admin/orders/${orderNumber}/crypto/complete`).set('Cookie', customer);
  assert.equal(asCustomer.status, 403);
  assert.equal(app.db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'pending');

  // Admin completes after verification: order paid, tickets sold once.
  const ttId = tt;
  const before = ttRow(app, ttId);
  const complete = await app.app.post(`/api/admin/orders/${orderNumber}/crypto/complete`).set('Cookie', admin);
  assert.equal(complete.status, 200);
  assert.equal(complete.body.order.status, 'paid');
  assert.equal(complete.body.order.paymentMethod, 'btc');
  assert.equal(ttRow(app, ttId).sold_quantity, before.sold_quantity + 1);
  assert.equal(ttRow(app, ttId).reserved_quantity, before.reserved_quantity - 1);

  const completeAgain = await app.app.post(`/api/admin/orders/${orderNumber}/crypto/complete`).set('Cookie', admin);
  assert.equal(completeAgain.status, 200);
  assert.equal(completeAgain.body.idempotent, true);
  assert.equal(ttRow(app, ttId).sold_quantity, before.sold_quantity + 1);
});

test('admin order list exposes wallet and crypto deposits for reconciliation', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const customer = await cookieFor(app);
  const admin = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);

  await app.app.post('/api/wallet/deposits').set('Cookie', customer).send({ amountCents: 12345, method: 'btc' });

  const list = await app.app.get('/api/admin/wallet/deposits').set('Cookie', admin);
  assert.equal(list.status, 200);
  assert.equal(list.body.deposits.length, 1);
  assert.equal(list.body.deposits[0].amountCents, 12345);
  assert.equal(list.body.deposits[0].email, CUSTOMER_EMAIL);
  assert.equal(list.body.deposits[0].status, 'pending');

  const feed = await app.app.get('/api/admin/wallet/transactions').set('Cookie', admin);
  assert.equal(feed.status, 200);
  assert.equal(feed.body.transactions.length, 1);
  assert.equal(feed.body.transactions[0].kind, 'deposit');
});