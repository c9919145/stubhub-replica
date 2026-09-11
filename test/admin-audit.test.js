'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTestApp, login, ticketTypeId, ADMIN_EMAIL, ADMIN_PASSWORD } = require('./helpers');

async function loginAs(app, email, password) {
  const res = await login(app, email, password);
  return res.headers['set-cookie'][0].split(';')[0];
}

test('audit log endpoint requires admin access', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());

  assert.equal((await app.app.get('/api/admin/audit')).status, 401);

  const customer = await loginAs(app, 'customer@ticketvault.test', 'password123');
  const asCustomer = await app.app.get('/api/admin/audit').set('Cookie', customer);
  assert.equal(asCustomer.status, 403);
});

test('admin logins and failed logins are recorded in the audit log', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());

  const fail = await login(app, ADMIN_EMAIL, 'wrong-password-123');
  assert.equal(fail.status, 401);

  const admin = await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD);
  const list = await app.app.get('/api/admin/audit').set('Cookie', admin);
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body.entries));

  const actions = list.body.entries.map(e => e.action);
  assert.ok(actions.includes('admin.login'));
  assert.ok(actions.includes('admin.login.failed'));
  assert.ok(list.body.entries.every(e => e.admin_email === ADMIN_EMAIL));
});

test('refund and gift card admin actions are audited', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const admin = await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD);

  // Create a paid order, then refund it.
  const custRes = await login(app, 'customer@ticketvault.test', 'password123');
  const customer = custRes.headers['set-cookie'][0].split(';')[0];
  const std = await ticketTypeId(app, 70103, 'Standard');
  const created = await app.app.post('/api/orders').set('Cookie', customer)
    .send({ eventId: 70103, items: [{ ticketTypeId: std, quantity: 1 }] });
  app.db.prepare(`UPDATE orders SET status = 'paid', payment_intent_id = 'pi_test_audit' WHERE order_number = ?`)
    .run(created.body.orderNumber);
  const refund = await app.app.post('/api/admin/orders/' + created.body.orderNumber + '/refund').set('Cookie', admin);
  assert.equal(refund.status, 200);

  // Create a gift card.
  const gc = await app.app.post('/api/admin/gift-cards').set('Cookie', admin)
    .send({ valueCents: 2500, count: 2 });
  assert.equal(gc.status, 201);

  const list = await app.app.get('/api/admin/audit').set('Cookie', admin);
  const actions = list.body.entries.map(e => e.action);
  assert.ok(actions.includes('order.refund'));
  assert.ok(actions.includes('giftcard.create'));
  assert.ok(actions.includes('admin.login'));
});

test('gift card creation validates count and expiresAt', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const admin = await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD);

  const badCount = await app.app.post('/api/admin/gift-cards').set('Cookie', admin)
    .send({ valueCents: 1000, count: 0 });
  assert.equal(badCount.status, 400);

  const badDate = await app.app.post('/api/admin/gift-cards').set('Cookie', admin)
    .send({ valueCents: 1000, count: 1, expiresAt: 'tomorrow' });
  assert.equal(badDate.status, 400);

  const good = await app.app.post('/api/admin/gift-cards').set('Cookie', admin)
    .send({ valueCents: 1000, count: 1, expiresAt: '2030-12-31' });
  assert.equal(good.status, 201);
});

test('API responses ship security headers', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());

  const res = await app.app.get('/api/health');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  assert.match(res.headers['referrer-policy'], /strict-origin-when-cross-origin/);
  assert.ok(res.headers['content-security-policy']);
  assert.ok(res.headers['permissions-policy']);
});