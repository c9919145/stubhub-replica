'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTestApp, login, ticketTypeId } = require('./helpers');

async function loggedIn(app) {
  const res = await login(app);
  return res.headers['set-cookie'][0].split(';')[0];
}

test('checkout requires authentication', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const res = await app.app.post('/api/orders').send({ eventId: 70103, items: [{ ticketTypeId: 1, quantity: 1 }] });
  assert.equal(res.status, 401);
});

test('creating an order reserves inventory and returns a checkout URL', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const cookie = await loggedIn(app);

  const std = await ticketTypeId(app, 70103, 'Standard');
  const prem = await ticketTypeId(app, 70103, 'Premium');

  const res = await app.app.post('/api/orders')
    .set('Cookie', cookie)
    .send({ eventId: 70103, items: [{ ticketTypeId: std, quantity: 2 }, { ticketTypeId: prem, quantity: 1 }] });

  assert.equal(res.status, 200);
  assert.ok(res.body.orderNumber.startsWith('SH-'));
  assert.ok(res.body.checkoutUrl.includes('pay.stubhub.test'));

  const evt = await app.app.get('/api/events/70103');
  const standard = evt.body.ticketTypes.find(x => x.name === 'Standard');
  const premium = evt.body.ticketTypes.find(x => x.name === 'Premium');
  assert.equal(standard.available, 118);
  assert.equal(premium.available, 59);
});

test('prices are computed server-side and client prices are ignored', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const cookie = await loggedIn(app);

  const evt = await app.app.get('/api/events/70103');
  const std = evt.body.ticketTypes.find(x => x.name === 'Standard');
  const price = std.priceCents;

  const res = await app.app.post('/api/orders')
    .set('Cookie', cookie)
    .send({ eventId: 70103, items: [{ ticketTypeId: std.id, quantity: 2, unitPriceCents: 1 }] });

  assert.equal(res.status, 200);
  const order = await app.app.get('/api/orders/' + res.body.orderNumber).set('Cookie', cookie);
  assert.equal(order.status, 200);
  assert.equal(order.body.order.subtotalCents, price * 2);
  assert.equal(order.body.order.items[0].unitPriceCents, price);
  assert.equal(order.body.order.feesCents, Math.round(price * 2 * 0.10));
  assert.equal(order.body.order.totalCents, price * 2 + Math.round(price * 2 * 0.10));
});

test('repeat checkout for the same event reuses the pending order (no double reservation)', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const cookie = await loggedIn(app);
  const std = await ticketTypeId(app, 70103, 'Standard');
  const payload = { eventId: 70103, items: [{ ticketTypeId: std, quantity: 1 }] };

  const first = await app.app.post('/api/orders').set('Cookie', cookie).send(payload);
  const second = await app.app.post('/api/orders').set('Cookie', cookie).send(payload);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.orderNumber, second.body.orderNumber);

  const evt = await app.app.get('/api/events/70103');
  assert.equal(evt.body.ticketTypes.find(x => x.name === 'Standard').available,
    app.db.prepare('SELECT total_quantity AS total FROM ticket_types WHERE event_id = 70103 AND name = ?').get('Standard').total - 1);
});

test('cannot order more tickets than are available', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const cookie = await loggedIn(app);

  const std = await ticketTypeId(app, 70103, 'Standard');
  // Shrink inventory so the oversell request stays under the per-item cap of 16.
  app.db.prepare('UPDATE ticket_types SET total_quantity = 5 WHERE id = ?').run(std);

  const res = await app.app.post('/api/orders')
    .set('Cookie', cookie)
    .send({ eventId: 70103, items: [{ ticketTypeId: std, quantity: 10 }] });

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'INSUFFICIENT_INVENTORY');
});

test('rejects invalid payloads and ticket types that belong to another event', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const cookie = await loggedIn(app);

  const noItems = await app.app.post('/api/orders').set('Cookie', cookie).send({ eventId: 70103, items: [] });
  assert.equal(noItems.status, 400);

  const crossEvent = await app.app.post('/api/orders').set('Cookie', cookie)
    .send({ eventId: 70103, items: [{ ticketTypeId: 1000, quantity: 1 }] });
  assert.equal(crossEvent.status, 404);

  const missingEvent = await app.app.post('/api/orders').set('Cookie', cookie).send({ eventId: 99999, items: [{ ticketTypeId: 1, quantity: 1 }] });
  assert.equal(missingEvent.status, 404);
});

test('orders are only visible to their owner', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());

  const owner = await login(app);
  const other = await app.app.post('/api/auth/register')
    .send({ email: 'other@user.dev', password: 'supersecret1', name: 'Other' });
  const ownerCookie = owner.headers['set-cookie'][0].split(';')[0];
  const otherCookie = other.headers['set-cookie'][0].split(';')[0];
  const std = await ticketTypeId(app, 70103, 'Standard');

  const created = await app.app.post('/api/orders').set('Cookie', ownerCookie)
    .send({ eventId: 70103, items: [{ ticketTypeId: std, quantity: 1 }] });

  const theirs = await app.app.get('/api/orders/' + created.body.orderNumber).set('Cookie', ownerCookie);
  assert.equal(theirs.status, 200);

  const notMine = await app.app.get('/api/orders/' + created.body.orderNumber).set('Cookie', otherCookie);
  assert.equal(notMine.status, 404);
});

test('pending orders can be retried with a fresh session URL', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const cookie = await loggedIn(app);
  const std = await ticketTypeId(app, 70103, 'Standard');

  const created = await app.app.post('/api/orders').set('Cookie', cookie)
    .send({ eventId: 70103, items: [{ ticketTypeId: std, quantity: 1 }] });

  const retry = await app.app.post('/api/orders/' + created.body.orderNumber + '/retry').set('Cookie', cookie);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.orderNumber, created.body.orderNumber);
  assert.ok(retry.body.checkoutUrl);
});

test('retrying a paid order is rejected', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const cookie = await loggedIn(app);
  const std = await ticketTypeId(app, 70103, 'Standard');

  const created = await app.app.post('/api/orders').set('Cookie', cookie)
    .send({ eventId: 70103, items: [{ ticketTypeId: std, quantity: 1 }] });

  // Simulate a successful payment so the order is now paid.
  app.db.prepare(`UPDATE orders SET status = 'paid' WHERE order_number = ?`).run(created.body.orderNumber);

  const retry = await app.app.post('/api/orders/' + created.body.orderNumber + '/retry').set('Cookie', cookie);
  assert.equal(retry.status, 409);
});