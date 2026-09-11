'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { loadConfig } = require('./config');
const { initDb } = require('./db');
const auth = require('./auth');
const giftcards = require('./giftcards');

const SEED_DATA = path.join(__dirname, 'seed-data.json');

const TIERS = [
  { name: 'Standard', description: 'General admission entry with a great view.', multiplier: 1.0, quantity: 120 },
  { name: 'Premium', description: 'Premium seating closer to the stage/field.', multiplier: 1.6, quantity: 60 },
  { name: 'VIP', description: 'VIP package: best seats + priority entry.', multiplier: 2.4, quantity: 30 }
];

const DEMO_CUSTOMER = { email: 'customer@ticketvault.test', password: 'password123', name: 'Alex Johnson' };

function resetDb(dbPath) {
  if (dbPath === ':memory:') {
    const db = initDb(dbPath);
    db.exec(`DROP TABLE IF EXISTS webhook_events; DROP TABLE IF EXISTS payments; DROP TABLE IF EXISTS order_items;
             DROP TABLE IF EXISTS orders; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS users;
             DROP TABLE IF EXISTS ticket_types; DROP TABLE IF EXISTS events;
             DROP TABLE IF EXISTS gift_card_redemptions; DROP TABLE IF EXISTS gift_cards;`);
    return db;
  }
  const abs = path.isAbsolute(dbPath) ? dbPath : path.resolve(dbPath);
  if (fs.existsSync(abs)) fs.rmSync(abs);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (fs.existsSync(abs + suffix)) fs.rmSync(abs + suffix);
  }
  return initDb(dbPath);
}

function seedUsers(db, config) {
  const upsert = db.prepare(
    `INSERT INTO users (email, name, password_hash, is_admin) VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, is_admin = excluded.is_admin`
  );
  upsert.run(config.adminEmail.trim().toLowerCase(), 'Site Admin', auth.hashPassword(config.adminPassword), 1);
  const cu = upsert.run(DEMO_CUSTOMER.email, DEMO_CUSTOMER.name, auth.hashPassword(DEMO_CUSTOMER.password), 0);
  console.log('[seed] users ready');
  return { admin: config.adminEmail, customer: DEMO_CUSTOMER.email };
}

function seedEvents(db) {
  const raw = JSON.parse(fs.readFileSync(SEED_DATA, 'utf8'));
  const insEvent = db.prepare(
    `INSERT OR IGNORE INTO events (id, name, performer, venue, city, date, category, subcategory, description, image_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insType = db.prepare(
    `INSERT INTO ticket_types (event_id, name, description, price_cents, total_quantity) VALUES (?, ?, ?, ?, ?)`
  );
  const hasTypes = db.prepare('SELECT COUNT(*) AS c FROM ticket_types WHERE event_id = ?');

  let created = 0;
  for (const e of raw) {
    insEvent.run(e.id, e.name, e.performer, e.venue, e.city, e.date, e.category, e.subcategory, e.description, e.image_url);
    if (hasTypes.get(e.id).c === 0) {
      const basePrice = Math.round(Number(e.basePriceCents) || 0);
      TIERS.forEach(t => {
        const soldOut = Boolean(e.soldOut);
        insType.run(
          e.id,
          t.name,
          t.description,
          Math.round(basePrice * t.multiplier),
          soldOut ? 0 : t.quantity
        );
      });
      created++;
    }
  }
  console.log(`[seed] ${raw.length} events present (${created} event(s) got fresh ticket inventory)`);
}

/**
 * Idempotently seeds demo gift cards (only when none exist). Full codes are
 * returned and printed exactly once so admins can copy them down.
 */
function seedGiftCards(db, config) {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM gift_cards').get().c;
  if (existing > 0) {
    console.log('[seed] gift cards already present; skipping demo codes');
    return [];
  }
  const admin = db.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').get();
  const lifeDays = config.giftCardDefaultLifeDays || 365;
  const expiresAt = new Date(Date.now() + lifeDays * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const codes = giftcards.createGiftCards(db, {
    valueCents: 50000,
    expiresAt,
    createdBy: admin ? admin.id : null,
    count: 3
  });
  console.log('[seed] demo gift cards created (value $500.00 each, full codes printed once):');
  codes.forEach(c => console.log('   ' + c));
  return codes;
}

function main() {
  const config = loadConfig();
  const reset = process.argv.includes('--reset');
  const db = reset ? resetDb(config.dbPath) : initDb(config.dbPath);
  seedEvents(db);
  const users = seedUsers(db, config);
  seedGiftCards(db, config);
  db.close();
  console.log('[seed] done. admin=' + users.admin + ' customer=' + users.customer);
}

if (require.main === module) main();

module.exports = { resetDb, seedUsers, seedEvents, seedGiftCards };