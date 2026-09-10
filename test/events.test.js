'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTestApp } = require('./helpers');

test('GET /api/events lists seeded events with server-computed availability', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());

  const res = await app.app.get('/api/events');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.events));
  assert.ok(res.body.events.length >= 50);

  // Matt Rife event 70112 is seeded as sold out -> 0 available
  const soldOut = res.body.events.find(e => e.id === 70112);
  assert.ok(soldOut);
  assert.equal(soldOut.availableTickets, 0);

  const normal = res.body.events.find(e => e.id === 70103);
  assert.ok(normal);
  assert.equal(normal.availableTickets, 210); // 120 + 60 + 30
});

test('GET /api/events/:id returns event + ticket types with prices and availability', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());

  const res = await app.app.get('/api/events/70103');
  assert.equal(res.status, 200);
  assert.equal(res.body.event.name, 'Matt Rife');
  assert.equal(res.body.ticketTypes.length, 3);
  assert.deepEqual(res.body.ticketTypes.map(x => x.available), [120, 60, 30]);
  assert.ok(res.body.ticketTypes[0].priceCents > 0);

  assert.equal((await app.app.get('/api/events/999999')).status, 404);
  assert.equal((await app.app.get('/api/events/abc')).status, 400);
});

test('client-side price preferences do not leak into the API surface', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());

  const res = await app.app.post('/api/orders').send({ eventId: 70103, items: [{ ticketTypeId: '1', quantity: 'abc' }] });
  assert.notEqual(res.status, 200);
});