'use strict';

const crypto = require('node:crypto');
const { AppError } = require('./errors');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode() {
  const bytes = crypto.randomBytes(16);
  let code = '';
  for (let i = 0; i < 16; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
  return `GC-${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12, 16)}`;
}

function hashCode(code) {
  const normalized = String(code).trim().toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function maskCode(code) {
  const normalized = String(code).trim().toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '');
  return `GC-····-····-····-${normalized.slice(-4)}`;
}

function normalizeCode(input) {
  return String(input || '').trim().toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '');
}

/**
 * Validates that a gift card exists, is active, and not expired.
 * Returns the gift card row. Throws AppError otherwise.
 */
function validateGiftCard(db, rawCode) {
  const code = normalizeCode(rawCode);
  if (!code || code.length < 12 || code.length > 40) {
    throw new AppError(400, 'INVALID_GIFT_CARD', 'Invalid gift card code');
  }
  const gc = db.prepare('SELECT * FROM gift_cards WHERE code_hash = ?').get(hashCode(code));
  if (!gc) throw new AppError(404, 'GIFT_CARD_NOT_FOUND', 'Gift card not found');
  if (!gc.is_active) throw new AppError(409, 'GIFT_CARD_INACTIVE', 'This gift card has been deactivated');
  if (gc.expires_at && new Date(gc.expires_at).getTime() <= Date.now()) {
    throw new AppError(409, 'GIFT_CARD_EXPIRED', 'This gift card has expired');
  }
  return gc;
}

function availableCents(gc) {
  return gc.original_value_cents - gc.redeemed_cents - gc.held_cents;
}

/**
 * Attempts to hold `amountCents` of a gift card for an order.
 * MUST be called from inside an IMMEDIATE transaction. Uses a guarded UPDATE
 * so concurrent redemptions cannot overspend the balance.
 */
function applyHold(db, giftCardId, amountCents, orderId) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new AppError(409, 'INSUFFICIENT_GIFT_BALANCE', 'Gift card has no remaining balance to apply');
  }
  const res = db.prepare(
    `UPDATE gift_cards SET held_cents = held_cents + ?, updated_at = datetime('now')
      WHERE id = ? AND is_active = 1
        AND (expires_at IS NULL OR expires_at > datetime('now'))
        AND (original_value_cents - redeemed_cents - held_cents) >= ?`
  ).run(amountCents, giftCardId, amountCents);
  if (res.changes !== 1) {
    throw new AppError(409, 'INSUFFICIENT_GIFT_BALANCE',
      'Not enough gift card balance to cover this amount. Available balances are enforced server-side.');
  }
  db.prepare(
    `INSERT INTO gift_card_redemptions (gift_card_id, order_id, amount_cents, kind) VALUES (?, ?, ?, 'hold')`
  ).run(giftCardId, orderId, amountCents);
  return amountCents;
}

function holdsForOrder(db, orderId) {
  return db.prepare(
    `SELECT id, gift_card_id, amount_cents FROM gift_card_redemptions WHERE order_id = ? AND kind = 'hold'`
  ).all(orderId);
}

/** Converts outstanding holds of an order into redeemed balances (MUST be in a transaction). */
function redeemHolds(db, orderId) {
  const holds = holdsForOrder(db, orderId);
  const updCard = db.prepare(
    `UPDATE gift_cards SET held_cents = MAX(0, held_cents - ?),
        redeemed_cents = redeemed_cents + ?, updated_at = datetime('now') WHERE id = ?`
  );
  const updRow = db.prepare(`UPDATE gift_card_redemptions SET kind = 'redeem', created_at = datetime('now') WHERE id = ?`);
  let total = 0;
  for (const h of holds) {
    updCard.run(h.amount_cents, h.amount_cents, h.gift_card_id);
    updRow.run(h.id);
    total += h.amount_cents;
  }
  return total;
}

/** Releases outstanding holds of an order (MUST be in a transaction). */
function releaseHolds(db, orderId) {
  const holds = holdsForOrder(db, orderId);
  const updCard = db.prepare(
    `UPDATE gift_cards SET held_cents = MAX(0, held_cents - ?), updated_at = datetime('now') WHERE id = ?`
  );
  const updRow = db.prepare(`UPDATE gift_card_redemptions SET kind = 'release', created_at = datetime('now') WHERE id = ?`);
  let total = 0;
  for (const h of holds) {
    updCard.run(h.amount_cents, h.gift_card_id);
    updRow.run(h.id);
    total += h.amount_cents;
  }
  return total;
}

/** Restores redeemed gift card funds back to the card(s) on a refund (MUST be in a transaction). */
function refundRedeemed(db, orderId) {
  const rows = db.prepare(
    `SELECT gift_card_id, amount_cents FROM gift_card_redemptions WHERE order_id = ? AND kind = 'redeem'`
  ).all(orderId);
  const upd = db.prepare(
    `UPDATE gift_cards SET redeemed_cents = MAX(0, redeemed_cents - ?), updated_at = datetime('now') WHERE id = ?`
  );
  const ins = db.prepare(
    `INSERT INTO gift_card_redemptions (gift_card_id, order_id, amount_cents, kind) VALUES (?, ?, ?, 'refund')`
  );
  let total = 0;
  for (const r of rows) {
    upd.run(r.amount_cents, r.gift_card_id);
    ins.run(r.gift_card_id, orderId, r.amount_cents);
    total += r.amount_cents;
  }
  return total;
}

/** Creates one or more gift cards. Returns the unhashed codes exactly once. */
function createGiftCards(db, { valueCents, expiresAt, createdBy, count = 1 }) {
  if (!Number.isInteger(valueCents) || valueCents <= 0) {
    throw new AppError(400, 'INVALID_VALUE', 'Gift card value must be a positive dollar amount');
  }
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    throw new AppError(400, 'INVALID_COUNT', 'Count must be between 1 and 50');
  }
  const codes = [];
  const ins = db.prepare(
    `INSERT INTO gift_cards (code_hash, code_masked, original_value_cents, is_active, expires_at, created_by)
     VALUES (?, ?, ?, 1, ?, ?)`
  );
  const exists = db.prepare('SELECT 1 FROM gift_cards WHERE code_hash = ?');
  for (let i = 0; i < count; i++) {
    let code;
    let hash;
    do {
      code = generateCode();
      hash = hashCode(code);
    } while (exists.get(hash));
    ins.run(hash, maskCode(code), valueCents, expiresAt || null, createdBy || null);
    codes.push(code);
  }
  return codes;
}

function listGiftCards(db) {
  return db.prepare(
    `SELECT id, code_masked, original_value_cents, redeemed_cents, held_cents,
            (original_value_cents - redeemed_cents - held_cents) AS available_cents,
            is_active, expires_at, created_at
       FROM gift_cards ORDER BY id`
  ).all();
}

function getGiftCardById(db, id) {
  return db.prepare('SELECT * FROM gift_cards WHERE id = ?').get(id) || null;
}

function toggleGiftCardActive(db, id) {
  const gc = getGiftCardById(db, id);
  if (!gc) throw new AppError(404, 'GIFT_CARD_NOT_FOUND', 'Gift card not found');
  db.prepare(`UPDATE gift_cards SET is_active = 1 - is_active, updated_at = datetime('now') WHERE id = ?`)
    .run(id);
  return getGiftCardById(db, id);
}

function redemptionsFor(db, giftCardId) {
  return db.prepare(
    `SELECT gcr.id, gcr.kind, gcr.amount_cents, gcr.created_at, o.order_number
       FROM gift_card_redemptions gcr
       LEFT JOIN orders o ON o.id = gcr.order_id
      WHERE gcr.gift_card_id = ?
      ORDER BY gcr.id DESC`
  ).all(giftCardId);
}

module.exports = {
  generateCode,
  hashCode,
  maskCode,
  normalizeCode,
  validateGiftCard,
  availableCents,
  applyHold,
  redeemHolds,
  releaseHolds,
  refundRedeemed,
  createGiftCards,
  listGiftCards,
  getGiftCardById,
  toggleGiftCardActive,
  redemptionsFor
};