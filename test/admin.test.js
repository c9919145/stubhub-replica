'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTestApp, login, ticketTypeId, ADMIN_EMAIL, ADMIN_PASSWORD } = require('./helpers');

async function loginAs(app, email, password) {
  const res = await login(app, email, password);
  return res.headers['set-cookie'][0].split(';')[0];
}

async function cookieFor(app, email, password) {
  return loginAs(app, email, password);
}

test('admin orders list requires authentication then admin role', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());

  assert.equal((await app.app.get('/api/admin/orders')).status, 401);

  const customer = await cookieFor(app, 'customer@ticketvault.test', 'password123');
  const asCustomer = await app.app.get('/api/admin/orders').set('Cookie', customer);
  assert.equal(asCustomer.status, 403);

  const admin = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
  const asAdmin = await app.app.get('/api/admin/orders').set('Cookie', admin);
  assert.equal(asAdmin.status, 200);
  assert.ok(Array.isArray(asAdmin.body.orders));
});

test('admin can refund a paid order; double refund is rejected', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const admin = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);

  // Seed a paid order directly.
  const custRes = await app.app.post('/api/auth/login').send({ email: 'customer@ticketvault.test', password: 'password123' });
  const customer = custRes.headers['set-cookie'][0].split(';')[0];
  const std = await ticketTypeId(app, 70103, 'Standard');
  const created = await app.app.post('/api/orders').set('Cookie', customer)
    .send({ eventId: 70103, items: [{ ticketTypeId: std, quantity: 1 }] });
  app.db.prepare(`UPDATE orders SET status = 'paid', payment_intent_id = 'pi_test_admin_refund' WHERE order_number = ?`)
    .run(created.body.orderNumber);

  const refund = await app.app.post('/api/admin/orders/' + created.body.orderNumber + '/refund').set('Cookie', admin);
  assert.equal(refund.status, 200);
  assert.equal(refund.body.order.status, 'refunded');

  const again = await app.app.post('/api/admin/orders/' + created.body.orderNumber + '/refund').set('Cookie', admin);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'ORDER_NOT_REFUNDABLE');
});

test('refund is rejected on unpaid orders and for non-admins', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());

  const customer = await cookieFor(app, 'customer@ticketvault.test', 'password123');
  const admin = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);

  const std = await ticketTypeId(app, 70103, 'Standard');
  const created = await app.app.post('/api/orders').set('Cookie', customer)
    .send({ eventId: 70103, items: [{ ticketTypeId: std, quantity: 1 }] });

  const asCustomer = await app.app.post('/api/admin/orders/' + created.body.orderNumber + '/refund').set('Cookie', customer);
  assert.equal(asCustomer.status, 403);

  const notPaid = await app.app.post('/api/admin/orders/' + created.body.orderNumber + '/refund').set('Cookie', admin);
  assert.equal(notPaid.status, 409);
  assert.equal(notPaid.body.code, 'ORDER_NOT_REFUNDABLE');
});

test('admin list exposes ticket events and amounts without card data', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const admin = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);

  const customer = await cookieFor(app, 'customer@ticketvault.test', 'password123');
  const std = await ticketTypeId(app, 70103, 'Standard');
  await app.app.post('/api/orders').set('Cookie', customer)
    .send({ eventId: 70103, items: [{ ticketTypeId: std, quantity: 2 }] });

  const list = await app.app.get('/api/admin/orders').set('Cookie', admin);
  assert.equal(list.status, 200);
  const row = list.body.orders.find(o => o.tickets && o.tickets.includes('Matt Rife'));
  assert.ok(row);
  assert.equal(row.total_cents, row.subtotal_cents + row.fees_cents);
  assert.ok(row.subtotal_cents > 0);
  assert.equal(row.payment_status, null); // no payment row yet (still pending)
});