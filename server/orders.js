'use strict';

const crypto = require('node:crypto');
const { withImmediateTransaction, rowid } = require('./db');
const { AppError } = require('./errors');
const giftcards = require('./giftcards');
const wallet = require('./wallet');

const MAX_LINE_ITEMS = 10;
const MAX_QTY_PER_ITEM = 16;

function generateOrderNumber() {
  const n = crypto.randomBytes(6).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `SH-${n}`;
}

function getOrderByNumber(db, orderNumber) {
  return db.prepare('SELECT * FROM orders WHERE order_number = ?').get(orderNumber) || null;
}

function getOrderById(db, orderId) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) || null;
}

function findPendingOrderForEvent(db, userId, eventId) {
  return (
    db.prepare(
      `SELECT o.*
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         JOIN ticket_types tt ON tt.id = oi.ticket_type_id
        WHERE o.user_id = ? AND o.status = 'pending' AND tt.event_id = ?
        LIMIT 1`
    ).get(userId, eventId) || null
  );
}

function orderItemsWithTickets(db, orderId) {
  return db.prepare(
    `SELECT oi.*, tt.name AS ticket_type_name, tt.description AS ticket_type_description,
            e.name AS event_name, e.venue, e.city, e.date
       FROM order_items oi
       JOIN ticket_types tt ON tt.id = oi.ticket_type_id
       JOIN events e ON e.id = tt.event_id
      WHERE oi.order_id = ?
      ORDER BY oi.id`
  ).all(orderId);
}

function getPaymentSummary(db, orderId) {
  const p = db.prepare(
    `SELECT provider, provider_payment_id, status, amount_cents, last_error, created_at
       FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1`
  ).get(orderId);
  return p || null;
}

function serializeOrder(db, order) {
  const items = orderItemsWithTickets(db, order.id);
  const payment = getPaymentSummary(db, order.id);
  return {
    orderNumber: order.order_number,
    status: order.status,
    currency: order.currency,
    subtotalCents: order.subtotal_cents,
    feesCents: order.fees_cents,
    discountCents: order.discount_cents,
    giftCardCents: order.gift_card_cents,
    paymentMethod: order.payment_method,
    totalCents: order.total_cents,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    paidAt: order.paid_at,
    items: items.map(i => ({
      ticketType: i.ticket_type_name,
      description: i.ticket_type_description,
      quantity: i.quantity,
      unitPriceCents: i.unit_price_cents,
      event: {
        name: i.event_name,
        venue: i.venue,
        city: i.city,
        date: i.date
      }
    })),
    payment: payment ? {
      provider: payment.provider,
      transactionId: payment.provider_payment_id,
      status: payment.status,
      amountCents: payment.amount_cents,
      error: payment.last_error,
      createdAt: payment.created_at
    } : null
  };
}

/**
 * Validates line items and computes prices from the database (never the client).
 * Runs inside an existing (open) transaction. Returns { normalized, subtotalCents, feesCents, totalCents }.
 */
function validateItems(db, eventId, items, feeRate) {
  if (!Number.isInteger(eventId) || eventId <= 0) {
    throw new AppError(400, 'INVALID_EVENT', 'Invalid event id');
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_LINE_ITEMS) {
    throw new AppError(400, 'INVALID_ITEMS', 'Order must contain at least one, and at most 10, line items');
  }
  if (!db.prepare('SELECT 1 FROM events WHERE id = ?').get(eventId)) {
    throw new AppError(404, 'EVENT_NOT_FOUND', 'Event not found');
  }

  const normalized = [];
  const seen = new Set();
  for (const item of items) {
    const ticketTypeId = Number(item.ticketTypeId);
    const quantity = Number(item.quantity);
    if (!Number.isInteger(ticketTypeId) || ticketTypeId <= 0) {
      throw new AppError(400, 'INVALID_ITEM', 'Invalid ticket type id');
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY_PER_ITEM) {
      throw new AppError(400, 'INVALID_QUANTITY', `Quantity must be between 1 and ${MAX_QTY_PER_ITEM}`);
    }
    if (seen.has(ticketTypeId)) {
      throw new AppError(400, 'DUPLICATE_ITEM', 'Duplicate ticket type in order');
    }
    seen.add(ticketTypeId);

    const tt = db.prepare('SELECT * FROM ticket_types WHERE id = ?').get(ticketTypeId);
    if (!tt || tt.event_id !== eventId) {
      throw new AppError(404, 'TICKET_TYPE_NOT_FOUND', 'Ticket type not found for this event');
    }
    const available = tt.total_quantity - tt.sold_quantity - tt.reserved_quantity;
    if (quantity > available) {
      throw new AppError(409, 'INSUFFICIENT_INVENTORY',
        `Only ${available} ticket(s) available for "${tt.name}"`);
    }
    normalized.push({ tt, quantity });
  }

  let subtotalCents = 0;
  normalized.forEach(({ tt, quantity }) => {
    subtotalCents += tt.price_cents * quantity;
  });
  const feesCents = Number.isFinite(feeRate) && feeRate > 0 ? Math.round(subtotalCents * feeRate) : 0;
  return { normalized, subtotalCents, feesCents, totalCents: subtotalCents + feesCents };
}

function insertOrderRow(db, { userId, userEmail, subtotalCents, feesCents, totalCents, giftCardCents = 0, paymentMethod }) {
  const orderNumber = generateOrderNumber();
  const res = db.prepare(
    `INSERT INTO orders (order_number, user_id, email, status, currency, subtotal_cents, fees_cents, discount_cents, gift_card_cents, total_cents, payment_method)
     VALUES (?, ?, ?, 'pending', 'usd', ?, ?, 0, ?, ?, ?)`
  ).run(orderNumber, userId, userEmail, subtotalCents, feesCents, giftCardCents, totalCents, paymentMethod || null);
  return getOrderById(db, rowid(res));
}

function reserveItems(db, orderId, normalized) {
  const insItem = db.prepare(
    'INSERT INTO order_items (order_id, ticket_type_id, quantity, unit_price_cents) VALUES (?, ?, ?, ?)'
  );
  const reserve = db.prepare(
    'UPDATE ticket_types SET reserved_quantity = reserved_quantity + ? WHERE id = ?'
  );
  normalized.forEach(({ tt, quantity }) => {
    insItem.run(orderId, tt.id, quantity, tt.price_cents);
    reserve.run(quantity, tt.id);
  });
}

/**
 * Create a pending order, reserving inventory. Prices come from the DB.
 */
function createOrder(db, opts) {
  return withImmediateTransaction(db, () => {
    const { normalized, subtotalCents, feesCents, totalCents } =
      validateItems(db, opts.eventId, opts.items, opts.feeRate);
    const order = insertOrderRow(db, {
      userId: opts.userId,
      userEmail: opts.userEmail,
      subtotalCents,
      feesCents,
      totalCents,
      paymentMethod: opts.paymentMethod
    });
    reserveItems(db, order.id, normalized);
    return getOrderById(db, order.id);
  });
}

/**
 * Create a pending order while applying a gift card hold, all in ONE immediate
 * transaction so inventory reservation and gift balance hold are atomic.
 * Returns { order, appliedCents, remainingCents }.
 */
function createOrderWithGiftCard(db, opts) {
  return withImmediateTransaction(db, () => {
    const { normalized, subtotalCents, feesCents, totalCents } =
      validateItems(db, opts.eventId, opts.items, opts.feeRate);

    const gc = giftcards.validateGiftCard(db, opts.giftCardCode);
    const appliedCents = Math.min(giftcards.availableCents(gc), totalCents);
    if (appliedCents <= 0) {
      throw new AppError(409, 'INSUFFICIENT_GIFT_BALANCE', 'This gift card has no balance to apply');
    }

    const order = insertOrderRow(db, {
      userId: opts.userId,
      userEmail: opts.userEmail,
      subtotalCents,
      feesCents,
      totalCents,
      giftCardCents: appliedCents,
      paymentMethod: 'gift_card'
    });

    giftcards.applyHold(db, gc.id, appliedCents, order.id);
    reserveItems(db, order.id, normalized);

    const fresh = getOrderById(db, order.id);
    if (fresh.gift_card_cents > fresh.total_cents) {
      throw new AppError(409, 'INSUFFICIENT_GIFT_BALANCE', 'Gift card cannot exceed the order total');
    }
    return { order: fresh, appliedCents, remainingCents: fresh.total_cents - fresh.gift_card_cents };
  });
}

/**
 * Apply (or re-read) a pending order's gift card. If the pending order for this
 * event already exists with a gift hold, it is returned unchanged (idempotent).
 */
function createOrApplyGiftCard(db, opts) {
  return withImmediateTransaction(db, () => {
    const existing = findPendingOrderForEvent(db, opts.userId, opts.eventId);
    if (existing) {
      if (existing.gift_card_cents > 0) {
        return { order: existing, appliedCents: existing.gift_card_cents, reused: true };
      }
      const gc = giftcards.validateGiftCard(db, opts.giftCardCode);
      const appliedCents = Math.min(giftcards.availableCents(gc), existing.total_cents);
      if (appliedCents <= 0) {
        throw new AppError(409, 'INSUFFICIENT_GIFT_BALANCE', 'This gift card has no balance to apply');
      }
      giftcards.applyHold(db, gc.id, appliedCents, existing.id);
      db.prepare(
        `UPDATE orders SET gift_card_cents = ?, payment_method = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(appliedCents, 'gift_card', existing.id);
      const order = getOrderById(db, existing.id);
      return { order, appliedCents, reused: true };
    }
    return createOrderWithGiftCardInner(db, opts);
  });
}

/** Creates a brand-new gift-card order. Must already be inside a transaction. */
function createOrderWithGiftCardInner(db, opts) {
  const { normalized, subtotalCents, feesCents, totalCents } =
    validateItems(db, opts.eventId, opts.items, opts.feeRate);

  const gc = giftcards.validateGiftCard(db, opts.giftCardCode);
  const appliedCents = Math.min(giftcards.availableCents(gc), totalCents);
  if (appliedCents <= 0) {
    throw new AppError(409, 'INSUFFICIENT_GIFT_BALANCE', 'This gift card has no balance to apply');
  }

  const order = insertOrderRow(db, {
    userId: opts.userId,
    userEmail: opts.userEmail,
    subtotalCents,
    feesCents,
    totalCents,
    giftCardCents: appliedCents,
    paymentMethod: 'gift_card'
  });

  giftcards.applyHold(db, gc.id, appliedCents, order.id);
  reserveItems(db, order.id, normalized);

  const fresh = getOrderById(db, order.id);
  if (fresh.gift_card_cents > fresh.total_cents) {
    throw new AppError(409, 'INSUFFICIENT_GIFT_BALANCE', 'Gift card cannot exceed the order total');
  }
  return { order: fresh, appliedCents, remainingCents: fresh.total_cents - fresh.gift_card_cents };
}

/**
 * Sells the order's tickets, redeems gift-card holds, marks the order paid and
 * records a successful payment row. Runs inside an existing (open) transaction.
 * Never derives amounts from the client — the caller passes the authoritative
 * amount that was actually collected.
 */
function sellAndMarkPaid(db, order, { provider, providerPaymentId, amountCents }) {
  const items = db.prepare('SELECT ticket_type_id, quantity FROM order_items WHERE order_id = ?').all(order.id);
  const markSold = db.prepare(
    `UPDATE ticket_types SET sold_quantity = sold_quantity + ?, reserved_quantity = MAX(0, reserved_quantity - ?)
      WHERE id = ?`
  );
  items.forEach(i => markSold.run(i.quantity, i.quantity, i.ticket_type_id));

  if (order.gift_card_cents > 0) giftcards.redeemHolds(db, order.id);

  db.prepare(
    `UPDATE orders SET status = 'paid', payment_method = COALESCE(payment_method, ?),
       payment_intent_id = COALESCE(?, payment_intent_id), paid_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?`
  ).run(provider, providerPaymentId, order.id);

  db.prepare(
    `INSERT INTO payments (order_id, provider, provider_payment_id, amount_cents, currency, status)
     VALUES (?, ?, ?, ?, 'usd', 'succeeded')`
  ).run(order.id, provider, providerPaymentId || `unref_${order.id}`, amountCents);
}

/**
 * Marks an order paid, sells its tickets, redeems gift-card holds, and records a
 * successful payment. Idempotent per webhook event id and order status. Runs in
 * its own immediate transaction.
 */
function completeOrderPayment(db, {
  webhookEventId,
  orderNumber,
  provider = 'stripe',
  providerPaymentId = null,
  paidCents,
  eventType = 'checkout.session.completed'
}) {
  return withImmediateTransaction(db, () => {
    const already = wasWebhookProcessed(db, webhookEventId);
    const order = getOrderByNumber(db, orderNumber);
    if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found for payment');

    if (already || order.status === 'paid') {
      recordWebhook(db, webhookEventId, eventType, order.id);
      return { order, idempotent: true };
    }
    if (order.status !== 'pending') {
      recordWebhook(db, webhookEventId, eventType, order.id);
      return { order, idempotent: true, ignored: true };
    }

    const amountCents = paidCents != null ? paidCents : order.total_cents - (order.gift_card_cents || 0);
    sellAndMarkPaid(db, order, { provider, providerPaymentId, amountCents });

    recordWebhook(db, webhookEventId, eventType, order.id);
    return { order: getOrderById(db, order.id), idempotent: false };
  });
}

/**
 * Completes a pending order using the customer's wallet balance. The wallet
 * debit and the order completion happen in ONE immediate transaction; an
 * insufficient balance fails the whole thing without selling any tickets.
 * Idempotent via the order's status and the wallet order-payment reference.
 */
function completeOrderWithWallet(db, { orderNumber, userId, isAdmin = false }) {
  return withImmediateTransaction(db, () => {
    const order = getOrderByNumber(db, orderNumber);
    if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
    if (order.user_id !== userId && !isAdmin) {
      throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
    }
    if (order.status === 'paid') return { order, idempotent: true };
    if (order.status !== 'pending') {
      return { order, idempotent: true, ignored: true };
    }
    if (order.gift_card_cents > 0) {
      throw new AppError(409, 'GIFT_CARD_APPLIED',
        'This order already uses a gift card. Remove the gift card or start a new order to pay with your wallet.');
    }
    if (hasAnyPayment(db, order.id)) {
      throw new AppError(409, 'PAYMENT_ALREADY_STARTED',
        'This order already has a payment. Start a fresh order to pay differently.');
    }

    const amountCents = order.total_cents - (order.gift_card_cents || 0);
    const debit = wallet.applyDebitForOrder(db, {
      userId,
      amountCents,
      reference: order.order_number
    });
    if (debit.idempotent) {
      db.prepare(`UPDATE orders SET status = 'paid', paid_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
        .run(order.id);
      return { order: getOrderById(db, order.id), idempotent: true };
    }

    const walletTxnId = debit.txnId;
    sellAndMarkPaid(db, getOrderById(db, order.id), {
      provider: 'wallet',
      providerPaymentId: walletTxnId,
      amountCents
    });
    recordWebhook(db, `wallet_pay_${order.order_number}`, 'wallet.order.completed', order.id);
    return { order: getOrderById(db, order.id), idempotent: false, remainingWalletCents: debit.remaining };
  });
}

/** Any payment record (any status) for an order. */
function hasAnyPayment(db, orderId) {
  return Boolean(db.prepare('SELECT 1 FROM payments WHERE order_id = ? LIMIT 1').get(orderId));
}

/** A payment record still in flight for an order. */
function hasPendingPayment(db, orderId) {
  return Boolean(
    db.prepare(`SELECT 1 FROM payments WHERE order_id = ? AND status IN ('pending','processing','requires_action') LIMIT 1`)
      .get(orderId)
  );
}

/** Stripe webhook compatibility wrapper. */
function finalizePaid(db, stripeEventId, orderNumber, session) {
  return completeOrderPayment(db, {
    webhookEventId: stripeEventId,
    orderNumber,
    provider: 'stripe',
    providerPaymentId: (session && session.payment_intent) || null
  });
}

function failOrder(db, stripeEventId, orderNumber, reason, provider = 'stripe') {
  return withImmediateTransaction(db, () => {
    const already = wasWebhookProcessed(db, stripeEventId);
    const order = getOrderByNumber(db, orderNumber);
    if (!order) return { order: null, idempotent: true };

    if (already || order.status === 'failed') {
      recordWebhook(db, stripeEventId, 'payment_intent.payment_failed', order.id);
      return { order, idempotent: true };
    }
    if (order.status !== 'pending') {
      recordWebhook(db, stripeEventId, 'payment_intent.payment_failed', order.id);
      return { order, idempotent: true, ignored: true };
    }

    releaseReservation(db, order.id);
    giftcards.releaseHolds(db, order.id);
    db.prepare(
      `UPDATE orders SET status = 'failed', updated_at = datetime('now') WHERE id = ?`
    ).run(order.id);
    db.prepare(
      `INSERT INTO payments (order_id, provider, provider_payment_id, amount_cents, currency, status, last_error)
       VALUES (?, ?, ?, ?, 'usd', 'failed', ?)`
    ).run(order.id, provider, stripeEventId, order.total_cents, reason || 'Payment failed');

    recordWebhook(db, stripeEventId, 'payment_intent.payment_failed', order.id);
    return { order: getOrderById(db, order.id), idempotent: false };
  });
}

function expireOrder(db, orderNumber) {
  return withImmediateTransaction(db, () => {
    const order = getOrderByNumber(db, orderNumber);
    if (!order || order.status !== 'pending') return order || null;
    releaseReservation(db, order.id);
    giftcards.releaseHolds(db, order.id);
    db.prepare(
      `UPDATE orders SET status = 'expired', updated_at = datetime('now') WHERE id = ?`
    ).run(order.id);
    return getOrderById(db, order.id);
  });
}

function cancelOrder(db, orderNumber) {
  return withImmediateTransaction(db, () => {
    const order = getOrderByNumber(db, orderNumber);
    if (!order || order.status !== 'pending') return order || null;
    releaseReservation(db, order.id);
    giftcards.releaseHolds(db, order.id);
    db.prepare(
      `UPDATE orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`
    ).run(order.id);
    return getOrderById(db, order.id);
  });
}

/**
 * Mark an order and its payment as refunded. Restores gift-card funds that were
 * redeemed toward the order. Idempotent per event id.
 */
function markRefunded(db, webhookEventId, providerPaymentId) {
  return withImmediateTransaction(db, () => {
    const already = wasWebhookProcessed(db, webhookEventId);
    let order = providerPaymentId
      ? db.prepare('SELECT * FROM orders WHERE payment_intent_id = ?').get(providerPaymentId) || null
      : null;
    if (!order && providerPaymentId) {
      order = db.prepare(
        `SELECT o.* FROM orders o
           JOIN payments p ON p.order_id = o.id
          WHERE p.provider_payment_id = ?
          LIMIT 1`
      ).get(providerPaymentId) || null;
    }

    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', 'No paid order found for this payment');
    }
    if (already || order.status === 'refunded') {
      recordWebhook(db, webhookEventId, 'charge.refunded', order.id);
      return { order, idempotent: true };
    }
    if (order.status !== 'paid') {
      recordWebhook(db, webhookEventId, 'charge.refunded', order.id);
      return { order, idempotent: true, ignored: true };
    }

    if (order.gift_card_cents > 0) giftcards.refundRedeemed(db, order.id);

    db.prepare(
      `UPDATE orders SET status = 'refunded', updated_at = datetime('now') WHERE id = ?`
    ).run(order.id);
    db.prepare(
      `UPDATE payments SET status = 'refunded', updated_at = datetime('now') WHERE provider_payment_id = ?`
    ).run(order.payment_intent_id);

    recordWebhook(db, webhookEventId, 'charge.refunded', order.id);
    return { order: getOrderById(db, order.id), idempotent: false };
  });
}

/**
 * Idempotency guard for a webhook event id. Returns true if already processed.
 */
function wasWebhookProcessed(db, eventId) {
  return Boolean(db.prepare('SELECT 1 FROM webhook_events WHERE event_id = ?').get(eventId));
}

function recordWebhook(db, eventId, type, orderId) {
  db.prepare('INSERT OR IGNORE INTO webhook_events (event_id, type, order_id) VALUES (?, ?, ?)')
    .run(eventId, type, orderId || null);
}

function releaseReservation(db, orderId) {
  const items = db.prepare('SELECT ticket_type_id, quantity FROM order_items WHERE order_id = ?').all(orderId);
  const release = db.prepare(
    'UPDATE ticket_types SET reserved_quantity = MAX(0, reserved_quantity - ?) WHERE id = ?'
  );
  items.forEach(i => release.run(i.quantity, i.ticket_type_id));
}

/* Release reservations (and gift-card holds) pending past the TTL. */
function expireStaleReservations(db, ttlMinutes) {
  const cutoff = Date.now() - ttlMinutes * 60 * 1000;
  const stale = db.prepare(
    `SELECT order_number FROM orders
      WHERE status = 'pending'
        AND unixepoch(created_at) < ?
      LIMIT 200`
  ).all(Math.floor(new Date(cutoff).getTime() / 1000));
  const expired = [];
  stale.forEach(o => {
    const order = expireOrder(db, o.order_number);
    if (order) expired.push(order.order_number);
  });
  return expired;
}

function listOrdersForUser(db, userId) {
  const rows = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC').all(userId);
  return rows.map(o => serializeOrder(db, o));
}

function listAllOrders(db) {
  const rows = db.prepare(
    `SELECT o.id, o.order_number, o.email, o.status AS order_status, o.currency,
            o.subtotal_cents, o.fees_cents, o.discount_cents, o.gift_card_cents,
            o.total_cents, o.payment_method, o.payment_intent_id,
            o.created_at, o.updated_at, o.paid_at,
            u.name AS customer_name,
            p.status AS payment_status, p.provider AS payment_provider,
            p.provider_payment_id, p.last_error,
            (SELECT group_concat(e.name || ' x' || oi.quantity, ' | ')
               FROM order_items oi
               JOIN ticket_types tt ON tt.id = oi.ticket_type_id
               JOIN events e ON e.id = tt.event_id
              WHERE oi.order_id = o.id) AS tickets
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN payments p ON p.order_id = o.id AND p.id = (SELECT max(id) FROM payments WHERE order_id = o.id)
      ORDER BY o.id DESC`
  ).all();
  return rows;
}

module.exports = {
  AppError,
  createOrder,
  createOrderWithGiftCard,
  createOrApplyGiftCard,
  findPendingOrderForEvent,
  getOrderByNumber,
  orderItemsWithTickets,
  serializeOrder,
  completeOrderPayment,
  completeOrderWithWallet,
  hasAnyPayment,
  hasPendingPayment,
  finalizePaid,
  failOrder,
  expireOrder,
  cancelOrder,
  markRefunded,
  expireStaleReservations,
  releaseReservation,
  listOrdersForUser,
  listAllOrders,
  getPaymentSummary,
  getOrderById
};