'use strict';

function logAudit(db, { adminUserId, adminEmail, action, target, details, ip }) {
  try {
    db.prepare(`
      INSERT INTO admin_audit_log (admin_user_id, admin_email, action, target, details, ip)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(adminUserId || null, String(adminEmail || ''), String(action), target || null, details || null, ip || null);
  } catch (err) {
    // Auditing must never break the request it is recording.
    process.emitWarning(`Failed to write admin audit log: ${err.message}`);
  }
}

function listAudit(db, limit = 200) {
  return db.prepare(`
    SELECT id, admin_email, action, target, details, ip, created_at
    FROM admin_audit_log
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
}

module.exports = { logAudit, listAudit };