# TicketVault Replica — Implementation Report

End-to-end gift cards and PayPal support added to the existing Stripe-powered ticketing app.
Payment now supports three instruments: card (Stripe), PayPal, and TicketVault gift cards,
including mixed payment (gift card + remainder via card or PayPal) and full gift-card coverage.

## Status

- API + backend: complete, 61/61 tests passing (`npm test`).
- Frontend: checkout payment-method UI, admin gift-card management, confirmation payment details — complete.
- Verified: `npm run db:reset && npm start` boots and seeds 3 demo gift cards whose full
  codes are printed to the console exactly once.

## Schema (added in `server/db.js`)

```
gift_cards(id, code)              -- SHA-256 of normalized code; plaintext never stored
  original_value_cents, redeemed_cents, held_cents, expires_at, active, code_masked, created_at, updated_at
  available = original_value_cents - redeemed_cents - held_cents

gift_card_redemptions(id, order_id FK, gift_card_id FK, amount_cents, created_at)

payments(id, order_id, amount_cents, provider, provider_payment_id, provider_status, event_type, created_at)
  -- one row per (provider, payment); completed captures AND pending PayPal orders get a row (idempotency)

webhook_events(id, event_id, provider, payload, created_at)
  -- dedupe ledger for Stripe + PayPal webhooks
```

Migration pattern: `ensureColumn(db, table, column, TEXT)` adds columns to existing DBs at boot.

## Gift card rules

- Code format `GC-XXXX-XXXX-XXXX-XXXX`; only `SHA256(normalized)` is stored
  (`normalized` = stripped non-alphanumerics, uppercased). Members see `code_masked`.
- Full code is returned only at creation time (admin create / demo seed). Administrator must save it.
- Holds: applying a card at checkout reserves value inside a `BEGIN IMMEDIATE` transaction
  together with ticket-inventory reservation (no "phantom overspend").
- Redeem on payment; release hold on cancel / expiry / declined payment; restore balance on refund.
- A hold expires after `RESERVATION_TTL_MINUTES`.
- Cards are single-use per order; combination of multiple cards per order is intentionally not supported.
- `active = 0` and past `expires_at` reject application.

## API surface

Checkout / payment:

- `POST /api/orders` — create pending order, Stripe Checkout session. `paymentMethod: 'card'`.
- `POST /api/orders/paypal` — create pending order + PayPal Order (custom_id = order number), returns `approveUrl`.
- `POST /api/orders/gift-card` — apply gift code to new/existing pending reservation.
  Validates card/customer/inventory; hold + inventory reservation. Response:
  `{ orderNumber, totalCents, appliedCents, remainingCents, giftCardCovered, paymentMethod }`.
- `POST /api/orders/:orderNumber/pay-remaining/card` — Stripe Checkout for the exact remainder.
- `POST /api/orders/:orderNumber/pay-remaining/paypal` — Stripe… PayPal order for the remainder.
- `POST /api/orders/:orderNumber/gift-card/complete` — finalize order paid entirely by gift card
  (idempotent; returns `{ order, idempotent }`).
- `POST /api/orders/:orderNumber/paypal/capture` — server-side capture + local settlement.
- `GET /api/gift-cards/validate` — validate a code without touching balance.
- `POST /api/orders/:orderNumber/retry` — gift-card aware (preserves applied balance, opens remainder gateway).

Webhooks (idempotent via `webhook_events`):

- `POST /webhook/stripe` — existing.
- `POST /webhook/paypal` — `handlePayPalEvent`:
  PAYMENT.CAPTURE.COMPLETED → settle order (`paidCents = total - gift_card_cents`);
  DENIED / PAYMENT.CAPTURE.DENIED / FAILED → `failOrder(provider='paypal')` releases hold + inventory;
  REFUNDED / REVERSED → `markRefunded` (restores gift balance); CHECKOUT.ORDER.APPROVED → ignored.

Admin:

- `GET /api/admin/orders` — orders now include payment method / gift card totals.
- `POST /api/admin/orders/:id/refund` — refunds Stripe, PayPal (refundCapture) or gift-card-only
  (restores balance via `gift_card_redemptions.provider_payment_id`).
- `GET /api/admin/gift-cards`, `POST /api/admin/gift-cards` (returns full codes once),
  `POST /api/admin/gift-cards/:id/toggle`, `GET /api/admin/gift-cards/:id/redemptions`.

## Frontend

- `checkout.html` / `js/checkout.js` / `css/checkout.css` — payment method radios
  (card / PayPal / gift card), gift-code entry + apply, applied-amount + remaining-balance summary
  rows, and dynamic button labels (Continue with PayPal / Pay remaining with card / Place order).
  Gift-card-only orders skip the gateway and land straight on the confirmation page.
- `admin.html` / `js/admin.js` / `css/admin.css` — Orders / Gift cards tabs; create cards
  (codes shown once), activate/deactivate, view redemption history; order table shows method/gift info.
- `confirmation.js` — payment details block: method, gift-card amount, amount paid via provider,
  reference, refunded / gift-card-only notes.

## Environment variables

| Var | Purpose |
| --- | --- |
| `PAYMENT_SECRET_KEY` / `PAYMENT_WEBHOOK_SECRET` / `PAYMENT_PUBLISHABLE_KEY` | Stripe + webhook secret |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal OAuth credentials (shown as WARNING if unset) |
| `PAYPAL_MODE` | `sandbox` (default) or `live` |
| `PAYPAL_WEBHOOK_ID` | PayPal webhook ID, for signature verification |
| `PAYPAL_MERCHANT_EMAIL` | optional seller PayPal email → `purchase_units[].payee` |
| `GIFT_CARD_DEFAULT_LIFE_DAYS` | gift card validity, default 365 |

## PayPal sandbox setup

1. Create a Sandbox REST App at developer.paypal.com → credentials for `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`.
2. Set `PAYPAL_WEBHOOK_ID` via *Webhooks events* in the app, or the API. Sandbox mode omits
   webhook signature verification when only the ID is missing (see `paypal.js`), making local testing easy.
3. Add a Webhook (`/v2/checkout/orders` capture + `/v2/payments/captures` refund events) pointing at
   `<BASE_URL>/webhook/paypal`.
4. Use the sandbox buyer account to approve orders; the app captures and settles automatically.

## Demo data

`npm run db:reset` / first boot seeds 3 × $500 gift cards; full codes print to the console once.
Re-seeding is idempotent (skips when cards already exist). Default admin: `admin@ticketvault.test` / `adminpass123`,
customer: `customer@ticketvault.test` / `password123`.

## Notes & security

- All monetary values are integer cents internally; fees fixed at `FEE_RATE` (0.10).
- Idempotency everywhere: payment row per provider, webhook dedupe, gift-card/complete idempotent returns.
- No secrets logged; a rate limiter wraps gift-card endpoints.
- Node quirk: this project's Node v24.21.0 build rejects `as` in destructuring — alias imports are
  done via an extra `require`, not `{ x as y }`.