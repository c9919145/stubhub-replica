# TicketVault Replica — Implementation Report

The existing Stripe-powered ticketing app now supports signup fix, card (Stripe), PayPal, gift cards,
and a first-party **Customer Wallet**: balance top-up (Add Money), instant wallet checkout, and verified
BTC/ETH crypto payments that remain PENDING until confirmed on-chain. Unavailable methods
(USDT / Cash App / Money Order / Zelle) are displayed but disabled.

## Status

- API + backend: complete, **76/76 tests passing** (`npm test`).
- Frontend: customer account dashboard, Add Money top-up, checkout payment-method UI (wallet + crypto),
  confirmation payment details, and an admin **Wallet & crypto** tab — complete.
- Verified: `npm run db:reset && npm start` boots and seeds demo data and serves all pages.
- **Deployment reality:** the repo deploys as static files to **GitHub Pages**, which cannot run `/api/*`.
  Signup, wallet, and checkout only function behind a running Node server (`npm start`). See
  *Run & deploy* below.

## Schema (in `server/db.js`)

```
gift_cards(id, code)              -- SHA-256 of normalized code; plaintext never stored
  original_value_cents, redeemed_cents, held_cents, expires_at, active, code_masked, created_at, updated_at
  available = original_value_cents - redeemed_cents - held_cents

gift_card_redemptions(id, order_id FK, gift_card_id FK, amount_cents, created_at)

wallets(user_id PK, balance_cents, updated_at)

wallet_transactions(id, user_id FK, txn_id, kind, amount_cents, method, status, reference, created_at, completed_at)
  -- kind: deposit | order_payment | refund; method: card | btc | eth | wallet
  -- status: pending | completed | failed; txn_id = unique 'WV-' + 12 uppercase hex chars (replay-safe idempotency)

payments(id, order_id, amount_cents, provider, provider_payment_id, provider_status, event_type, created_at)
  -- one row per (provider, payment); completed captures AND pending PayPal orders get a row (idempotency)
  -- crypto orders insert provider='crypto', status='pending', provider_order_id = order number

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

## Wallet & crypto rules

- Balance lives in the DB (`wallets.balance_cents`) and is only ever moved via atomic
  `BEGIN IMMEDIATE` transactions (`server/wallet.js`). No negative balances, no duplicate credits.
- A user's wallet is credited **only after** a payment is verified by the server:
  - **Card top-up** → funds credit on the Stripe `checkout.session.completed` webhook.
  - **BTC/ETH top-up** → deposit stays `pending`; an admin confirms it on-chain
    (`POST /api/admin/wallet/deposits/:txnId/confirm`) and only then is the balance credited.
    No customer-facing action credits crypto.
- Deposits are `$1.00`–`$50,000.00` (`MIN/MAX_DEPOSIT_CENTS`). Available deposit methods:
  `card`, `btc`, `eth`. USDT / Cash App / Money Order / Zelle → `409 METHOD_UNAVAILABLE`.
- Crypto **orders** are recorded `pending` with the on-chain address; they complete only via
  `POST /api/admin/orders/:orderNumber/crypto/complete` (never by a customer click).
- Chain addresses and QR images are provided by `wallet.cryptoInfo(config, m)` from
  `WALLET_ADDRESS_BTC` / `WALLET_ADDRESS_ETH` (assets: `assets/images/qr-btc.png` / `qr-eth.png`).
- Refunds of wallet-paid orders restore the wallet balance (`kind='refund'`, idempotent per reference).

## API surface

Wallet:

- `GET /api/wallet` — `{ wallet: { balanceCents, transactions[] } }` (last 100 txns).
- `POST /api/wallet/deposits` — `{ amountCents, method }`. Card → `{ checkoutUrl }` (Stripe session);
  BTC/ETH → `{ txnId, status: 'pending', payment: { network, address, qrImage }, requiresVerification }`.
- `POST /api/orders/wallet` — `{ eventId, items }` → instant debit; returns `{ order, idempotent }`
  with `order.status === 'paid'`. Errors: `INSUFFICIENT_WALLET_BALANCE`, `PAYMENT_ALREADY_STARTED`,
  `GIFT_CARD_COVERS_ORDER`.
- `POST /api/orders/crypto` — `{ eventId, items, method: 'btc'|'eth' }` → pending crypto payment
  (`provider='crypto'`, `provider_order_id` = order number). Returns the address to pay.

Webhooks (idempotent via `webhook_events`):

- `POST /webhook/stripe` — existing card checkout; wallet top-ups now settle on
  `checkout.session.completed` (credits the wallet) and fail on expired/payment-failed/canceled events.

Admin (wallet / crypto):

- `GET /api/admin/wallet/deposits` — pending deposits awaiting confirmation (with raw totals).
- `POST /api/admin/wallet/deposits/:txnId/confirm` — `{ outcome: 'completed' | 'failed' }` →
  credits/fails the deposit (idempotent; `TXN_ALREADY_USED` handling).
- `GET /api/admin/wallet/transactions`, `POST /api/admin/orders/:orderNumber/crypto/complete`.
- Order refunds: wallet-paid orders restore wallet balance; crypto orders → `409 CRYPTO_REFUND_MANUAL`
  (refund the chain payment manually, then void the order).

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

- `membership.html` — inline field validation, API error mapping (`EMAIL_TAKEN` → "already exists"),
  8+ char password + match + terms; success redirects to `account.html` (session cookie already set).
- `account.html` / `js/account.js` / `css/wallet.css` — customer dashboard: wallet balance,
  transaction history, order history, sign-out; mobile responsive.
- `add-money.html` / `js/add-money.js` — top-up flow: amount presets + custom, method radios
  (card / btc / eth; others disabled), card → Stripe redirect, BTC/ETH → PENDING panel
  (network, address, QR, copy button) explaining the credit comes only after confirmation.
- `checkout.html` / `js/checkout.js` — payment-method radios: Credit Card, Wallet Balance
  (shows balance + amount to pay, instant `POST /api/orders/wallet`), BTC, PayPal, Gift card,
  and USDT / Cash App / Money Order / Zelle shown as **Currently unavailable** (disabled).
  BTC/ETH selection shows the address/QR panel and records the payment as pending (no success redirect).
- `confirmation.js` — labels Wallet balance / BTC / ETH payments; crypto-pending orders show a note
  that completion follows on-chain confirmation.
- `admin.html` / `js/admin.js` / `css/admin.css` — Orders / Gift cards / Audit tabs, plus a new
  **Wallet & crypto** tab: pending deposits (Confirm received / Mark failed), pending crypto orders
  (Confirm on-chain & complete — the sole path that completes them), and the full wallet transaction
  feed across all users.
- Existing card/PayPal checkout UI and gift-card flows are unchanged.

## Environment variables

| Var | Purpose |
| --- | --- |
| `PAYMENT_SECRET_KEY` / `PAYMENT_WEBHOOK_SECRET` / `PAYMENT_PUBLISHABLE_KEY` | Stripe + webhook secret |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal OAuth credentials (shown as WARNING if unset) |
| `PAYPAL_MODE` | `sandbox` (default) or `live` |
| `PAYPAL_WEBHOOK_ID` | PayPal webhook ID, for signature verification |
| `PAYPAL_MERCHANT_EMAIL` | optional seller PayPal email → `purchase_units[].payee` |
| `GIFT_CARD_DEFAULT_LIFE_DAYS` | gift card validity, default 365 |
| `WALLET_ADDRESS_BTC` / `WALLET_ADDRESS_ETH` | wallet addresses shown on the payment-methods page, QR codes, and crypto orders |

## Run & deploy (read this)

Full functionality (signup, wallet, checkout, webhooks) requires the Node server —
**GitHub Pages alone cannot run any `/api/*` endpoint.**

1. `cd` into the project; `npm install`.
2. Copy `.env.example` → `.env` and set real values (Stripe, PayPal, wallet addresses).
3. `npm run db:reset` (fresh demo data, prints demo gift-card codes once) then `npm start` →
   serves the app on http://localhost:3000.
4. Point Stripe (and PayPal) webhooks at `https://<your-host>/webhook/stripe` and `/webhook/paypal`.
   For local testing, expose the port with a tunnel and put that URL in the dashboard.
5. Crypto flow needs a human step: confirm the on-chain deposit/order via the admin endpoints.
6. `npm test` runs the full suite (76 tests) in a throwaway in-memory DB.

For the hosted demo, replace real Stripe keys with placeholder values so the static site can't
move money, and always keep card numbers/CVVs out of the codebase.

## PayPal sandbox setup

1. Create a Sandbox REST App at developer.paypal.com → credentials for `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`.
2. Set `PAYPAL_WEBHOOK_ID` via *Webhooks events* in the app, or the API. Sandbox mode omits
   webhook signature verification when only the ID is missing (see `paypal.js`), making local testing easy.
3. Add a Webhook (`/v2/checkout/orders` capture + `/v2/payments/captures` refund events) pointing at
   `<BASE_URL>/webhook/paypal`.
4. Use the sandbox buyer account to approve orders; the app captures and settles automatically.

## Demo data

`npm run db:reset` / first boot seeds 3 × $500 gift cards; full codes print to the console once.
Re-seeding is idempotent (skips when cards already exist). Every boot also ensures the demo
admin/customer accounts exist via an idempotent user upsert, so an old DB still gets
`admin@ticketvault.test`. Default admin: `admin@ticketvault.test` / `adminpass123`,
customer: `customer@ticketvault.test` / `password123`. Wallets start at $0; top up via `/api/wallet/deposits`
(card → test-mode Stripe, or BTC/ETH → confirm via admin after "sending").

## Notes & security

- All monetary values are integer cents internally; fees fixed at `FEE_RATE` (0.10).
- Idempotency everywhere: payment row per provider, webhook dedupe, gift-card/complete idempotent returns,
  wallet txns keyed by unique `WV-` ids, crypto orders re-keyed by pending payment row.
- No secrets logged; rate limiters wrap auth, wallet deposits, order, and admin endpoints.
- Node quirk: this project's Node v24.21.0 build rejects `as` in destructuring — alias imports are
  done via an extra `require`, not `{ x as y }`.