'use strict';

const Stripe = require('stripe');
const wallet = require('./wallet');
const {
  AppError,
  finalizePaid,
  failOrder,
  expireOrder,
  cancelOrder,
  markRefunded,
  orderItemsWithTickets
} = require('./orders');

function createStripeClient(secretKey, opts = {}) {
  return new Stripe(secretKey || 'stripe_test_secret_placeholder', {
    apiVersion: '2024-11-20.acacia',
    maxNetworkRetries: opts.maxNetworkRetries ?? 2
  });
}

/**
 * Creates a Stripe Checkout Session for an order. Prices come from the DB row.
 * Pass `amountOverrideCents` to charge a partial amount (e.g. the balance left
 * after applying a gift card) as a single "remaining balance" line item.
 * Returns { id, url } (session).
 */
async function createCheckoutSession(config, stripe, db, { order, event, user, amountOverrideCents }) {
  let lineItems;
  if (Number.isInteger(amountOverrideCents) && amountOverrideCents > 0) {
    lineItems = [{
      price_data: {
        currency: order.currency,
        unit_amount: amountOverrideCents,
        product_data: {
          name: 'Remaining balance',
          description: `Balance due for order ${order.order_number} after gift card application`
        }
      },
      quantity: 1
    }];
  } else {
    lineItems = orderItemsWithTickets(db, order.id).map(i => ({
      price_data: {
        currency: order.currency,
        unit_amount: i.unit_price_cents,
        product_data: {
          name: `${i.event_name} - ${i.ticket_type_name}`,
          description: [i.date, `${i.venue}, ${i.city}`].filter(Boolean).join(' · ')
        }
      },
      quantity: i.quantity
    }));

    if (order.fees_cents > 0) {
      lineItems.push({
        price_data: {
          currency: order.currency,
          unit_amount: order.fees_cents,
          product_data: { name: 'Service fee & taxes' }
        },
        quantity: 1
      });
    }
  }

  const params = {
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: lineItems,
    client_reference_id: order.order_number,
    metadata: { order_number: order.order_number, order_id: String(order.id) },
    success_url: `${config.baseUrl}/confirmation.html?order=${order.order_number}&status=paid`,
    cancel_url: `${config.baseUrl}/checkout.html?event=${event.id}&cancelled=1`,
    expires_at: Math.floor(Date.now() / 1000) + config.reservationTtlMinutes * 60,
    billing_address_collection: 'auto',
    customer_email: user.email,
    payment_intent_data: { metadata: { order_number: order.order_number } }
  };

  if (config.allowSavedPaymentMethods && user.stripe_customer_id) {
    params.customer = user.stripe_customer_id;
    params.allow_payment_method_saving = true;
  } else {
    params.customer_creation = 'if_required';
  }

  let session;
  try {
    session = await stripe.checkout.sessions.create(params);
  } catch (err) {
    throw new AppError(502, 'PAYMENT_PROVIDER_ERROR',
      `Payment provider error: ${err && err.message ? err.message : 'unknown'}`);
  }
  if (!session || !session.id || !session.url) {
    throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'Payment provider did not return a checkout session');
  }
  return session;
}

/**
 * Creates a Stripe Checkout Session for a wallet top-up. The deposit is only
 * credited to the wallet when a verified webhook confirms the payment.
 * Returns { id, url } (session).
 */
async function createWalletDepositSession(config, stripe, db, { user, txnId, amountCents }) {
  const params = {
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        unit_amount: amountCents,
        product_data: {
          name: 'TicketVault wallet top-up',
          description: `Add funds to your TicketVault wallet (deposit ${txnId})`
        }
      },
      quantity: 1
    }],
    client_reference_id: txnId,
    metadata: { wallet_deposit: '1', wallet_txn_id: txnId },
    success_url: `${config.baseUrl}/add-money.html?deposit=${encodeURIComponent(txnId)}&status=success`,
    cancel_url: `${config.baseUrl}/add-money.html?deposit=${encodeURIComponent(txnId)}&status=cancelled`,
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    customer_email: user.email,
    payment_intent_data: { metadata: { wallet_deposit: '1', wallet_txn_id: txnId } }
  };

  let session;
  try {
    session = await stripe.checkout.sessions.create(params);
  } catch (err) {
    throw new AppError(502, 'PAYMENT_PROVIDER_ERROR',
      `Payment provider error: ${err && err.message ? err.message : 'unknown'}`);
  }
  if (!session || !session.id || !session.url) {
    throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'Payment provider did not return a checkout session');
  }
  return session;
}

/**
 * Verifies the Stripe webhook signature and returns the parsed event.
 */
function verifyWebhookSignature(config, stripe, payload, signature) {
  try {
    return stripe.webhooks.constructEvent(payload, signature, config.stripeWebhookSecret);
  } catch (err) {
    throw new AppError(400, 'INVALID_SIGNATURE', 'Invalid webhook signature');
  }
}

function orderNumberFromSession(event) {
  const s = event.data.object;
  return s.client_reference_id || (s.metadata && s.metadata.order_number) || null;
}

function orderNumberFromMetadata(event) {
  const m = event.data.object && event.data.object.metadata;
  return (m && m.order_number) || null;
}

function walletTxnFromObject(object) {
  const metadata = object && object.metadata;
  if (metadata && String(metadata.wallet_deposit) === '1' && metadata.wallet_txn_id) {
    return metadata.wallet_txn_id;
  }
  return null;
}

/**
 * Applies a verified Stripe event to the DB. Idempotent per Stripe event id.
 */
function handleStripeEvent(db, event) {
  const type = event.type;
  const object = event && event.data && event.data.object;
  if (!object) return { ignored: true, reason: 'missing object' };

  const walletTxnId = walletTxnFromObject(object);

  switch (type) {
    case 'checkout.session.completed': {
      if (object.payment_status !== 'paid') {
        return { ignored: true, reason: 'session not paid (async payment handled later)' };
      }
      if (walletTxnId) {
        const txn = wallet.completeDeposit(db, walletTxnId);
        return { walletDeposit: { txnId: walletTxnId, idempotent: txn.idempotent } };
      }
      const orderNumber = orderNumberFromSession(event);
      if (!orderNumber) return { ignored: true, reason: 'missing order reference' };
      const result = finalizePaid(db, event.id, orderNumber, object);
      return { ...result };
    }

    case 'checkout.session.expired': {
      if (walletTxnId) {
        const txn = wallet.failDeposit(db, walletTxnId);
        return { walletDeposit: { txnId: walletTxnId, status: txn.status, idempotent: txn.idempotent } };
      }
      const orderNumber = orderNumberFromSession(event);
      if (!orderNumber) return { ignored: true, reason: 'missing order reference' };
      const order = expireOrder(db, orderNumber);
      return { order };
    }

    case 'payment_intent.succeeded': {
      if (walletTxnId) {
        const txn = wallet.completeDeposit(db, walletTxnId);
        return { walletDeposit: { txnId: walletTxnId, idempotent: txn.idempotent } };
      }
      const orderNumber = orderNumberFromMetadata(event);
      if (!orderNumber) return { ignored: true, reason: 'missing order reference' };
      const result = finalizePaid(db, event.id, orderNumber, { payment_intent: object.id });
      return { ...result };
    }

    case 'payment_intent.payment_failed': {
      if (walletTxnId) {
        const txn = wallet.failDeposit(db, walletTxnId);
        return { walletDeposit: { txnId: walletTxnId, status: txn.status, idempotent: txn.idempotent } };
      }
      const orderNumber = orderNumberFromMetadata(event);
      if (!orderNumber) return { ignored: true, reason: 'missing order reference' };
      const result = failOrder(db, event.id, orderNumber,
        object.last_payment_error && object.last_payment_error.message);
      return { ...result };
    }

    case 'payment_intent.canceled': {
      if (walletTxnId) {
        const txn = wallet.failDeposit(db, walletTxnId);
        return { walletDeposit: { txnId: walletTxnId, status: txn.status, idempotent: txn.idempotent } };
      }
      const orderNumber = orderNumberFromMetadata(event);
      if (!orderNumber) return { ignored: true, reason: 'missing order reference' };
      const order = cancelOrder(db, orderNumber);
      return { order };
    }

    case 'charge.refunded':
    case 'refund.updated': {
      const paymentIntentId = object.payment_intent;
      const result = markRefunded(db, event.id, paymentIntentId);
      return { ...result };
    }

    default:
      return { ignored: true, reason: `unhandled event type ${type}` };
  }
}

module.exports = {
  createStripeClient,
  createCheckoutSession,
  createWalletDepositSession,
  verifyWebhookSignature,
  handleStripeEvent
};