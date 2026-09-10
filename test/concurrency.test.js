'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const path = require('node:path');

const { createTestApp } = require('./helpers');

const WORKER = path.join(__dirname, 'fixtures', 'reserve-worker.js');
const GIFT_WORKER = path.join(__dirname, 'fixtures', 'giftcard-worker.js');

test('concurrent reservations cannot oversell the last ticket', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());

  // Top up: make exactly 1 ticket available for worker contention.
  const eventId = 70105;
  const evt = await app.app.get('/api/events/' + eventId);
  const tt = evt.body.ticketTypes[0];
  app.db.prepare('UPDATE ticket_types SET total_quantity = 1, sold_quantity = 0, reserved_quantity = 0 WHERE id = ?').run(tt.id);

  const customer = app.db.prepare('SELECT id, email FROM users WHERE email = ?').get('customer@stubhub.test');

  const runWorker = () => new Promise((resolve) => {
    const w = new Worker(WORKER, {
      workerData: {
        dbPath: app.dbPath,
        orderFilePath: path.join(__dirname, '..', 'server', 'orders.js'),
        dbFilePath: path.join(__dirname, '..', 'server', 'db.js'),
        userId: customer.id,
        userEmail: customer.email,
        eventId,
        ticketTypeId: tt.id
      }
    });
    w.on('message', resolve);
    w.on('error', (err) => resolve({ ok: false, code: 'worker_error', message: err.message }));
  });

  const results = await Promise.all([runWorker(), runWorker()]);
  const successes = results.filter(r => r.ok).length;
  const conflicts = results.filter(r => !r.ok && r.code === 'INSUFFICIENT_INVENTORY').length;

  assert.equal(results.length, 2);
  assert.equal(successes, 1, JSON.stringify(results));
  assert.equal(conflicts, 1, JSON.stringify(results));

  const after = app.db.prepare('SELECT total_quantity, sold_quantity, reserved_quantity FROM ticket_types WHERE id = ?').get(tt.id);
  assert.equal(after.reserved_quantity, 1);
  assert.equal(after.sold_quantity, 0);
});
test('concurrent gift card applies cannot overspend a card', async (t) => {
  const app = createTestApp();
  t.after(() => app.close());

  // Make 2 tickets available so only the gift-card hold is the contention point.
  const eventId = 70103;
  const evt = await app.app.get('/api/events/' + eventId);
  const tt = evt.body.ticketTypes.find(x => x.name === 'Standard') || evt.body.ticketTypes[0];
  app.db.prepare('UPDATE ticket_types SET total_quantity = 2, sold_quantity = 0, reserved_quantity = 0 WHERE id = ?').run(tt.id);

  // Create a gift card worth exactly one order so only one hold can win.
  const price = app.db.prepare('SELECT price_cents FROM ticket_types WHERE id = ?').get(tt.id).price_cents;
  const feeRate = app.config.feeRate;
  const total = price + Math.round(price * feeRate);
  const adminLogin = await (await app.app.post('/api/auth/login').send({ email: 'admin@stubhub.test', password: 'adminpass123' }));
  const admin = adminLogin.headers['set-cookie'][0].split(';')[0];
  const gc = await app.app.post('/api/admin/gift-cards').set('Cookie', admin).send({ valueCents: total, count: 1 });
  const code = gc.body.codes[0];

  const customer = app.db.prepare('SELECT id, email FROM users WHERE email = ?').get('customer@stubhub.test');

  const runWorker = () => new Promise((resolve) => {
    const w = new Worker(GIFT_WORKER, {
      workerData: {
        dbPath: app.dbPath,
        orderFilePath: path.join(__dirname, '..', 'server', 'orders.js'),
        dbFilePath: path.join(__dirname, '..', 'server', 'db.js'),
        userId: customer.id,
        userEmail: customer.email,
        eventId,
        ticketTypeId: tt.id,
        feeRate,
        giftCardCode: code
      }
    });
    w.on('message', resolve);
    w.on('error', (err) => resolve({ ok: false, code: 'worker_error', message: err.message }));
  });

  const results = await Promise.all([runWorker(), runWorker()]);
  const successes = results.filter(r => r.ok).length;
  const conflicts = results.filter(r => !r.ok && r.code === 'INSUFFICIENT_GIFT_BALANCE').length;

  assert.equal(results.length, 2, JSON.stringify(results));
  assert.equal(successes, 1, JSON.stringify(results));
  assert.equal(conflicts, 1, JSON.stringify(results));

  const gcRow = app.db.prepare('SELECT original_value_cents, redeemed_cents, held_cents FROM gift_cards WHERE original_value_cents = ?').get(total);
  assert.equal(gcRow.held_cents, total);
  assert.equal(gcRow.original_value_cents - gcRow.redeemed_cents - gcRow.held_cents, 0);
});
