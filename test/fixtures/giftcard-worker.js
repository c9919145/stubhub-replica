'use strict';

/**
 * Worker for the gift-card concurrency test. Creates a pending order while
 * applying a gift-card hold, all in one transaction; reports the outcome.
 */
const { parentPort, workerData } = require('node:worker_threads');

const { initDb } = require(workerData.dbFilePath);
const { createOrderWithGiftCard } = require(workerData.orderFilePath);

const db = initDb(workerData.dbPath);
try {
  createOrderWithGiftCard(db, {
    userId: workerData.userId,
    userEmail: workerData.userEmail,
    eventId: workerData.eventId,
    items: [{ ticketTypeId: workerData.ticketTypeId, quantity: 1 }],
    feeRate: workerData.feeRate,
    giftCardCode: workerData.giftCardCode
  });
  parentPort.postMessage({ ok: true });
} catch (err) {
  parentPort.postMessage({ ok: false, code: err.code || 'UNKNOWN', message: err.message });
} finally {
  try { db.close(); } catch (e) { /* ignore */ }
}