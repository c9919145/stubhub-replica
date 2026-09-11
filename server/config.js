'use strict';

const path = require('node:path');
const fs = require('node:fs');

function parsePercentOrPercentFloat(key, def) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return def;
  return n;
}

function loadConfig(overrides = {}) {
  const env = { ...process.env, ...overrides };

  const baseUrl = (env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const isHttps = /^https:\/\//.test(baseUrl);
  const cookieSecure = env.COOKIE_SECURE !== undefined
    ? String(env.COOKIE_SECURE).toLowerCase() === 'true'
    : (env.NODE_ENV === 'production' || isHttps);

  const config = {
    nodeEnv: env.NODE_ENV || 'development',
    port: Number(env.PORT || 3000),
    baseUrl,
    isHttps,
    dbPath: env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db'),
    feeRate: parsePercentOrPercentFloat('FEE_RATE', 0.10),
    cookieSecure,
    cookieSameSite: env.COOKIE_SAME_SITE || ((env.NODE_ENV === 'production' || isHttps) ? 'none' : 'lax'),
    allowedOrigins: (env.APP_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean),
    sessionTtlHours: Number(env.SESSION_TTL_HOURS || 24),
    reservationTtlMinutes: Number(env.RESERVATION_TTL_MINUTES || 30),
    rateLimitEnabled: String(env.RATE_LIMIT_ENABLED || 'true').toLowerCase() !== 'false',
    allowSavedPaymentMethods: String(env.ENABLE_SAVED_PAYMENT_METHODS || 'false').toLowerCase() === 'true',
    stripeSecretKey: env.PAYMENT_SECRET_KEY || 'stripe_test_secret_placeholder',
    stripePublishableKey: env.PAYMENT_PUBLISHABLE_KEY || 'stripe_test_publishable_placeholder',
    stripeWebhookSecret: env.PAYMENT_WEBHOOK_SECRET || 'stripe_webhook_secret_placeholder',
    paypalClientId: env.PAYPAL_CLIENT_ID || '',
    paypalClientSecret: env.PAYPAL_CLIENT_SECRET || '',
    paypalMode: env.PAYPAL_MODE === 'live' ? 'live' : 'sandbox',
    paypalWebhookId: env.PAYPAL_WEBHOOK_ID || '',
    paypalMerchantEmail: env.PAYPAL_MERCHANT_EMAIL || '',
    giftCardDefaultLifeDays: Number(env.GIFT_CARD_DEFAULT_LIFE_DAYS || 365),
    walletBtcAddress: env.WALLET_ADDRESS_BTC || 'bc1q82haxrn0a0utrm3usnq7ajecumvqzk453v54vu',
    walletEthAddress: env.WALLET_ADDRESS_ETH || '0x814Bb1edC49Cebb9f592556333Ae3d5A626f7a60',
    adminEmail: env.ADMIN_EMAIL || 'admin@ticketvault.test',
    adminPassword: env.ADMIN_PASSWORD || 'adminpass123'
  };

  if (config.dbPath !== ':memory:') {
    const dir = path.dirname(config.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  return config;
}

module.exports = { loadConfig };