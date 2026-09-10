'use strict';

const { AppError } = require('./errors');

const SANDBOX_API = 'https://api-m.sandbox.paypal.com';
const LIVE_API = 'https://api-m.paypal.com';

function apiBase(mode) {
  return mode === 'live' ? LIVE_API : SANDBOX_API;
}

function centsToDollars(cents) {
  return (Number(cents) / 100).toFixed(2);
}

function isConfigured(config) {
  return Boolean(
    config.paypalClientId &&
    config.paypalClientSecret &&
    !config.paypalClientId.startsWith('PAYPAL_') &&
    !config.paypalClientSecret.startsWith('PAYPAL_')
  );
}

function paypalError(res, body) {
  const detail = body && (body.message || body.error_description) ? `${body.error}: ${body.message || body.error_description}` : `HTTP ${res.status}`;
  return new AppError(502, 'PAYPAL_API_ERROR', `PayPal API error: ${detail}`);
}

/**
 * Thin client over the official PayPal REST API (Orders v2, Payments refs v2,
 * Webhooks v1) using Node's built-in fetch. No SDK install required and easy to
 * mock in tests via dependency injection.
 */
class PayPalClient {
  constructor(config, fetchImpl = global.fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.base = apiBase(config.paypalMode);
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async _request(path, { method = 'GET', body, headers = {}, token = true } = {}) {
    const requestHeaders = { ...headers };
    if (token) {
      requestHeaders.Authorization = `Bearer ${await this.accessToken()}`;
    }
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';

    let res;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: requestHeaders,
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (err) {
      throw new AppError(502, 'PAYPAL_NETWORK_ERROR', `PayPal request failed: ${err.message}`);
    }

    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) throw paypalError(res, parsed);
    return parsed;
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 30 * 1000) return this.token;

    const basic = Buffer.from(`${this.config.paypalClientId}:${this.config.paypalClientSecret}`).toString('base64');
    let res;
    try {
      res = await this.fetchImpl(`${this.base}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
      });
    } catch (err) {
      throw new AppError(502, 'PAYPAL_AUTH_ERROR', `PayPal auth request failed: ${err.message}`);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw paypalError(res, body);
    this.token = body.access_token;
    this.tokenExpiresAt = Date.now() + Number(body.expires_in || 3600) * 1000;
    return this.token;
  }

  /** Creates a PayPal order (intent CAPTURE) for the given amount. */
  async createOrder({ amountCents, orderNumber, returnUrl, cancelUrl }) {
    if (!isConfigured(this.config)) {
      throw new AppError(503, 'PAYMENT_NOT_CONFIGURED', 'PayPal is not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.');
    }
    const body = {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: 'default',
        custom_id: orderNumber,
        description: `StubHub order ${orderNumber}`,
        amount: {
          currency_code: 'USD',
          value: centsToDollars(amountCents)
        }
      }],
      application_context: {
        brand_name: 'StubHub',
        locale: 'en-US',
        landing_page: 'BILLING',
        user_action: 'PAY_NOW',
        return_url: returnUrl,
        cancel_url: cancelUrl,
        shipping_preference: 'NO_SHIPPING'
      }
    };
    if (this.config.paypalMerchantEmail) {
      body.purchase_units[0].payee = { email_address: this.config.paypalMerchantEmail };
    }

    const created = await this._request('/v2/checkout/orders', { method: 'POST', body });
    const approve = (created.links || []).find(l => l.rel === 'approve');
    if (!approve) throw new AppError(502, 'PAYPAL_NO_APPROVE_LINK', 'PayPal did not return an approval link');
    return { id: created.id, status: created.status, approveUrl: approve.href };
  }

  /** Captures an approved PayPal order. */
  async captureOrder(orderId) {
    if (!isConfigured(this.config)) {
      throw new AppError(503, 'PAYMENT_NOT_CONFIGURED', 'PayPal is not configured.');
    }
    return this._request(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: 'POST',
      body: {}
    });
  }

  /** Refunds a captured payment. */
  async refundCapture(captureId) {
    if (!isConfigured(this.config)) {
      throw new AppError(503, 'PAYMENT_NOT_CONFIGURED', 'PayPal is not configured.');
    }
    return this._request(`/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      method: 'POST',
      body: {}
    });
  }

  /**
   * Verifies a webhook signature against the PayPal Webhooks v1 API using the
   * transmission headers PayPal sends. Returns true when verification SUCCESS.
   */
  async verifyWebhookSignature({ eventBody, headers }) {
    if (!isConfigured(this.config)) {
      throw new AppError(400, 'INVALID_SIGNATURE', 'PayPal webhook cannot be verified (provider not configured)');
    }
    const transmissionId = headers['paypal-transmission-id'];
    const transmissionTime = headers['paypal-transmission-time'];
    const certUrl = headers['paypal-cert-url'];
    const authAlgo = headers['paypal-auth-algo'];
    const transmissionSig = headers['paypal-transmission-sig'];
    if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
      throw new AppError(400, 'INVALID_SIGNATURE', 'Missing PayPal webhook transmission headers');
    }
    const body = {
      auth_algo: authAlgo,
      cert_url: certUrl,
      transmission_id: transmissionId,
      transmission_sig: transmissionSig,
      transmission_time: transmissionTime,
      webhook_id: this.config.paypalWebhookId || '',
      webhook_event: eventBody
    };
    const result = await this._request('/v1/notifications/verify-webhook-signature', { method: 'POST', body });
    if (result.verification_status === 'SUCCESS') return true;
    throw new AppError(400, 'INVALID_SIGNATURE', 'PayPal webhook signature verification failed');
  }
}

module.exports = { PayPalClient, apiBase, centsToDollars, isConfigured };