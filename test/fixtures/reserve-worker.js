'use strict';

/**
 * Worker for the concurrency test. Reserves inventory for a single ticket type
 * via createOrder; reports the outcome to the parent thread.
 */
const { parentPort, workerData } = require('node:worker_threads');

const { initDb } = require(workerData.dbFilePath);
const { createOrder } = require(workerData.orderFilePath);

const db = initDb(workerData.dbPath);
try {
  createOrder(db, {
    userId: workerData.userId,
    userEmail: workerData.userEmail,
    eventId: workerData.eventId,
    items: [{ ticketTypeId: workerData.ticketTypeId, quantity: 1 }]
  });
  parentPort.postMessage({ ok: true });
} catch (err) {
  parentPort.postMessage({ ok: false, code: err.code || 'UNKNOWN', message: err.message });
} finally {
  try { db.close(); } catch (e) { /* ignore */ }
}