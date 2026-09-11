'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { loadConfig } = require('../server/config');
const { initDb } = require('../server/db');
const { createApp } = require('../server/app');
const seed = require('../server/seed');
const supertest = require('supertest');

const ADMIN_EMAIL = 'admin@ticketvault.test';
const ADMIN_PASSWORD = 'adminpass123';
const CUSTOMER_EMAIL = 'customer@ticketvault.test';
const CUSTOMER_PASSWORD = 'password123';
const MOCK_WEBHOOK_SECRET = 'whsec_test_secret';

function cleanupDbFiles(dbPath) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { fs.rmSync(dbPath + suffix, { force: true }); } catch (e) { /* ignore */ }
  }
}

function createTestApp(opts = {}) {
  const dbPath = path.join(os.tmpdir(), `ticketvault-test-${process.pid}-${crypto.randomBytes(6).toString('hex')}.db`);
  const config = loadConfig({
    NODE_ENV: 'test',
    DB_PATH: dbPath,
    RATE_LIMIT_ENABLED: 'false',
    PAYMENT_SECRET_KEY: 'stripe_test_secret_x',
    PAYMENT_PUBLISHABLE_KEY: 'stripe_test_publishable_x',
    PAYMENT_WEBHOOK_SECRET: MOCK_WEBHOOK_SECRET,
    PAYPAL_CLIENT_ID: 'test-client-id',
    PAYPAL_CLIENT_SECRET: 'test-client-secret',
    PAYPAL_MODE: 'sandbox',
    PAYPAL_WEBHOOK_ID: 'test-webhook-id',
    BASE_URL: 'http://localhost:3000',
    ...(opts.env || {})
  });
  const db = initDb(dbPath);
  seed.seedEvents(db);
  seed.seedUsers(db, config);
  const stripe = opts.stripe || createStripeMock();
  const paypal = opts.paypal || createPayPalMock();
  const app = createApp(config, { db, stripe, paypal });
  return {
    app: supertest(app),
    rawApp: app,
    db,
    config,
    stripe,
    paypal,
    dbPath,
    close() { closeDb(db, dbPath); }
  };
}

function closeDb(db, dbPath) {
  try { db.close(); } catch (e) { /* ignore */ }
  cleanupDbFiles(dbPath);
}

/**
 * Minimal Stripe client stand-in. `checkout.sessions.create` returns a fake
 * redirect URL; `webhooks.constructEvent` parses the raw JSON payload so the
 * webhook HTTP route works end-to-end in tests.
 */
function createStripeMock(opts = {}) {
  let counter = 0;
  const created = [];
  const refunded = [];
  return {
    checkout: {
      sessions: {
        create: async (params) => {
          counter += 1;
          created.push(params);
          if (opts.sessionCreate) return opts.sessionCreate(params, counter);
          return { id: `cs_test_${counter}`, url: `https://pay.ticketvault.test/c/${counter}` };
        }
      }
    },
    refunds: {
      create: async (params) => {
        const id = `re_test_${counter++}`;
        refunded.push({ id, ...params });
        return { id };
      }
    },
    webhooks: {
      constructEvent: (payload, signature) => {
        if (signature === 'bad-signature' || opts.invalidSignature) {
          throw new Error('Stripe signature verification failed');
        }
        return JSON.parse(payload.toString('utf8'));
      }
    },
    _created: created,
    _refunded: refunded
  };
}

/**
 * Minimal PayPal client stand-in. `createOrder` returns a fake approve URL,
 * `verifyWebhookSignature` accepts well-formed transmission headers so the
 * /webhook/paypal route works end-to-end in tests.
 */
function createPayPalMock(opts = {}) {
  let orderCounter = 0;
  let captureCounter = 0;
  const created = [];
  const captured = [];
  return {
    createOrder: async (params) => {
      orderCounter += 1;
      created.push(params);
      if (opts.createOrder) return opts.createOrder(params, orderCounter);
      return { id: `PAY-${orderCounter}`, status: 'CREATED', approveUrl: `https://paypal.ticketvault.test/approve/${orderCounter}` };
    },
    captureOrder: async (orderId) => {
      captureCounter += 1;
      const capturedRow = { orderId };
      if (opts.captureOrder) {
        const out = opts.captureOrder(orderId, captureCounter);
        capturedRow.captureId = out && out.purchase_units && out.purchase_units[0].payments.captures[0].id;
        captured.push(capturedRow);
        return out;
      }
      const captureId = `CAP-${captureCounter}`;
      capturedRow.captureId = captureId;
      captured.push(capturedRow);
      return {
        id: orderId,
        status: 'COMPLETED',
        purchase_units: [{ payments: { captures: [{ id: captureId }] } }]
      };
    },
    refundCapture: async (captureId) => {
      if (opts.refundCapture) return opts.refundCapture(captureId);
      return { id: `REF-${captureId}`, status: 'COMPLETED' };
    },
    verifyWebhookSignature: async ({ headers }) => {
      if (opts.invalidSignature || !headers['paypal-transmission-id']) {
        throw new Error('PayPal signature verification failed');
      }
      return true;
    },
    _created: created,
    _captured: captured
  };
}

function makeEvent(eventId, type, object) {
  return { id: eventId, type, data: { object } };
}

function checkoutSessionCompleted({ orderNumber, paymentIntent, paymentStatus = 'paid', sessionId = 'cs_test_completed' }) {
  return makeEvent('evt_completed_' + Math.random(), 'checkout.session.completed', {
    id: sessionId,
    client_reference_id: orderNumber,
    payment_status: paymentStatus,
    payment_intent: paymentIntent,
    metadata: { order_number: orderNumber }
  });
}

function checkoutSessionExpired(orderNumber) {
  return makeEvent('evt_expired_' + Math.random(), 'checkout.session.expired', {
    id: 'cs_test_expired',
    client_reference_id: orderNumber,
    metadata: { order_number: orderNumber }
  });
}

function paymentIntentSucceeded(orderNumber, paymentIntent = 'pi_test_' + Math.random()) {
  return makeEvent('evt_pi_success_' + Math.random(), 'payment_intent.succeeded', {
    id: paymentIntent,
    metadata: { order_number: orderNumber }
  });
}

function paymentIntentFailed(orderNumber) {
  return makeEvent('evt_pi_failed_' + Math.random(), 'payment_intent.payment_failed', {
    id: 'pi_test_failed',
    metadata: { order_number: orderNumber },
    last_payment_error: { message: 'card_declined' }
  });
}

function paymentIntentCanceled(orderNumber) {
  return makeEvent('evt_pi_cancelled_' + Math.random(), 'payment_intent.canceled', {
    id: 'pi_test_cancelled',
    metadata: { order_number: orderNumber }
  });
}

function chargeRefunded(paymentIntent) {
  return makeEvent('evt_refund_' + Math.random(), 'charge.refunded', {
    id: 'ch_test_refund',
    payment_intent: paymentIntent
  });
}

async function register(t, email, password, name) {
  const res = await t.app.post('/api/auth/register')
    .send({ email: email || `u${Math.random()}@test.dev`, password: password || 'password123', name });
  return res;
}

async function login(t, email = CUSTOMER_EMAIL, password = CUSTOMER_PASSWORD) {
  return t.app.post('/api/auth/login').send({ email, password });
}

/** Returns the id of a real ticket type for an event (default: Standard tier). */
async function ticketTypeId(t, eventId = 70103, name = 'Standard') {
  const res = await t.app.get('/api/events/' + eventId);
  if (res.status !== 200) throw new Error('Could not load event ' + eventId);
  const tt = res.body.ticketTypes.find(x => x.name === name) || res.body.ticketTypes[0];
  if (!tt) throw new Error('No ticket types for event ' + eventId);
  return tt.id;
}

module.exports = {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  CUSTOMER_EMAIL,
  CUSTOMER_PASSWORD,
  MOCK_WEBHOOK_SECRET,
  createTestApp,
  cleanupDbFiles,
  createStripeMock,
  createPayPalMock,
  makeEvent,
  checkoutSessionCompleted,
  checkoutSessionExpired,
  paymentIntentSucceeded,
  paymentIntentFailed,
  paymentIntentCanceled,
  chargeRefunded,
  register,
  login,
  ticketTypeId
};