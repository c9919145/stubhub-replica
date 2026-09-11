'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('node:path');

const auth = require('./auth');
const audit = require('./audit');
const wallet = require('./wallet');
const { AppError, createOrder, createOrApplyGiftCard, completeOrderPayment, completeOrderWithWallet, findPendingOrderForEvent, getOrderByNumber, serializeOrder, listOrdersForUser, listAllOrders, markRefunded, failOrder, hasAnyPayment, hasPendingPayment } = require('./orders');
const payments = require('./payments');
const giftcards = require('./giftcards');
const { PayPalClient, isConfigured } = require('./paypal');

const ROOT = path.join(__dirname, '..');

const BLOCKED_STATIC = /^\/(?:server|test|node_modules|data)(\/|$)|^\/\.env|^\/package(?:-lock)?\.json$/;

function safeInt(value, errMsg) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, 'INVALID_ID', errMsg || 'Invalid id');
  return n;
}

/* Express 4 does not forward async rejections to error middleware. */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * Applies a verified PayPal webhook event to the DB. Idempotent per PayPal
 * event id (webhook_events). Focused on the events we care about.
 */
function handlePayPalEvent(db, event) {
  const type = event.event_type;
  if (!type) return { ignored: true, reason: 'missing event_type' };
  const resource = event.resource || {};

  switch (type) {
    case 'PAYMENT.CAPTURE.COMPLETED': {
      const orderNumber = resource.custom_id;
      if (!orderNumber) return { ignored: true, reason: 'missing order reference' };
      const captureId = resource.id;
      const captureCents = resource.amount
        ? Math.round(Number(resource.amount.value) * 100)
        : null;
      const result = completeOrderPayment(db, {
        webhookEventId: event.id,
        orderNumber,
        provider: 'paypal',
        providerPaymentId: captureId,
        paidCents: captureCents,
        eventType: 'paypal.capture.completed'
      });
      return { ...result };
    }

    case 'PAYMENT.CAPTURE.DENIED':
    case 'PAYMENT.CAPTURE.FAILED': {
      const orderNumber = resource.custom_id;
      if (!orderNumber) return { ignored: true, reason: 'missing order reference' };
      const result = failOrder(db, event.id, orderNumber, 'PayPal capture denied', 'paypal');
      return { ...result };
    }

    case 'PAYMENT.CAPTURE.REFUNDED':
    case 'PAYMENT.CAPTURE.REVERSED': {
      const captureId = resource.id;
      if (!captureId) return { ignored: true, reason: 'missing capture reference' };
      const result = markRefunded(db, event.id, captureId);
      return { ...result };
    }

    case 'CHECKOUT.ORDER.APPROVED':
      // Approval alone is not a payment; capture is handled by the API flow.
      return { ignored: true, reason: 'order approved, waiting for capture' };

    default:
      return { ignored: true, reason: `unhandled event type ${type}` };
  }
}

function createApp(config, deps) {
  const db = deps.db;
  const stripe = deps.stripe || payments.createStripeClient(config.stripeSecretKey);
  const paypal = deps.paypal || new PayPalClient(config);
  const app = express();
  app.disable('x-powered-by');

  /* ---------- security headers ---------- */
  // Pragmatic CSP keeps the existing static frontend intact (inline styles and
  // onclick handlers in the markup), while restricting external origins to the
  // Google Fonts and image hosts the pages actually use.
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: https:",
        "connect-src 'self'",
        "frame-ancestors 'self'",
        "base-uri 'self'",
        "form-action 'self'"
      ].join('; ')
    });
    if (config.isHttps || config.cookieSecure) {
      res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  /* ---------- rate limiting (skip in test / when disabled) ---------- */
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.rateLimitEnabled === false ? 100000 : 20,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: 'Too many attempts. Please try again shortly.' })
  });
  const adminLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: config.rateLimitEnabled === false ? 100000 : 40,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: 'Too many admin actions. Please try again shortly.' })
  });
  const limiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: config.rateLimitEnabled === false ? 100000 : 60,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: 'Too many requests. Please try again shortly.' })
  });
  const orderLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: config.rateLimitEnabled === false ? 100000 : 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: 'Too many orders. Please try again shortly.' })
  });
  const walletLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: config.rateLimitEnabled === false ? 100000 : 20,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: 'Too many wallet requests. Please try again shortly.' })
  });
  const giftCardLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: config.rateLimitEnabled === false ? 100000 : 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: 'Too many gift card attempts. Please try again shortly.' })
  });

  /* ---------- auth middleware ---------- */
  function requireAuth(req, res, next) {
    const user = auth.getUserBySession(db, req.cookies && req.cookies.sid);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    req.user = user;
    next();
  }

  function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
      if (!req.user.is_admin) return res.status(403).json({ error: 'Admin access required' });
      next();
    });
  }

  function setSessionCookie(res, token) {
    res.cookie('sid', token, {
      httpOnly: true,
      sameSite: config.cookieSameSite,
      secure: config.cookieSecure,
      maxAge: config.sessionTtlHours * 3600 * 1000,
      path: '/'
    });
  }

  /* ---------- CORS: allow the static GitHub Pages frontend to reach this API
     cross-origin when APP_ORIGIN is configured (e.g. https://c9919145.github.io). ---------- */
  app.set('trust proxy', config.nodeEnv === 'production' ? 1 : false);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  /* ---------- webhook (raw body, route registered before express.json) ---------- */
  app.post('/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
    const signature = req.headers['stripe-signature'];
    if (!signature) return res.status(400).json({ error: 'Missing Stripe signature' });
    const event = payments.verifyWebhookSignature(config, stripe, req.body, signature);
    const result = payments.handleStripeEvent(db, event);
    return res.status(200).json({ received: true, ...result });
  });

  app.post('/webhook/paypal', express.raw({ type: 'application/json' }), asyncHandler(async (req, res) => {
    const eventBody = req.body;
    const event = JSON.parse(eventBody.toString('utf8'));
    await paypal.verifyWebhookSignature({ eventBody, headers: req.headers });
    const result = handlePayPalEvent(db, event);
    return res.status(200).json({ received: true, ...result });
  }));

  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  /* ---------- public ---------- */
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.get('/api/events', (req, res) => {
    const events = db.prepare(
      `SELECT e.id, e.name, e.performer, e.venue, e.city, e.date, e.category, e.subcategory, e.image_url,
              MIN(tt.price_cents) AS min_price_cents,
              COALESCE(SUM(MAX(0, tt.total_quantity - tt.sold_quantity - tt.reserved_quantity)), 0) AS available_tickets
         FROM events e
         LEFT JOIN ticket_types tt ON tt.event_id = e.id
        GROUP BY e.id
        ORDER BY e.id`
    ).all().map(r => ({
      id: r.id,
      name: r.name,
      performer: r.performer,
      venue: r.venue,
      city: r.city,
      date: r.date,
      category: r.category,
      subcategory: r.subcategory,
      imageUrl: r.image_url,
      minPriceCents: r.min_price_cents,
      availableTickets: Math.max(0, Number(r.available_tickets) || 0)
    }));
    res.json({ events });
  });

  app.get('/api/events/:id', (req, res) => {
    const eventId = safeInt(req.params.id, 'Invalid event id');
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const ticketTypes = db.prepare(
      `SELECT id, name, description, price_cents AS priceCents,
              total_quantity AS totalQuantity,
              MAX(0, total_quantity - sold_quantity - reserved_quantity) AS available,
              sold_quantity AS soldQuantity
         FROM ticket_types WHERE event_id = ? ORDER BY price_cents ASC`
    ).all(eventId);
    res.json({ event: { ...event, imageUrl: event.image_url }, ticketTypes });
  });

  /* ---------- auth ---------- */
  app.post('/api/auth/register', authLimiter, (req, res) => {
    const { email, name, password, firstName, lastName } = req.body || {};
    const normalized = String(email || '').trim().toLowerCase();
    const pw = String(password || '');
    // The membership form sends firstName/lastName; the API also accepts a single `name`.
    const displayName = [firstName, lastName, name]
      .map(v => String(v || '').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new AppError(400, 'INVALID_EMAIL', 'A valid email is required');
    if (pw.length < 8) throw new AppError(400, 'WEAK_PASSWORD', 'Password must be at least 8 characters');
    if (!displayName) throw new AppError(400, 'INVALID_NAME', 'Your name is required');
    if (displayName.length > 80) throw new AppError(400, 'INVALID_NAME', 'Name is too long');

    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(normalized)) {
      throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
    }

    const passwordHash = auth.hashPassword(pw);
    const res2 = db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)')
      .run(normalized, displayName || null, passwordHash);
    const userId = Number(res2.lastInsertRowid);
    const token = auth.createSession(db, userId, config.sessionTtlHours);
    setSessionCookie(res, token);
    const user = db.prepare('SELECT id, email, name, is_admin FROM users WHERE id = ?').get(userId);
    res.status(201).json({ user: auth.getPublicUser(user) });
  });

  app.post('/api/auth/login', authLimiter, (req, res) => {
    const { email, password } = req.body || {};
    const normalized = String(email || '').trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalized);
    if (!user || !auth.verifyPassword(password, user.password_hash)) {
      if (user && user.is_admin) {
        audit.logAudit(db, {
          adminUserId: user.id,
          adminEmail: user.email,
          action: 'admin.login.failed',
          target: user.email,
          details: 'Incorrect password',
          ip: req.ip
        });
      }
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }
    const token = auth.createSession(db, user.id, config.sessionTtlHours);
    setSessionCookie(res, token);
    if (user.is_admin) {
      audit.logAudit(db, {
        adminUserId: user.id,
        adminEmail: user.email,
        action: 'admin.login',
        target: user.email,
        ip: req.ip
      });
    }
    res.json({ user: auth.getPublicUser(user) });
  });

  app.post('/api/auth/logout', (req, res) => {
    if (req.cookies && req.cookies.sid) auth.deleteSession(db, req.cookies.sid);
    res.clearCookie('sid', { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: auth.getPublicUser(req.user) }));

  /* ---------- customer wallet ---------- */
  app.get('/api/wallet', requireAuth, (req, res) => {
    res.json({ wallet: wallet.getWallet(db, req.user.id) });
  });

  /**
   * Create a wallet top-up deposit. Card deposits redirect the user to a Stripe
   * Checkout session; BTC/ETH deposits are PENDING until a payment is actually
   * confirmed ON-CHAIN (admin/manual confirmation) — never by clicking a button.
   */
  app.post('/api/wallet/deposits', walletLimiter, requireAuth, asyncHandler(async (req, res) => {
    const { amountCents, method } = req.body || {};
    const amt = Number(amountCents);
    if (!Number.isInteger(amt) || amt < wallet.MIN_DEPOSIT_CENTS || amt > wallet.MAX_DEPOSIT_CENTS) {
      throw new AppError(400, 'INVALID_AMOUNT',
        `Deposit must be between $${(wallet.MIN_DEPOSIT_CENTS / 100).toFixed(2)} and $${(wallet.MAX_DEPOSIT_CENTS / 100).toLocaleString()}`);
    }
    const m = String(method || '');
    if (wallet.UNAVAILABLE_METHODS.includes(m)) {
      throw new AppError(409, 'METHOD_UNAVAILABLE', 'This payment method is currently unavailable');
    }
    if (!wallet.DEPOSIT_METHODS[m]) {
      throw new AppError(400, 'INVALID_METHOD', 'Select a supported payment method');
    }
    const txn = wallet.createDeposit(db, { userId: req.user.id, amountCents: amt, method: m });

    if (m === 'card') {
      const session = await payments.createWalletDepositSession(config, stripe, db, {
        user: req.user,
        txnId: txn.txn_id,
        amountCents: amt
      });
      return res.json({ txnId: txn.txn_id, status: 'pending', method: m, checkoutUrl: session.url });
    }

    return res.json({
      txnId: txn.txn_id,
      status: 'pending',
      method: m,
      payment: wallet.cryptoInfo(config, m),
      requiresVerification: true,
      note: 'Your wallet is credited only after this deposit is confirmed.'
    });
  }));

  app.post('/api/orders/wallet', orderLimiter, requireAuth, asyncHandler(async (req, res) => {
    const { eventId, items } = req.body || {};
    const eid = safeInt(eventId, 'Invalid event id');
    if (!Array.isArray(items) || items.length === 0) {
      throw new AppError(400, 'INVALID_ITEMS', 'Select at least one ticket');
    }
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eid);
    if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Event not found');

    const existing = findPendingOrderForEvent(db, req.user.id, eid);

    // If there is no pending order, check for an already-paid one (idempotency).
    if (!existing) {
      const paid = db.prepare(
        `SELECT o.* FROM orders o
           JOIN order_items oi ON oi.order_id = o.id
           JOIN ticket_types tt ON tt.id = oi.ticket_type_id
          WHERE o.user_id = ? AND o.status = 'paid' AND tt.event_id = ?
          LIMIT 1`
      ).get(req.user.id, eid);
      if (paid) return res.json({ order: serializeOrder(db, paid), idempotent: true });
    }

    const order = existing || createOrder(db, {
      userId: req.user.id,
      userEmail: req.user.email,
      eventId: eid,
      items,
      feeRate: config.feeRate,
      paymentMethod: 'wallet'
    });

    if (order.payment_method !== 'wallet') {
      db.prepare(`UPDATE orders SET payment_method = 'wallet', updated_at = datetime('now') WHERE id = ?`).run(order.id);
    }

    const remaining = order.total_cents - (order.gift_card_cents || 0);
    if (remaining <= 0) {
      throw new AppError(409, 'GIFT_CARD_COVERS_ORDER', 'This order is already fully covered by a gift card');
    }
    if (hasAnyPayment(db, order.id)) {
      throw new AppError(409, 'PAYMENT_ALREADY_STARTED',
        'This order already has a payment. Start a fresh order to pay with your wallet.');
    }

    const result = completeOrderWithWallet(db, {
      orderNumber: order.order_number,
      userId: req.user.id,
      isAdmin: req.user.is_admin
    });
    return res.json({ order: serializeOrder(db, result.order), idempotent: result.idempotent });
  }));

  app.post('/api/orders/crypto', orderLimiter, requireAuth, asyncHandler(async (req, res) => {
    const { eventId, items, method } = req.body || {};
    const eid = safeInt(eventId, 'Invalid event id');
    const m = String(method || '').toLowerCase();
    if (!['btc', 'eth'].includes(m)) throw new AppError(400, 'INVALID_METHOD', 'Select BTC or ETH for crypto payment');
    if (!Array.isArray(items) || items.length === 0) {
      throw new AppError(400, 'INVALID_ITEMS', 'Select at least one ticket');
    }
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eid);
    if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Event not found');

    const existing = findPendingOrderForEvent(db, req.user.id, eid);

    // Idempotency: return the already-paid order instead of creating a duplicate.
    if (!existing) {
      const paid = db.prepare(
        `SELECT o.* FROM orders o
           JOIN order_items oi ON oi.order_id = o.id
           JOIN ticket_types tt ON tt.id = oi.ticket_type_id
          WHERE o.user_id = ? AND o.status = 'paid' AND tt.event_id = ?
          LIMIT 1`
      ).get(req.user.id, eid);
      if (paid) return res.json({ order: serializeOrder(db, paid), idempotent: true });
    }

    const order = existing || createOrder(db, {
      userId: req.user.id,
      userEmail: req.user.email,
      eventId: eid,
      items,
      feeRate: config.feeRate,
      paymentMethod: m
    });

    if (order.payment_method !== m) {
      db.prepare(`UPDATE orders SET payment_method = ?, updated_at = datetime('now') WHERE id = ?`).run(m, order.id);
    }

    const remaining = order.total_cents - (order.gift_card_cents || 0);
    if (remaining <= 0) {
      throw new AppError(409, 'GIFT_CARD_COVERS_ORDER', 'This order is already fully covered by a gift card');
    }

    const existingCrypto = db.prepare(
      `SELECT 1 FROM payments WHERE order_id = ? AND provider = 'crypto' ORDER BY id DESC LIMIT 1`
    ).get(order.id);
    if (existingCrypto) {
      return res.json({
        orderNumber: order.order_number,
        status: 'pending',
        method: m,
        payment: wallet.cryptoInfo(config, m),
        requiresVerification: true,
        note: 'This order already has a pending crypto payment. It will complete after on-chain confirmation.'
      });
    }
    if (hasAnyPayment(db, order.id)) {
      throw new AppError(409, 'PAYMENT_ALREADY_STARTED',
        'This order already has a payment. Start a fresh order to pay with crypto.');
    }

    db.prepare(
      `INSERT INTO payments (order_id, provider, provider_order_id, amount_cents, currency, status)
       VALUES (?, 'crypto', ?, ?, 'usd', 'pending')`
    ).run(order.id, order.order_number, remaining);

    return res.json({
      orderNumber: order.order_number,
      status: 'pending',
      method: m,
      payment: wallet.cryptoInfo(config, m),
      requiresVerification: true,
      note: 'Send the exact amount to the address shown. Your order is completed only after the payment is confirmed on-chain.'
    });
  }));

  /* ---------- orders ---------- */
  app.post('/api/orders', orderLimiter, requireAuth, asyncHandler(async (req, res) => {
    const { eventId, items } = req.body || {};
    const eid = safeInt(eventId, 'Invalid event id');
    if (!Array.isArray(items) || items.length === 0) {
      throw new AppError(400, 'INVALID_ITEMS', 'Select at least one ticket');
    }

    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eid);
    if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Event not found');

    const existing = findPendingOrderForEvent(db, req.user.id, eid);
    const order = existing || createOrder(db, {
      userId: req.user.id,
      userEmail: req.user.email,
      eventId: eid,
      items,
      feeRate: config.feeRate,
      paymentMethod: 'card'
    });

    const remaining = order.total_cents - (order.gift_card_cents || 0);
    if (remaining <= 0) {
      throw new AppError(409, 'GIFT_CARD_COVERS_ORDER', 'This order is already fully covered by a gift card');
    }

    const session = await payments.createCheckoutSession(config, stripe, db, {
      order,
      event,
      user: req.user,
      amountOverrideCents: order.gift_card_cents > 0 ? remaining : undefined
    });

    db.prepare(
      `UPDATE orders SET checkout_session_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(session.id, order.id);

    return res.json({ orderNumber: order.order_number, checkoutUrl: session.url });
  }));

  app.post('/api/orders/paypal', orderLimiter, requireAuth, asyncHandler(async (req, res) => {
    const { eventId, items } = req.body || {};
    const eid = safeInt(eventId, 'Invalid event id');
    if (!Array.isArray(items) || items.length === 0) {
      throw new AppError(400, 'INVALID_ITEMS', 'Select at least one ticket');
    }
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eid);
    if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Event not found');

    const existing = findPendingOrderForEvent(db, req.user.id, eid);
    const order = existing || createOrder(db, {
      userId: req.user.id,
      userEmail: req.user.email,
      eventId: eid,
      items,
      feeRate: config.feeRate,
      paymentMethod: 'paypal'
    });

    const remaining = order.total_cents - (order.gift_card_cents || 0);
    if (remaining <= 0) {
      throw new AppError(409, 'GIFT_CARD_COVERS_ORDER', 'This order is already fully covered by a gift card');
    }

    const paypalOrder = await paypal.createOrder({
      amountCents: remaining,
      orderNumber: order.order_number,
      returnUrl: `${config.baseUrl}/confirm.html?order=${order.order_number}`,
      cancelUrl: `${config.baseUrl}/checkout.html?event=${event.id}&cancelled=1`
    });

    db.prepare(
      `INSERT OR IGNORE INTO payments (order_id, provider, provider_order_id, amount_cents, currency, status)
       VALUES (?, 'paypal', ?, ?, 'usd', 'pending')`
    ).run(order.id, paypalOrder.id, remaining);

    return res.json({ orderNumber: order.order_number, approveUrl: paypalOrder.approveUrl });
  }));

  /* Gift card checkout: create/resume a pending order with a gift card hold, or validate its balance. */
  app.post('/api/orders/gift-card', giftCardLimiter, requireAuth, asyncHandler(async (req, res) => {
    const { eventId, items, code } = req.body || {};
    const eid = safeInt(eventId, 'Invalid event id');
    if (!Array.isArray(items) || items.length === 0) {
      throw new AppError(400, 'INVALID_ITEMS', 'Select at least one ticket');
    }
    if (!String(code || '').trim()) {
      throw new AppError(400, 'INVALID_GIFT_CARD', 'A gift card code is required');
    }
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eid);
    if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Event not found');

    const { order, appliedCents } = createOrApplyGiftCard(db, {
      userId: req.user.id,
      userEmail: req.user.email,
      eventId: eid,
      items,
      feeRate: config.feeRate,
      giftCardCode: code
    });

    const totalCents = order.total_cents;
    const remainingCents = totalCents - (order.gift_card_cents || 0);
    return res.json({
      orderNumber: order.order_number,
      totalCents,
      appliedCents,
      remainingCents,
      giftCardCovered: remainingCents <= 0,
      paymentMethod: order.payment_method
    });
  }));

  /* Validate a gift card balance before checkout. */
  app.get('/api/gift-cards/validate', giftCardLimiter, requireAuth, (req, res) => {
    const gc = giftcards.validateGiftCard(db, req.query.code || '');
    res.json({
      valid: true,
      maskedCode: gc.code_masked,
      availableCents: giftcards.availableCents(gc)
    });
  });

  /* Pay the gift-card remainder with a card. */
  app.post('/api/orders/:orderNumber/pay-remaining/card', orderLimiter, requireAuth, asyncHandler(async (req, res) => {
    const order = getOrderByNumber(db, req.params.orderNumber);
    if (!order || (order.user_id !== req.user.id && !req.user.is_admin)) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status !== 'pending') throw new AppError(409, 'ORDER_NOT_PENDING', 'Order is not pending');
    const remaining = order.total_cents - (order.gift_card_cents || 0);
    if (remaining <= 0) throw new AppError(409, 'GIFT_CARD_COVERS_ORDER', 'Already fully covered by gift card');

    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(
      db.prepare(
        `SELECT tt.event_id FROM order_items oi JOIN ticket_types tt ON tt.id = oi.ticket_type_id WHERE oi.order_id = ? LIMIT 1`
      ).get(order.id).event_id
    );
    const session = await payments.createCheckoutSession(config, stripe, db, {
      order,
      event,
      user: req.user,
      amountOverrideCents: remaining
    });
    db.prepare(`UPDATE orders SET checkout_session_id = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(session.id, order.id);
    return res.json({ orderNumber: order.order_number, checkoutUrl: session.url });
  }));

  /* Pay the gift-card remainder with PayPal. */
  app.post('/api/orders/:orderNumber/pay-remaining/paypal', orderLimiter, requireAuth, asyncHandler(async (req, res) => {
    const order = getOrderByNumber(db, req.params.orderNumber);
    if (!order || (order.user_id !== req.user.id && !req.user.is_admin)) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status !== 'pending') throw new AppError(409, 'ORDER_NOT_PENDING', 'Order is not pending');
    const remaining = order.total_cents - (order.gift_card_cents || 0);
    if (remaining <= 0) throw new AppError(409, 'GIFT_CARD_COVERS_ORDER', 'Already fully covered by gift card');

    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(
      db.prepare(
        `SELECT tt.event_id FROM order_items oi JOIN ticket_types tt ON tt.id = oi.ticket_type_id WHERE oi.order_id = ? LIMIT 1`
      ).get(order.id).event_id
    );
    const paypalOrder = await paypal.createOrder({
      amountCents: remaining,
      orderNumber: order.order_number,
      returnUrl: `${config.baseUrl}/confirm.html?order=${order.order_number}`,
      cancelUrl: `${config.baseUrl}/checkout.html?event=${event.id}&cancelled=1`
    });
    db.prepare(
      `INSERT OR IGNORE INTO payments (order_id, provider, provider_order_id, amount_cents, currency, status)
       VALUES (?, 'paypal', ?, ?, 'usd', 'pending')`
    ).run(order.id, paypalOrder.id, remaining);
    return res.json({ orderNumber: order.order_number, approveUrl: paypalOrder.approveUrl });
  }));

  /* Complete an order fully covered by a gift card. */
  app.post('/api/orders/:orderNumber/gift-card/complete', orderLimiter, requireAuth, asyncHandler(async (req, res) => {
    const order = getOrderByNumber(db, req.params.orderNumber);
    if (!order || (order.user_id !== req.user.id && !req.user.is_admin)) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status !== 'pending') {
      return res.json({ order: serializeOrder(db, order), idempotent: true });
    }
    const remaining = order.total_cents - (order.gift_card_cents || 0);
    if (remaining > 0) {
      throw new AppError(409, 'GIFT_CARD_NOT_COVERED', 'Gift card does not cover the full order yet');
    }
    const result = completeOrderPayment(db, {
      webhookEventId: `gift_card_complete_${order.order_number}`,
      orderNumber: order.order_number,
      provider: 'gift_card',
      providerPaymentId: null,
      paidCents: order.total_cents
    });
    return res.json({ order: serializeOrder(db, result.order), idempotent: result.idempotent });
  }));

  /* PayPal capture after the buyer approves. */
  app.post('/api/orders/:orderNumber/paypal/capture', orderLimiter, requireAuth, asyncHandler(async (req, res) => {
    const order = getOrderByNumber(db, req.params.orderNumber);
    if (!order || (order.user_id !== req.user.id && !req.user.is_admin)) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status === 'paid') {
      return res.json({ orderNumber: order.order_number, status: 'paid', idempotent: true });
    }
    if (order.status !== 'pending') throw new AppError(409, 'ORDER_NOT_PENDING', 'Order is not pending');

    const pendingRow = db.prepare(
      `SELECT provider_order_id FROM payments WHERE order_id = ? AND provider = 'paypal' ORDER BY id DESC LIMIT 1`
    ).get(order.id);
    if (!pendingRow || !pendingRow.provider_order_id) {
      throw new AppError(409, 'NO_PAYPAL_ORDER', 'No PayPal order exists for this order yet');
    }

    const capture = await paypal.captureOrder(pendingRow.provider_order_id);
    const status = capture.status;
    if (status === 'COMPLETED') {
      const captureId = capture.purchase_units[0].payments.captures[0].id;
      const result = completeOrderPayment(db, {
        webhookEventId: `paypal_capture_${captureId}`,
        orderNumber: order.order_number,
        provider: 'paypal',
        providerPaymentId: captureId,
        eventType: 'paypal.capture.completed'
      });
      return res.json({ orderNumber: order.order_number, status: result.order.status, idempotent: result.idempotent });
    }
    throw new AppError(409, 'PAYPAL_NOT_COMPLETED', `PayPal capture is ${status}`);
  }));

  app.get('/api/orders', requireAuth, (req, res) => {
    res.json({ orders: listOrdersForUser(db, req.user.id) });
  });

  app.get('/api/orders/:orderNumber', requireAuth, (req, res) => {
    const order = getOrderByNumber(db, req.params.orderNumber);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.user_id !== req.user.id && !req.user.is_admin) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json({ order: serializeOrder(db, order) });
  });

  app.post('/api/orders/:orderNumber/retry', orderLimiter, requireAuth, asyncHandler(async (req, res) => {
    const order = getOrderByNumber(db, req.params.orderNumber);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.user_id !== req.user.id && !req.user.is_admin) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status !== 'pending') {
      throw new AppError(409, 'ORDER_NOT_RETRYABLE', `Order is ${order.status} and cannot be retried`);
    }
    const remaining = order.total_cents - (order.gift_card_cents || 0);
    if (remaining <= 0) {
      throw new AppError(409, 'GIFT_CARD_COVERS_ORDER', 'This order is fully covered by a gift card');
    }

    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(
      db.prepare(
        `SELECT tt.event_id FROM order_items oi JOIN ticket_types tt ON tt.id = oi.ticket_type_id WHERE oi.order_id = ? LIMIT 1`
      ).get(order.id).event_id
    );
    if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Event not found');
    const session = await payments.createCheckoutSession(config, stripe, db, {
      order,
      event,
      user: req.user,
      amountOverrideCents: order.gift_card_cents > 0 ? remaining : undefined
    });
    db.prepare(`UPDATE orders SET checkout_session_id = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(session.id, order.id);
    return res.json({ orderNumber: order.order_number, checkoutUrl: session.url });
  }));

  /* ---------- admin ---------- */
  app.get('/api/admin/orders', requireAdmin, (req, res) => {
    res.json({ orders: listAllOrders(db) });
  });

  app.get('/api/admin/wallet/deposits', requireAdmin, (req, res) => {
    res.json({ deposits: wallet.listPendingDeposits(db, req.query.limit) });
  });

  app.get('/api/admin/wallet/transactions', requireAdmin, (req, res) => {
    res.json({ transactions: wallet.listAdminWalletTxns(db, req.query.limit) });
  });

  /**
   * Admin confirms that a wallet deposit was actually received and verified
   * (Stripe webhook already auto-confirms card deposits; this endpoint is for
   * BTC/ETH deposits confirmed on-chain or manually). Never callable by users.
   */
  app.post('/api/admin/wallet/deposits/:txnId/confirm', adminLimiter, requireAdmin, asyncHandler(async (req, res) => {
    const txnId = String(req.params.txnId || '');
    const outcome = String((req.body || {}).outcome || '');
    if (!txnId || !['completed', 'failed'].includes(outcome)) {
      throw new AppError(400, 'INVALID_OUTCOME', "outcome must be 'completed' or 'failed'");
    }
    const txn = outcome === 'completed'
      ? wallet.completeDeposit(db, txnId)
      : wallet.failDeposit(db, txnId);
    audit.logAudit(db, {
      adminUserId: req.user.id,
      adminEmail: req.user.email,
      action: 'wallet.deposit.confirm',
      target: txnId,
      details: outcome,
      ip: req.ip
    });
    return res.json({ transaction: txn, idempotent: txn.idempotent });
  }));

  /**
   * Admin confirms a crypto order was paid after on-chain verification and
   * completes it. No user-facing endpoint can ever do this.
   */
  app.post('/api/admin/orders/:orderNumber/crypto/complete', adminLimiter, requireAdmin, asyncHandler(async (req, res) => {
    const order = getOrderByNumber(db, req.params.orderNumber);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'paid') {
      return res.json({ order: serializeOrder(db, order), idempotent: true });
    }
    if (order.status !== 'pending') {
      throw new AppError(409, 'ORDER_NOT_PENDING', `Order is ${order.status} and cannot be completed as crypto`);
    }
    if (!order.payment_intent_id) {
      db.prepare(`UPDATE orders SET payment_intent_id = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(`crypto_verified_${order.order_number}`, order.id);
    }
    const result = completeOrderPayment(db, {
      webhookEventId: `crypto_verify_${order.order_number}`,
      orderNumber: order.order_number,
      provider: 'crypto',
      providerPaymentId: order.payment_intent_id || `crypto_verified_${order.order_number}`,
      paidCents: order.total_cents,
      eventType: 'crypto.verified'
    });
    audit.logAudit(db, {
      adminUserId: req.user.id,
      adminEmail: req.user.email,
      action: 'order.crypto.verify',
      target: order.order_number,
      details: 'Crypto payment confirmed on-chain',
      ip: req.ip
    });
    return res.json({ order: serializeOrder(db, result.order), idempotent: result.idempotent });
  }));

  app.post('/api/admin/orders/:orderNumber/refund', adminLimiter, requireAdmin, asyncHandler(async (req, res) => {
    const order = getOrderByNumber(db, req.params.orderNumber);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'paid') {
      throw new AppError(409, 'ORDER_NOT_REFUNDABLE', `Only paid orders can be refunded (got ${order.status})`);
    }

    const payment = db.prepare(
      `SELECT provider, provider_payment_id, provider_order_id FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1`
    ).get(order.id);

    // Gift-card-only orders have no external payment to refund.
    if (payment && payment.provider === 'gift_card') {
      const result = markRefunded(db, `admin:gc:${order.order_number}`, payment.provider_payment_id);
      audit.logAudit(db, {
        adminUserId: req.user.id,
        adminEmail: req.user.email,
        action: 'order.refund',
        target: order.order_number,
        details: `Gift card order; amount ${order.total_cents}`,
        ip: req.ip
      });
      return res.json({ order: serializeOrder(db, result.order) });
    }

    // PayPal orders are refunded via the PayPal capture reference.
    if (payment && payment.provider === 'paypal') {
      if (!order.payment_intent_id) {
        throw new AppError(409, 'NO_PAYMENT_REFERENCE', 'No PayPal capture reference recorded for this order');
      }
      try {
        await paypal.refundCapture(order.payment_intent_id);
      } catch (err) {
        throw new AppError(502, 'REFUND_FAILED', `PayPal refund failed: ${err.message}`);
      }
      const result = markRefunded(db, `admin:paypal:${order.payment_intent_id}`, order.payment_intent_id);
      audit.logAudit(db, {
        adminUserId: req.user.id,
        adminEmail: req.user.email,
        action: 'order.refund',
        target: order.order_number,
        details: `PayPal order; amount ${order.total_cents}`,
        ip: req.ip
      });
      return res.json({ order: serializeOrder(db, result.order) });
    }

    // Wallet orders are refunded by crediting the customer's wallet balance.
    if (payment && payment.provider === 'wallet') {
      wallet.creditOrderRefund(db, {
        userId: order.user_id,
        reference: order.order_number,
        orderTotalCents: order.total_cents
      });
      const result = markRefunded(db, `admin:wallet:${order.order_number}`, payment.provider_payment_id);
      audit.logAudit(db, {
        adminUserId: req.user.id,
        adminEmail: req.user.email,
        action: 'order.refund',
        target: order.order_number,
        details: `Wallet order; amount ${order.total_cents} credited to wallet`,
        ip: req.ip
      });
      return res.json({ order: serializeOrder(db, result.order) });
    }

    // Crypto orders cannot be auto-refunded through a payment provider; the
    // operator must reconcile the refund on-chain manually.
    if (payment && payment.provider === 'crypto') {
      throw new AppError(409, 'CRYPTO_REFUND_MANUAL',
        'Crypto payments must be refunded manually on-chain by the operator');
    }

    if (!order.payment_intent_id) {
      throw new AppError(409, 'NO_PAYMENT_INTENT', 'No payment reference recorded for this order');
    }

    let refund;
    try {
      refund = await stripe.refunds.create({ payment_intent: order.payment_intent_id });
    } catch (err) {
      throw new AppError(502, 'REFUND_FAILED', `Stripe refund failed: ${err.message}`);
    }

    const result = markRefunded(db, `admin:${refund.id}`, order.payment_intent_id);
    audit.logAudit(db, {
      adminUserId: req.user.id,
      adminEmail: req.user.email,
      action: 'order.refund',
      target: order.order_number,
      details: `Card order; amount ${order.total_cents}`,
      ip: req.ip
    });
    res.json({ order: serializeOrder(db, result.order) });
  }));

  /* ---------- admin: gift cards ---------- */
  app.get('/api/admin/gift-cards', requireAdmin, (req, res) => {
    res.json({ giftCards: giftcards.listGiftCards(db) });
  });

  app.post('/api/admin/gift-cards', adminLimiter, requireAdmin, (req, res) => {
    const { valueCents, expiresAt, count } = req.body || {};
    const expires = expiresAt || null;
    if (expires !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(expires))) {
      throw new AppError(400, 'INVALID_EXPIRES_AT', 'expiresAt must be a YYYY-MM-DD date');
    }
    const n = count === undefined || count === null || count === '' ? 1 : Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      throw new AppError(400, 'INVALID_COUNT', 'count must be an integer between 1 and 100');
    }
    const codes = giftcards.createGiftCards(db, {
      valueCents: Number(valueCents),
      expiresAt: expires,
      createdBy: req.user.id,
      count: n
    });
    audit.logAudit(db, {
      adminUserId: req.user.id,
      adminEmail: req.user.email,
      action: 'giftcard.create',
      target: null,
      details: `${n} x ${Number(valueCents)} cents`,
      ip: req.ip
    });
    res.status(201).json({ codes, count: codes.length });
  });

  app.post('/api/admin/gift-cards/:id/toggle', adminLimiter, requireAdmin, (req, res) => {
    const gc = giftcards.toggleGiftCardActive(db, safeInt(req.params.id));
    audit.logAudit(db, {
      adminUserId: req.user.id,
      adminEmail: req.user.email,
      action: 'giftcard.toggle',
      target: gc.code_masked,
      details: gc.is_active ? 'enabled' : 'disabled',
      ip: req.ip
    });
    res.json({ giftCard: gc });
  });

  app.get('/api/admin/gift-cards/:id/redemptions', requireAdmin, (req, res) => {
    const gc = giftcards.getGiftCardById(db, safeInt(req.params.id));
    if (!gc) return res.status(404).json({ error: 'Gift card not found' });
    res.json({ giftCard: gc, redemptions: giftcards.redemptionsFor(db, gc.id) });
  });

  /* ---------- admin: audit log ---------- */
  app.get('/api/admin/audit', requireAdmin, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    res.json({ entries: audit.listAudit(db, limit), limit });
  });

  /* ---------- API 404 + error handler ---------- */
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(400).json({ error: 'Invalid request body' });
    }
    console.error('Unhandled error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  });

  /* ---------- static (existing frontend, sensitive paths blocked) ---------- */
  app.use((req, res, next) => {
    if (BLOCKED_STATIC.test(req.path)) return res.status(403).send('Forbidden');
    next();
  });
  app.use(express.static(ROOT, { index: 'index.html' }));

  return app;
}

module.exports = { createApp };