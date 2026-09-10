'use strict';

const crypto = require('node:crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function createSession(db, userId, ttlHours) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + ttlHours * 3600 * 1000;
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  return token;
}

function deleteSession(db, token) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
}

function deleteExpiredSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

function getUserBySession(db, token) {
  if (!token) return null;
  deleteExpiredSessions(db);
  return db.prepare(
    `SELECT u.id, u.email, u.name, u.is_admin, u.stripe_customer_id
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?`
  ).get(token, Date.now()) || null;
}

function getPublicUser(user) {
  if (!user) return null;
  return { id: user.id, email: user.email, name: user.name, isAdmin: Boolean(user.is_admin) };
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  deleteSession,
  deleteExpiredSessions,
  getUserBySession,
  getPublicUser
};