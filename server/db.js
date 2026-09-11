'use strict';

const { DatabaseSync } = require('node:sqlite');

function withImmediateTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function rowid(result) {
  return Number(result.lastInsertRowid);
}

function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      performer TEXT,
      venue TEXT NOT NULL,
      city TEXT NOT NULL,
      date TEXT,
      category TEXT,
      subcategory TEXT,
      description TEXT,
      image_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ticket_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      total_quantity INTEGER NOT NULL DEFAULT 0 CHECK (total_quantity >= 0),
      sold_quantity INTEGER NOT NULL DEFAULT 0 CHECK (sold_quantity >= 0),
      reserved_quantity INTEGER NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_types_event ON ticket_types(event_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_types_avail
      ON ticket_types(event_id, total_quantity, sold_quantity, reserved_quantity);

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
      stripe_customer_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','paid','failed','cancelled','expired','refunded')),
      currency TEXT NOT NULL DEFAULT 'usd',
      subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
      fees_cents INTEGER NOT NULL DEFAULT 0 CHECK (fees_cents >= 0),
      discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
      gift_card_cents INTEGER NOT NULL DEFAULT 0 CHECK (gift_card_cents >= 0),
      total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
      payment_method TEXT,
      checkout_session_id TEXT UNIQUE,
      payment_intent_id TEXT,
      paid_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      ticket_type_id INTEGER NOT NULL REFERENCES ticket_types(id),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0)
    );
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      provider TEXT NOT NULL DEFAULT 'stripe',
      provider_payment_id TEXT UNIQUE,
      provider_order_id TEXT,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'usd',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','requires_action','processing','succeeded','failed','refunded')),
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

    CREATE TABLE IF NOT EXISTS webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      order_id INTEGER,
      processed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS gift_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code_hash TEXT NOT NULL UNIQUE,
      code_masked TEXT NOT NULL,
      original_value_cents INTEGER NOT NULL CHECK (original_value_cents > 0),
      redeemed_cents INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_cents >= 0),
      held_cents INTEGER NOT NULL DEFAULT 0 CHECK (held_cents >= 0),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_gift_cards_active ON gift_cards(is_active);

    CREATE TABLE IF NOT EXISTS gift_card_redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gift_card_id INTEGER NOT NULL REFERENCES gift_cards(id),
      order_id INTEGER REFERENCES orders(id),
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      kind TEXT NOT NULL CHECK (kind IN ('hold','redeem','release','refund')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_gcr_card ON gift_card_redemptions(gift_card_id);
    CREATE INDEX IF NOT EXISTS idx_gcr_order ON gift_card_redemptions(order_id);

    CREATE TABLE IF NOT EXISTS wallets (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      txn_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL
        CHECK (kind IN ('deposit','order_payment','refund','adjustment')),
      amount_cents INTEGER NOT NULL,
      method TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','completed','failed')),
      reference TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON wallet_transactions(user_id, id);
    CREATE INDEX IF NOT EXISTS idx_wallet_tx_status ON wallet_transactions(status);
    CREATE INDEX IF NOT EXISTS idx_wallet_tx_ref ON wallet_transactions(kind, reference);

    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user_id INTEGER,
      admin_email TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      details TEXT,
      ip TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_log(action);
  `);

  ensureColumn(db, 'orders', 'discount_cents', 'INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0)');
  ensureColumn(db, 'orders', 'gift_card_cents', 'INTEGER NOT NULL DEFAULT 0 CHECK (gift_card_cents >= 0)');
  ensureColumn(db, 'orders', 'payment_method', 'TEXT');
  ensureColumn(db, 'payments', 'provider_order_id', 'TEXT');
  ensureColumn(db, 'gift_cards', 'updated_at', 'TEXT');
}

function initDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  initSchema(db);
  return db;
}

module.exports = { initDb, initSchema, withImmediateTransaction, rowid };