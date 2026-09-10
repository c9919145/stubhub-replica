'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('node:path');

const auth = require('./auth');
const { AppError, createOrder, createOrApplyGiftCard, completeOrderPayment, findPendingOrderForEvent, getOrderByNumber, serializeOrder, listOrdersForUser, listAllOrders, markRefunded, failOrder } = require('./orders');
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

  /* ---------- rate limiting (skip in test / when disabled) ---------- */
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
      sameSite: 'lax',
      secure: config.cookieSecure,
      maxAge: config.sessionTtlHours * 3600 * 1000,
      path: '/'
    });
  }

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
  app.post('/api/auth/register', limiter, (req, res) => {
    const { email, name, password } = req.body || {};
    const normalized = String(email || '').trim().toLowerCase();
    const pw = String(password || '');
    const displayName = String(name || '').trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new AppError(400, 'INVALID_EMAIL', 'A valid email is required');
    if (pw.length < 8) throw new AppError(400, 'WEAK_PASSWORD', 'Password must be at least 8 characters');
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

  app.post('/api/auth/login', limiter, (req, res) => {
    const { email, password } = req.body || {};
    const normalized = String(email || '').trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalized);
    if (!user || !auth.verifyPassword(password, user.password_hash)) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }
    const token = auth.createSession(db, user.id, config.sessionTtlHours);
    setSessionCookie(res, token);
    res.json({ user: auth.getPublicUser(user) });
  });

  app.post('/api/auth/logout', (req, res) => {
    if (req.cookies && req.cookies.sid) auth.deleteSession(db, req.cookies.sid);
    res.clearCookie('sid', { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: auth.getPublicUser(req.user) }));

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

  app.post('/api/admin/orders/:orderNumber/refund', requireAdmin, asyncHandler(async (req, res) => {
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
      return res.json({ order: serializeOrder(db, result.order) });
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
    res.json({ order: serializeOrder(db, result.order) });
  }));

  /* ---------- admin: gift cards ---------- */
  app.get('/api/admin/gift-cards', requireAdmin, (req, res) => {
    res.json({ giftCards: giftcards.listGiftCards(db) });
  });

  app.post('/api/admin/gift-cards', requireAdmin, (req, res) => {
    const { valueCents, expiresAt, count } = req.body || {};
    const codes = giftcards.createGiftCards(db, {
      valueCents: Number(valueCents),
      expiresAt: expiresAt || null,
      createdBy: req.user.id,
      count: Number(count || 1)
    });
    res.status(201).json({ codes, count: codes.length });
  });

  app.post('/api/admin/gift-cards/:id/toggle', requireAdmin, (req, res) => {
    const gc = giftcards.toggleGiftCardActive(db, safeInt(req.params.id));
    res.json({ giftCard: gc });
  });

  app.get('/api/admin/gift-cards/:id/redemptions', requireAdmin, (req, res) => {
    const gc = giftcards.getGiftCardById(db, safeInt(req.params.id));
    if (!gc) return res.status(404).json({ error: 'Gift card not found' });
    res.json({ giftCard: gc, redemptions: giftcards.redemptionsFor(db, gc.id) });
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