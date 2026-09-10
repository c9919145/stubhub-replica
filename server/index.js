'use strict';

const { loadConfig } = require('./config');
const { initDb } = require('./db');
const { createApp } = require('./app');
const { expireStaleReservations } = require('./orders');
const payments = require('./payments');
const paypalModule = require('./paypal');
const seed = require('./seed');

const config = loadConfig();
const db = initDb(config.dbPath);

if (db.prepare('SELECT COUNT(*) AS c FROM events').get().c === 0) {
  seed.seedEvents(db);
  seed.seedUsers(db, config);
  seed.seedGiftCards(db, config);
}

const stripe = payments.createStripeClient(config.stripeSecretKey);
const paypal = new paypalModule.PayPalClient(config);
const app = createApp(config, { db, stripe, paypal });

const server = app.listen(config.port, () => {
  console.log(`[server] listening on http://localhost:${config.port}`);
  console.log(`[server] sqlite at ${config.dbPath}`);
  if (config.stripeSecretKey.startsWith('sk_live')) {
    console.warn('[server] WARNING: Stripe LIVE key detected. Use test keys for development.');
  }
  if (!paypalModule.isConfigured(config)) {
    console.warn('[server] WARNING: PayPal is not configured (PAYPAL_CLIENT_ID/SECRET unset). PayPal checkout will be disabled.');
  }
});

/* Backstop: release reservations whose Checkout Session has expired/been abandoned. */
const CLEANER_MS = 5 * 60 * 1000;
const cleaner = setInterval(() => {
  try {
    const expired = expireStaleReservations(db, config.reservationTtlMinutes);
    if (expired.length) console.log(`[server] released ${expired.length} stale reservation(s)`);
  } catch (err) {
    console.error('[server] reservation cleaner failed:', err);
  }
}, CLEANER_MS);
cleaner.unref();

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});