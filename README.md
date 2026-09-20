# URBNMYTH Hub — Phase 0 + Phase 1

WhatsApp automation for Shopify orders: order confirmation with an "I Confirm" button,
an early-payment link that waives the ₹50 COD fee, and a dashboard over the whole pipeline.

## Run locally

```bash
npm install
cp .env.example .env      # fill it in
npm test                  # everything is faked; no network needed
npm run dev
```

First run against a real Google Sheet? Create its tabs first — every reader
addresses a hardcoded range and Sheets 400s on a tab that doesn't exist:

```bash
SHEET_ID=… npm run setup:sheets   # idempotent; existing tabs are left alone
```

Dashboard: `http://localhost:8080/dashboard?token=$DASHBOARD_TOKEN`

## Test without a real order

```bash
npm run send:hello -- 919876543210                       # Phase 0 exit test
npm run send:fake-order -- http://localhost:8080 919876543210
```

## Deploy

Go-live checklist, including every credential and the checks only a human can
make: [`LAUNCH.md`](LAUNCH.md).

```bash
PROJECT_ID=… SA_EMAIL=… SHOPIFY_STORE_DOMAIN=… SHOPIFY_LOCATION_ID=… \
  SHADOWFAX_BASE_URL=… SELLER_LEGAL_NAME=… SELLER_ADDRESS=… SELLER_GSTIN=… \
  DEFAULT_HSN=… JUDGEME_REVIEW_URL=… ./deploy.sh
```

The script prints the hub URL and the exact webhook paths to paste into Meta, Shopify,
Cashfree, and Shadowfax, then registers the Cloud Scheduler jobs `/internal/*` needs
(shipment sync every 4h, a daily rating sweep, and effect drain every 5 minutes).

Cloud Run is deployed with `--max-instances=1`. That isn't a cost knob — the gapless
invoice series and the in-process mutexes `CancellationService.approve`,
`ReportingService.generate` and `ShipmentSyncService.applyShipmentStatus` rely on exactly
one instance running at a time; a second instance would let two requests interleave past
those guards. The cap is enforced per *revision*, so a traffic migration can briefly run
two — deploy when the shop is quiet.

## Endpoints

| Path | Purpose |
|---|---|
| `GET /health` | liveness |
| `GET /webhook/meta` | Meta webhook verification |
| `POST /webhook/meta` | inbound messages, button taps, delivery statuses |
| `POST /webhook/shopify` | order creation, fulfillment intake |
| `POST /webhook/cashfree` | payment link events |
| `POST /webhook/shadowfax` | shipment status updates |
| `POST /internal/sync-shipments` | poll Shadowfax for open shipments (task token) |
| `POST /internal/rating-sweep` | send due rating requests (task token) |
| `POST /internal/drain-effects` | retry pending delivery/RTO effects (task token) |
| `GET /internal/b2cs?month=YYYY-MM` | GSTR-1 B2CS CSV for a month (task token) |
| `GET /api/orders` | JSON orders + metrics (dashboard token) |
| `GET /api/delivery` | shipped/OFD/delivered funnel + in-transit RTOs (dashboard token) |
| `GET /api/cancellations` | orders awaiting cancel review (dashboard token) |
| `POST /api/cancellations/:orderNo/approve` | approve a queued cancellation (dashboard token) |
| `GET /api/invoices` | invoice register + GST discrepancy flags (dashboard token) |
| `GET /api/health-flags` | failed effects + unmapped courier statuses (dashboard token) |
| `GET /api/b2cs?month=YYYY-MM` | same B2CS CSV as `/internal/b2cs`, behind the dashboard token instead — this is what the dashboard's GST section links to |
| `GET /dashboard` | the dashboard page |

## Architecture

```
routes/     HTTP edge: signature verification, parse, ack
   ↓
services/   flow orchestration
   ↓
core/       pure functions, zero I/O      adapters/   external systems
```

Dependencies point one way only. `core/` imports nothing from `adapters/`, `services/`,
or `routes/`. Services take every adapter through their constructor, so tests substitute
in-memory fakes and the suite never touches the network.

## The flows

**Shopify order created** → verify HMAC → dedupe on order id → normalize phone →
write `orders` row → COD gets `order_confirm_cod` (with buttons), prepaid gets
`order_confirm_prepaid` (no buttons).

**"I Confirm" tapped** → verify signature → dedupe on message id → match phone to the
latest PENDING order → status `CONFIRMED` → Cashfree link for `payable` (total − ₹50),
24h expiry → send `pay_early_link`.

**Cashfree payment succeeds** → verify signature → dedupe → status `PAID_EARLY` →
tag the Shopify order `paid-early`.

## Two decisions worth knowing

**Webhooks answer 500 on failure, not 200.** The sender retries, and the dedupe ledger
makes the retry safe. A 200 that hides an error loses orders silently.

**The payment amount is frozen at intake.** The customer was quoted a number in the
confirmation message; the link must match it even if `COD_FEE_INR` changes in between.

## Configuration

See `.env.example`. Every variable is validated by Zod at boot — a missing or malformed
one crashes the process with the variable named, rather than surfacing as a 500 later.

Google credentials come from Application Default Credentials (the Cloud Run service
account). There is no key file in this repo or in Secret Manager.

## Docs

- `docs/superpowers/specs/` — the design
- `docs/superpowers/plans/` — the implementation plan
- `docs/templates.md` — WhatsApp template copy to paste into WhatsApp Manager
