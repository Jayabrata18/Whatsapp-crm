# URBNMYTH WhatsApp CRM — Phase 0 + Phase 1 Design

**Date:** 2026-08-16
**Scope:** Phase 0 (hub foundation) and Phase 1 (COD order confirmation + early-payment link) from `urbnmyth-whatsapp-crm-build-plan.md`.
**Out of scope:** Phases 2–7. The design leaves seams for them but implements none of them.

---

## 1. Goal

A single TypeScript Node service ("the hub") that:

1. Receives Shopify `order/create` webhooks, writes the order to a Google Sheet, and sends a WhatsApp template.
2. Receives the customer's "I Confirm" button reply, flips order status, creates a Cashfree payment link for the order total minus a fixed ₹50 COD fee, and sends that link.
3. Receives Cashfree payment success, marks the order `PAID_EARLY`, and tags the Shopify order.
4. Serves a dashboard showing the confirmation pipeline.

Fixed cost target: ₹0/month plus Meta's per-message fees.

---

## 2. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Language | TypeScript, strict mode, ESM | Stated requirement in the build plan |
| Runtime | Node 24, Express 5 | Cloud Run source deploy needs no Dockerfile |
| Data store | Google Sheets (`URBNMYTH-CRM`) via ADC | Build plan decision; feeds the existing Apps Script BI dashboard |
| Dashboard | Server-rendered page on the hub | Self-contained, versioned in this repo, testable |
| Incentive rule | Waive COD fee, `COD_FEE_INR=50` flat | One rule, config-driven, no redeploy to change |
| Prepaid orders | Messaged with a separate no-button template | Better CX; costs one extra utility message per prepaid order |
| Processing model | Synchronous, no queue | ~1–2s path fits Shopify's 5s budget; Cloud Run `min-instances=0` kills post-response work |
| Webhook failure | HTTP 500, let the sender retry | Idempotency makes retries safe; a 200 on failure loses orders silently |
| Testing | Vitest, TDD on core logic, fakes at every adapter boundary | No network in the test suite |

---

## 3. Architecture

Four layers, dependencies point one way only:

```
routes/     HTTP edge: signature verification, parse, ack
   ↓
services/   flow orchestration
   ↓
core/       pure functions, zero I/O
adapters/   external systems (injected into services)
```

`core/` imports nothing from `adapters/` or `services/`. Services receive adapters as constructor arguments, so tests substitute in-memory fakes.

### File layout

```
src/
  config.ts                 Zod-validated env, fails fast at boot
  server.ts                 Express app assembly
  index.ts                  entrypoint, listens on $PORT
  core/
    phone.ts                normalizeIndianPhone()
    signatures.ts           verifyShopifyHmac / verifyMetaSignature / verifyCashfreeSignature
    shopifyOrder.ts         parseShopifyOrder(), isCodOrder()
    incentive.ts            payableAmount()
    metaWebhook.ts          parseMetaWebhook() → button replies + delivery statuses
  adapters/
    sheets.ts               SheetStore interface + GoogleSheetStore
    whatsapp.ts             WhatsAppClient interface + GraphWhatsAppClient
    cashfree.ts             PaymentLinkClient interface + CashfreeClient
    shopifyAdmin.ts         OrderTagger interface + ShopifyAdminClient
  services/
    orderIntake.ts          Shopify order → sheet row → template
    confirmation.ts         button reply → CONFIRMED → payment link
    payment.ts              Cashfree success → PAID_EARLY → Shopify tag
    messageLog.ts           append + status updates on the messages tab
  routes/
    shopify.ts  meta.ts  cashfree.ts  dashboard.ts  api.ts
  views/
    dashboard.ts            HTML template literal, no build step
test/
  <mirrors src/, plus fakes/>
scripts/
  send-hello.ts             Phase 0 exit test
  fake-order.ts             signed fake Shopify payload → running hub
deploy.sh
.env.example
```

---

## 4. Data model — Google Sheet `URBNMYTH-CRM`

### Tab `orders`

| Column | Notes |
|---|---|
| `order_no` | Shopify `name`, e.g. `#1042` — the human key |
| `order_id` | Shopify numeric id — the dedupe key |
| `customer_name` | first name, used in templates |
| `phone` | normalized `91XXXXXXXXXX` |
| `amount` | order total, INR |
| `cod_fee` | ₹50 for COD orders, 0 for prepaid |
| `payable` | `amount − cod_fee` for COD, `amount` for prepaid |
| `is_cod` | TRUE/FALSE |
| `confirm_status` | see state machine below |
| `payment_link` | Cashfree short URL, blank until created |
| `created_at` `confirmed_at` `paid_at` | ISO 8601 |

### Tab `messages`

`order_no · template · wamid · direction · status · timestamp`

Every outbound send is appended on dispatch. Meta delivery-status webhooks update `status` in place (`sent → delivered → read`, or `failed`). Inbound button replies are logged with `direction=in`.

### Tab `events`

`source · external_id · received_at`

The idempotency ledger. `source` ∈ `shopify | meta | cashfree`. `external_id` is the Shopify order id, Meta message id, or Cashfree order id.

**Known limitation:** Sheets offers no atomic compare-and-set, so two concurrent deliveries of the same event could both pass the check-before-write. The window is milliseconds; sender retry gaps are seconds. Accepted for now, documented in `services/` where the check happens. Revisit if the message log ever shows a genuine double-send.

### Status state machine

```
PENDING ──"I Confirm"──→ CONFIRMED ──payment success──→ PAID_EARLY
   │                          │
   │                          └──(link expires, no pay)──→ CONFIRMED (terminal)
   ├──"Cancel Order"──→ CANCELLED
   └──(no reply, swept later)──→ NO_RESPONSE
```

Transitions are guarded: a service only advances a status from its expected predecessor. A late duplicate "I Confirm" on an already-`PAID_EARLY` order is a no-op, not a downgrade.

`NO_RESPONSE` has exactly one writer in Phase 1: an order that arrives with no usable phone number, which can never receive a message and so starts terminal. The *sweep* that ages out stale `PENDING` orders is **not** implemented here — it belongs with Phase 3's cron, and the status already exists so adding it later needs no schema change.

---

## 5. Flows

### 5.1 Shopify order created

```
POST /webhook/shopify
  verify X-Shopify-Hmac-Sha256 over the raw body   → 401 on mismatch
  dedupe on order id                                → 200 no-op if seen
  parse payload → domain Order
  normalize phone                                   → log + 200 skip if unusable
  append orders row (PENDING)
  is_cod ? send order_confirm_cod : send order_confirm_prepaid
  append messages row
  200
```

Raw body must be preserved for HMAC — the Express JSON parser is configured with a `verify` hook that stashes the raw buffer, since re-serializing the parsed object breaks the signature.

**COD detection:** `payment_gateway_names` contains a gateway matching `COD_GATEWAY_NAMES` (config, comma-separated, case-insensitive, defaults to `cash on delivery,cod`). Falls back to `financial_status === 'pending'` only if the gateway list is empty.

**Phone source:** `shipping_address.phone` → `customer.phone` → `billing_address.phone`, first usable wins.

### 5.2 "I Confirm" button reply

```
POST /webhook/meta
  verify X-Hub-Signature-256                        → 401 on mismatch
  dedupe on message id                              → 200 no-op if seen
  parse: button replies and delivery statuses
  delivery status → update messages row, 200

  button reply "I Confirm":
    match phone → most recent order with status PENDING
    no match     → log, 200 (customer messaging out of band is not an error)
    status CONFIRMED, confirmed_at now
    Cashfree link: amount = payable, purpose = order_no, expiry 24h
    write payment_link to orders row
    send pay_early_link with the URL button suffix
    200

  button reply "Cancel Order":
    status CANCELLED, 200
```

The payment amount comes from the `payable` column written at intake, not recomputed at click time. The customer was quoted a number in the confirmation message; the link must match it even if config changes in between.

### 5.3 Cashfree payment success

```
POST /webhook/cashfree
  verify signature → 401
  dedupe on cashfree order id → 200
  event PAYMENT_SUCCESS only, others logged and ignored
  match order by purpose/order_no
  status PAID_EARLY, paid_at now
  Shopify Admin API: add tag `paid-early`   (failure logged, does not fail the webhook)
  200
```

The Shopify tag is a convenience, not a source of truth, so a tagging failure must not trigger a retry storm on a payment that already succeeded.

---

## 6. Error handling

| Condition | Response | Reasoning |
|---|---|---|
| Bad/missing signature | 401, no body read further | Never retry a forgery |
| Already-processed event | 200 | Retry is the sender doing its job |
| Unusable/absent phone | 200 + warn log | Retrying will not conjure a phone number |
| Sheets or Graph API failure | 500 | Sender retries; idempotency makes that safe |
| Shopify tagging failure (5.3) | 200 + error log | Payment already succeeded downstream |
| Unhandled exception | 500 + structured error log | Same as above |

Logs are single-line JSON to stdout so Cloud Logging parses them into fields. Every log line carries `order_no` where one is known. Tokens, signatures, and full webhook bodies are never logged.

---

## 7. Dashboard

`GET /dashboard` — server-rendered HTML, no client build step, no npm UI dependencies.

- Summary tiles: orders today, confirm rate %, early-pay conversion %, revenue collected early
- Orders table: order no, customer, amount, payable, status chip, timestamps
- Filter by status, 60s auto-refresh
- `GET /api/orders` returns JSON, requires `Authorization: Bearer $DASHBOARD_TOKEN`

The dashboard page itself requires the same token, supplied as a `?token=` query param that it stores in `sessionStorage` for subsequent API calls. The Cloud Run service must be `--allow-unauthenticated` for Meta and Shopify to reach it, so authentication has to live in the application.

---

## 8. Configuration

`.env` locally, Cloud Run env vars / Secret Manager in production. Validated by Zod at boot; a missing or malformed variable crashes the process with the variable named.

| Variable | Purpose |
|---|---|
| `PORT` | Cloud Run supplies this |
| `META_ACCESS_TOKEN` | permanent system-user token |
| `META_PHONE_NUMBER_ID` | sender number id |
| `META_WABA_ID` | business account id |
| `META_VERIFY_TOKEN` | echoed during `GET /webhook/meta` |
| `META_APP_SECRET` | verifies `X-Hub-Signature-256` |
| `SHOPIFY_WEBHOOK_SECRET` | verifies order webhooks |
| `SHOPIFY_STORE_DOMAIN` | Admin API host |
| `SHOPIFY_ADMIN_TOKEN` | Admin API token, for order tagging |
| `COD_GATEWAY_NAMES` | comma-separated COD gateway matchers |
| `CASHFREE_APP_ID` / `CASHFREE_SECRET_KEY` / `CASHFREE_ENV` | payment links; env is `TEST` or `PROD` |
| `SHEET_ID` | the `URBNMYTH-CRM` spreadsheet id |
| `COD_FEE_INR` | `50` |
| `DASHBOARD_TOKEN` | dashboard + API auth |

Google credentials come from Application Default Credentials — the Cloud Run service account. No key file exists anywhere in the repo or in Secret Manager.

---

## 9. WhatsApp templates

All three are **Utility** category. Copy is written to read naturally; no ALL CAPS, no urgency spam, both of which draw rejections.

**`order_confirm_cod`** — body variables: `{{1}}` name, `{{2}}` order no, `{{3}}` items summary, `{{4}}` amount.
Buttons: Quick Reply `I Confirm`, Quick Reply `Cancel Order`.

**`order_confirm_prepaid`** — body variables: `{{1}}` name, `{{2}}` order no, `{{3}}` items summary, `{{4}}` amount. No buttons.

**`pay_early_link`** — body variables: `{{1}}` name, `{{2}}` payable amount, `{{3}}` COD fee saved. URL button with dynamic suffix carrying the Cashfree link id.

Exact submission-ready copy ships as `docs/templates.md`.

---

## 10. Testing

Vitest. Tests are written before the implementation for everything in `core/` and `services/`.

**`core/` — pure, exhaustive:**
- `phone.ts`: `+91 98765 43210`, `09876543210`, `9876543210`, `919876543210`, landlines, too-short, empty, non-numeric
- `signatures.ts`: valid, tampered body, wrong secret, missing header, and a timing-safe comparison check for all three verifiers
- `shopifyOrder.ts`: COD and prepaid gateway lists, missing phone, phone fallback order, missing customer name
- `incentive.ts`: COD subtracts ₹50; prepaid subtracts nothing; order total below the fee never produces a negative or zero payable
- `metaWebhook.ts`: button reply, delivery status, unknown event shape, malformed payload

**`services/` — against in-memory fakes:**
- duplicate Shopify webhook sends exactly one message
- COD order gets `order_confirm_cod`; prepaid gets `order_confirm_prepaid`
- confirm reply on a `PENDING` order creates a link and sends it
- confirm reply on an already-`PAID_EARLY` order is a no-op
- confirm reply from an unknown phone does not throw
- payment success flips status even when Shopify tagging throws

**Manual scripts, run once by the operator:**
- `npm run send:hello` — Phase 0 exit test, real `hello_world` template to a given number
- `npm run send:fake-order` — posts a correctly signed fake Shopify payload at a running hub

---

## 11. Deployment

`deploy.sh` wraps:

```
gcloud run deploy urbnmyth-hub \
  --source . --region asia-south1 --allow-unauthenticated \
  --service-account $SA_EMAIL \
  --set-secrets ...
```

The operator runs it — it creates real billable resources under their billing account. The script prints the resulting URL and the exact webhook paths to paste into Meta, Shopify, and Cashfree.

---

## 12. Exit criteria

**Phase 0**
- [ ] `npm test` passes
- [ ] Hub boots locally and `GET /health` returns ok
- [ ] `npm run send:hello` delivers a template to a real phone
- [ ] Deployed to Cloud Run; `GET /webhook/meta` verification succeeds in Meta's console
- [ ] Inbound WhatsApp messages appear in Cloud Logging

**Phase 1**
- [ ] Real COD test order → message arrives in under a minute
- [ ] "I Confirm" → dashboard shows CONFIRMED
- [ ] Payment link arrives for `total − ₹50`; test-paying flips status to PAID_EARLY
- [ ] Replaying the same Shopify webhook sends no second message
- [ ] Prepaid test order receives `order_confirm_prepaid` and no payment link
