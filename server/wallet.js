'use strict';

const crypto = require('node:crypto');
const { withImmediateTransaction } = require('./db');
const { AppError } = require('./errors');

const MIN_DEPOSIT_CENTS = 100;          // $1.00
const MAX_DEPOSIT_CENTS = 5000000;      // $50,000
const AVAILABLE_DEPOSIT_METHODS = ['card', 'btc', 'eth'];

const DEPOSIT_METHODS = {
  card: { label: 'Credit Card' },
  btc: { label: 'BTC / Bitcoin', network: 'Bitcoin (BTC)', crypto: 'btc' },
  eth: { label: 'Ethereum / USDT (ERC-20)', network: 'Ethereum (ETH, ERC-20)', crypto: 'eth' }
};

/** Methods that exist as checkout options but have no configured instructions yet. */
const UNAVAILABLE_METHODS = ['usdt', 'cash_app', 'money_order', 'zelle'];

function generateTxnId() {
  const n = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `WV-${n}`;
}

/** Must run inside an open transaction. */
function ensureWalletRow(db, userId) {
  db.prepare('INSERT OR IGNORE INTO wallets (user_id, balance_cents) VALUES (?, 0)').run(userId);
}

function nowIso() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * In-transaction primitive: inserts a wallet transaction row. Does NOT touch the
 * wallet balance; callers decide whether/how to credit or debit.
 */
function insertTxn(db, { userId, txnId, kind, amountCents, method, status = 'pending', reference = null, completedAt = null }) {
  db.prepare(
    `INSERT INTO wallet_transactions (user_id, txn_id, kind, amount_cents, method, status, reference, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, txnId, kind, amountCents, method || null, status, reference || null, completedAt);
}

/**
 * In-transaction primitive: credits the wallet and marks a transaction completed.
 * Idempotent per txn_id (a completed txn is never applied twice).
 */
function applyCredit(db, { userId, amountCents, txnId, kind, method, reference }) {
  ensureWalletRow(db, userId);
  const existing = db.prepare('SELECT status FROM wallet_transactions WHERE txn_id = ?').get(txnId);
  if (existing) {
    if (existing.status === 'completed') return { idempotent: true };
    throw new AppError(409, 'TXN_ALREADY_USED', 'This deposit reference has already been processed');
  }
  db.prepare(
    `UPDATE wallets SET balance_cents = balance_cents + ?, updated_at = datetime('now') WHERE user_id = ?`
  ).run(amountCents, userId);
  insertTxn(db, { userId, txnId, kind, amountCents, method, status: 'completed', reference, completedAt: nowIso() });
  return { idempotent: false };
}

/**
 * In-transaction primitive: debits the wallet and marks a transaction completed.
 * Refuses to go negative. throws AppError(409, 'INSUFFICIENT_WALLET_BALANCE').
 */
function applyDebit(db, { userId, amountCents, txnId, kind, method, reference }) {
  if (amountCents <= 0) throw new AppError(400, 'INVALID_AMOUNT', 'Amount must be greater than zero');
  ensureWalletRow(db, userId);
  const wallet = db.prepare('SELECT balance_cents FROM wallets WHERE user_id = ?').get(userId);
  if (!wallet || wallet.balance_cents < amountCents) {
    throw new AppError(409, 'INSUFFICIENT_WALLET_BALANCE', 'Your wallet balance is too low to complete this payment');
  }
  db.prepare(
    `UPDATE wallets SET balance_cents = balance_cents - ?, updated_at = datetime('now') WHERE user_id = ?`
  ).run(amountCents, userId);
  insertTxn(db, { userId, txnId, kind, amountCents, method, status: 'completed', reference, completedAt: nowIso() });
  return wallet.balance_cents - amountCents;
}

/** Same as applyDebit but reference-based idempotency check first (used for order payments). */
function applyDebitForOrder(db, { userId, amountCents, reference }) {
  const already = db.prepare(
    `SELECT 1 FROM wallet_transactions WHERE user_id = ? AND kind = 'order_payment' AND reference = ? AND status = 'completed' LIMIT 1`
  ).get(userId, reference);
  if (already) return { idempotent: true };
  const txnId = generateTxnId();
  const remaining = applyDebit(db, { userId, amountCents, txnId, kind: 'order_payment', method: 'wallet', reference });
  return { idempotent: false, txnId, remaining };
}

/** Create a PENDING deposit. The balance is NOT touched here. */
function createDeposit(db, { userId, amountCents, method }) {
  const m = String(method || '');
  if (!Number.isInteger(amountCents) || amountCents < MIN_DEPOSIT_CENTS || amountCents > MAX_DEPOSIT_CENTS) {
    throw new AppError(400, 'INVALID_AMOUNT',
      `Deposit must be between $${(MIN_DEPOSIT_CENTS / 100).toFixed(0)} and $${(MAX_DEPOSIT_CENTS / 100).toLocaleString()}`);
  }
  if (!AVAILABLE_DEPOSIT_METHODS.includes(m)) {
    throw new AppError(409, 'METHOD_UNAVAILABLE', 'This payment method is currently unavailable');
  }
  const txnId = generateTxnId();
  insertTxn(db, { userId, txnId, kind: 'deposit', amountCents, method: m, status: 'pending' });
  return { txn_id: txnId, user_id: userId, kind: 'deposit', amount_cents: amountCents, method: m, status: 'pending' };
}

/** Only credit the balance after a payment provider has confirmed the deposit. */
function completeDeposit(db, txnId) {
  return withImmediateTransaction(db, () => {
    const txn = db.prepare('SELECT * FROM wallet_transactions WHERE txn_id = ?').get(txnId);
    if (!txn) throw new AppError(404, 'DEPOSIT_NOT_FOUND', 'Deposit not found');
    if (txn.kind !== 'deposit') throw new AppError(409, 'NOT_A_DEPOSIT', 'Transaction is not a wallet deposit');
    if (txn.status === 'completed') return { ...txn, idempotent: true };
    if (txn.status === 'failed') throw new AppError(409, 'DEPOSIT_FAILED', 'This deposit was already marked failed');
    ensureWalletRow(db, txn.user_id);
    db.prepare(
      `UPDATE wallets SET balance_cents = balance_cents + ?, updated_at = datetime('now') WHERE user_id = ?`
    ).run(txn.amount_cents, txn.user_id);
    db.prepare(
      `UPDATE wallet_transactions SET status = 'completed', completed_at = datetime('now') WHERE txn_id = ?`
    ).run(txnId);
    return { ...txn, status: 'completed', idempotent: false };
  });
}

/** Mark a pending deposit as failed (e.g. payment provider reported failure). */
function failDeposit(db, txnId) {
  return withImmediateTransaction(db, () => {
    const txn = db.prepare('SELECT * FROM wallet_transactions WHERE txn_id = ?').get(txnId);
    if (!txn) throw new AppError(404, 'DEPOSIT_NOT_FOUND', 'Deposit not found');
    if (txn.kind !== 'deposit') throw new AppError(409, 'NOT_A_DEPOSIT', 'Transaction is not a wallet deposit');
    if (txn.status === 'failed') return { ...txn, idempotent: true };
    if (txn.status === 'completed') throw new AppError(409, 'DEPOSIT_COMPLETED', 'This deposit was already completed');
    db.prepare(
      `UPDATE wallet_transactions SET status = 'failed', completed_at = datetime('now') WHERE txn_id = ?`
    ).run(txnId);
    return { ...txn, status: 'failed', idempotent: false };
  });
}

/** Restore funds when an order paid by wallet is refunded. Idempotent per reference. */
function creditOrderRefund(db, { userId, reference, orderTotalCents }) {
  return withImmediateTransaction(db, () => {
    ensureWalletRow(db, userId);
    const already = db.prepare(
      `SELECT 1 FROM wallet_transactions WHERE user_id = ? AND kind = 'refund' AND reference = ? AND status = 'completed' LIMIT 1`
    ).get(userId, reference);
    if (already) return { idempotent: true };
    const txnId = generateTxnId();
    db.prepare(
      `UPDATE wallets SET balance_cents = balance_cents + ?, updated_at = datetime('now') WHERE user_id = ?`
    ).run(orderTotalCents, userId);
    insertTxn(db, { userId, txnId, kind: 'refund', amountCents: orderTotalCents, method: 'wallet', status: 'completed', reference, completedAt: nowIso() });
    return { idempotent: false, txnId };
  });
}

function getWallet(db, userId) {
  const row = db.prepare('SELECT balance_cents FROM wallets WHERE user_id = ?').get(userId);
  const balanceCents = row ? row.balance_cents : 0;
  const transactions = db.prepare(
    `SELECT txn_id AS id, kind, amount_cents AS amountCents, method, status, reference,
            created_at AS createdAt, completed_at AS completedAt
       FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100`
  ).all(userId);
  return { balanceCents, transactions };
}

function cryptoInfo(config, method) {
  const m = String(method || '').toLowerCase();
  if (m === 'btc') {
    return {
      network: DEPOSIT_METHODS.btc.network,
      address: config.walletBtcAddress,
      qrImage: '/assets/images/qr-btc.png'
    };
  }
  if (m === 'eth') {
    return {
      network: DEPOSIT_METHODS.eth.network,
      address: config.walletEthAddress,
      qrImage: '/assets/images/qr-eth.png'
    };
  }
  throw new AppError(400, 'INVALID_METHOD', 'Select BTC or ETH');
}

/** Admin: pending deposits that await on-chain / manual confirmation. */
function listPendingDeposits(db, limit = 100) {
  return db.prepare(
    `SELECT wt.txn_id AS txnId, wt.user_id AS userId, u.email, u.name,
            wt.amount_cents AS amountCents, wt.method, wt.status, wt.created_at AS createdAt
       FROM wallet_transactions wt
       JOIN users u ON u.id = wt.user_id
      WHERE wt.kind = 'deposit' AND wt.status = 'pending'
      ORDER BY wt.id DESC
      LIMIT ?`
  ).all(Math.min(Math.max(Number(limit) || 100, 1), 500));
}

/** Admin: recent wallet transaction feed across all users. */
function listAdminWalletTxns(db, limit = 200) {
  return db.prepare(
    `SELECT wt.txn_id AS txnId, wt.user_id AS userId, u.email,
            wt.kind, wt.amount_cents AS amountCents, wt.method, wt.status,
            wt.reference, wt.created_at AS createdAt, wt.completed_at AS completedAt
       FROM wallet_transactions wt
       LEFT JOIN users u ON u.id = wt.user_id
      ORDER BY wt.id DESC
      LIMIT ?`
  ).all(Math.min(Math.max(Number(limit) || 200, 1), 500));
}

module.exports = {
  MIN_DEPOSIT_CENTS,
  MAX_DEPOSIT_CENTS,
  DEPOSIT_METHODS,
  UNAVAILABLE_METHODS,
  AVAILABLE_DEPOSIT_METHODS,
  generateTxnId,
  ensureWalletRow,
  insertTxn,
  applyCredit,
  applyDebit,
  applyDebitForOrder,
  createDeposit,
  completeDeposit,
  failDeposit,
  creditOrderRefund,
  getWallet,
  cryptoInfo,
  listPendingDeposits,
  listAdminWalletTxns,
  withImmediateTransaction
};