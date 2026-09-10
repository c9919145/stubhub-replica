'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTestApp, login } = require('./helpers');
const { expireStaleReservations } = require('../server/orders');

async function loggedIn(app) {
  const res = await login(app);
  return res.headers['set-cookie'][0].split(';')[0];
}

test('stale pending reservations are released after the TTL', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const cookie = await loggedIn(app);

  const created = await app.app.post('/api/orders').set('Cookie', cookie)
    .send({ eventId: 70107, items: [{ ticketTypeId: 1000, quantity: 1 }] });
  assert.equal(created.status, 404);

  // Use a real ticket type for event 70107.
  const evt = await app.app.get('/api/events/70107');
  const tt = evt.body.ticketTypes[0];
  const order = await app.app.post('/api/orders').set('Cookie', cookie)
    .send({ eventId: 70107, items: [{ ticketTypeId: tt.id, quantity: 2 }] });
  assert.equal(order.status, 200);

  assert.equal(
    app.db.prepare('SELECT reserved_quantity FROM ticket_types WHERE id = ?').get(tt.id).reserved_quantity,
    2
  );

  // Age the reservation beyond the TTL by rewriting created_at.
  app.db.prepare(
    "UPDATE orders SET created_at = datetime('now', '-91 minutes') WHERE order_number = ?"
  ).run(order.body.orderNumber);

  const expired = expireStaleReservations(app.db, 90);
  assert.deepEqual(expired, [order.body.orderNumber]);

  const updated = app.db.prepare('SELECT status FROM orders WHERE order_number = ?').get(order.body.orderNumber);
  assert.equal(updated.status, 'expired');
  assert.equal(
    app.db.prepare('SELECT reserved_quantity FROM ticket_types WHERE id = ?').get(tt.id).reserved_quantity,
    0
  );
});

test('fresh reservations are not expired', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());
  const cookie = await loggedIn(app);

  const evt = await app.app.get('/api/events/70109');
  const tt = evt.body.ticketTypes[0];
  await app.app.post('/api/orders').set('Cookie', cookie)
    .send({ eventId: 70109, items: [{ ticketTypeId: tt.id, quantity: 1 }] });

  assert.deepEqual(expireStaleReservations(app.db, 90), []);
});