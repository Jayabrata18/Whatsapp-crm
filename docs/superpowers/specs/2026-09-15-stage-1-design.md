# URBNMYTH WhatsApp CRM — Stage 1 Design

**Date:** 2026-09-15
**Supersedes the roadmap in:** `urbnmyth-whatsapp-crm-build-plan.md` (rewritten alongside this spec)
**Builds on:** `docs/superpowers/specs/2026-08-16-whatsapp-crm-phase-0-1-design.md` (shipped)

**Scope:** the delivery spine (Shadowfax ingest, RTO handling, Shopify write-backs),
the Stage 1 WhatsApp message set, hub-generated GST invoices, the per-order finance
ledger, the monthly GSTR-1 B2CS report, and the marketing campaign system.

**Out of scope:** early COD payment (built, moved to Stage 2, disabled by flag),
abandoned-cart recovery, the Claude copywriter.

---

## 1. What changed from the original plan

The original seven-phase plan is replaced by a two-stage one. Stage 1 is everything
below. Stage 2 is early-COD-payment plus the deferred phases.

| Original | Now |
|---|---|
| Phase 1 pay-early link | **Stage 2.** Code stays, `PAY_EARLY_ENABLED=false` |
| Phase 2 invoice via Zoho Books | **Hub renders the PDF itself.** No Zoho dependency |
| Phase 3 out-for-delivery message | **Dropped.** Delivered-only |
| Phase 3 delivered + coupon | **Delivered + invoice.** No coupon |
| Phase 7 review request | **Stage 1**, with a Judge.me link |
| Phase 4 marketing | **Stage 1**, full campaign system |
| — | **New:** RTO detection → cancel + tag + restock |
| — | **New:** COD delivered → mark paid in Shopify |
| — | **New:** per-order finance ledger |
| — | **New:** GSTR-1 B2CS monthly report |

### Stage 1 message set

1. Order confirmation (shipped — unchanged)
2. Order delivered, with the GST invoice attached as a document
3. Order rating, with a Judge.me follow-up
4. Order cancelled — one template, reason as a variable
5. Marketing campaigns

---

## 2. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Data store | **Google Sheets, retained** | Volume doesn't justify a second store; the Apps Script BI dashboard reads it directly |
| Sheet writes | **Column-scoped only** | Whole-row writes would erase operator-filled ledger columns |
| Derived ledger columns | **Sheets formulas, not values** | Recompute themselves when operator columns are filled later; no stale window |
| Shadowfax ingest | **Webhook primary + 4h poller** | Both converge on one transition function |
| RTO handling | **Cancel + message on initiate, restock on return** | Customer hears promptly; inventory only moves when goods are physically back |
| Customer cancel button | **Flag for operator review, then cancel** | Guards against a mis-tap cancelling a live order |
| Invoice source | **Hub renders the PDF** | Removes a manual step per order; needs the GST engine anyway |
| PDF library | **`pdfkit`** | ~300MB and multi-second cold starts avoided vs headless Chrome |
| GST rate source | **Slab rule computed by the hub** | Operator's explicit choice; cross-checked against Shopify `tax_lines` |
| Slab threshold basis | **Inclusive per-piece price** | Deterministic; strict reading has an unsolvable dead zone (§5.1). **Needs CA sign-off** |
| HSN | **Single config default** | One heading covers the catalogue today |
| Invoice numbering | **In-process mutex, `--max-instances=1`** | The only place a race corrupts compliance data |
| Multi-effect flows | **Durable transition, then queued per-effect retry** | All-or-nothing retry would re-run succeeded effects |
| Marketing sender | **Chunked, driven by Cloud Scheduler** | `min-instances=0` kills post-response work; `max-instances=1` forbids long requests |
| Segments | **Fixed named predicates** | A query builder is a week of work for three queries |
| Implementation | **Two plans from one spec** | A campaign bug must not deploy alongside the order pipeline |

### Rejected

- **Firestore as source of truth, Sheets as mirror.** Real transactions and a real
  compare-and-set, ₹0 within free tier. Rejected as premature: two stores plus a sync
  is a worse class of bug than the millisecond race it fixes.
  **Upgrade trigger:** the message log shows a genuine double-send, *or* the ledger
  exceeds ~5,000 rows.
- **A lock row in Sheets.** A distributed lock over a store with no atomic primitive
  mostly works — the worst property a lock can have.
- **Shopify `tax_lines` as the rate source.** Would guarantee invoice/payment
  agreement. Operator chose the slab rule; retained as a cross-check (§5.4).
- **Click tracking in the hub.** Would require proxying links. UTM + Shopify
  analytics already gives the number.

---

## 3. Architecture

Layering is unchanged: `routes → services → core`, adapters injected at construction.

### New modules

```
core/
  gst.ts              slab rate, inclusive→taxable, shipping apportionment, reconciliation
  placeOfSupply.ts    province_code → 2-digit state code; intra vs inter-state
  shipmentState.ts    fulfillment state machine, guarded transitions
  ledgerRow.ts        order → ledger A–Q values + V–Y formula strings
  b2cs.ts             invoices → statewise rate-wise rollup; B2CL exclusion
  invoiceNumber.ts    FY-scoped series formatting
  segments.ts         named predicates over contacts
  optOut.ts           inbound text → is this a STOP?
adapters/
  shadowfax.ts        ShipmentTracker interface + ShadowfaxClient (poll)
  invoicePdf.ts       InvoiceRenderer interface + PdfKitRenderer
  (shopifyAdmin.ts)   extended: cancelOrder, markAsPaid, adjustInventory, addTag
  (whatsapp.ts)       extended: uploadMedia, sendDocument, sendImageTemplate, sendText
services/
  shipmentSync.ts     applyShipmentStatus() — the single convergence point
  delivery.ts         DELIVERED effects
  rto.ts              RTO_INITIATED and RTO_RETURNED effects
  cancellation.ts     review queue → cancel + restock + message
  invoicing.ts        allocate → render → upload → send → register
  rating.ts           sweep + reply handling
  reporting.ts        B2CS tab + CSV
  effects.ts          durable effect queue; drain with backoff
  contacts.ts         opt-in state
  campaigns.ts        create, tick, report
routes/
  shadowfax.ts        POST /webhook/shadowfax
  internal.ts         POST /internal/{sync-shipments,rating-sweep,campaign-tick,drain-effects}
```

### Deleted

`SheetStore.updateOrder()` — the whole-row read-modify-write. Deleted, not deprecated:
leaving it in the codebase leaves a loaded gun beside the operator's ledger columns.

---

## 4. Data model

All tabs live in the existing `URBNMYTH-CRM` spreadsheet.

### 4.1 Write discipline

`SheetStore` exposes `updateOrderFields(orderNo, patch)`, which resolves each patched
field to its own column letter and writes only those ranges. No API on the store can
address a range wider than the fields named in the patch.

The ledger's operator block is additionally protected by construction: the ledger
writer is a distinct method with a hardcoded column ceiling of `Q`.

### 4.2 `orders` (existing, extended A:M → A:T)

Existing A–M unchanged. New:

| Col | Field | Notes |
|---|---|---|
| N | `fulfillment_status` | see §4.7 |
| O | `awb` | latest AWB |
| P | `cancel_status` | `NONE \| REVIEW_PENDING \| CANCELLED` |
| Q | `cancel_reason` | `RTO \| CUSTOMER_REQUEST \| REFUSED_DELIVERY \| UNDELIVERABLE` |
| R | `invoice_no` | blank until delivered |
| S | `rating` | `1-2 \| 3 \| 4-5`, blank until answered |
| T | `gst_discrepancy` | computed-vs-Shopify tax gap, `0` when they agree — §5.4 |

### 4.3 `shipments`

`order_no · awb · courier · status · shipped_at · ofd_at · delivered_at ·
rto_initiated_at · rto_returned_at · last_synced_at · raw_status`

`raw_status` preserves Shadowfax's own string, so an unmapped status can be diagnosed
from the sheet without replaying webhooks.

### 4.4 `ledger` — three blocks

**A–Q, hub-owned.** Written in two passes.

*Order time (A–J):* `order_no · order_date · pincode · state · pos_code · skus ·
item_amount · shipping_charged · gross_amount · is_cod`

*Outcome time (K–Q):* `taxable_value · gst_rate · gst_on_goods · gst_on_shipping ·
outcome · collected_amount · platform_fee_5pct`

`skus` is a text summary, e.g. `TEE-BLK-L x2, CARGO-OLV-M x1`.
`item_amount` is the line-item subtotal; `gross_amount` is the order total the
customer was charged (items + shipping). Both are kept because the ledger needs to
show them separately.
`outcome` ∈ `DELIVERED | RTO | CANCELLED`.
`collected_amount` is the order total for a delivered prepaid order, the COD
remittance for a delivered COD order, and `0` for RTO or cancelled.
`platform_fee_5pct` = `PLATFORM_FEE_PCT` × `collected_amount` — a blended
Shopify + Flexypay + payment-gateway rate. **An RTO order carries no platform fee,
because no money moved through the gateway.**

**R–V, operator-owned.** `cod_charges · shipping_cost · cogs · rto_loss · notes`
The hub never writes these. Ever.

> `shipping_cost` — what you actually pay Shadowfax — was not in the original column
> list, but without it EBITDA is wrong: `shipping_charged` is what the *customer*
> paid, which is revenue, not cost. `rto_loss` only covers the return leg, so
> delivered orders would otherwise carry no freight cost at all.

**W–Y, formulas.** Written once at row creation with `valueInputOption: USER_ENTERED`:

```
net_revenue = collected_amount − gst_on_goods − gst_on_shipping − cod_charges − rto_loss
ebitda      = net_revenue − cogs − shipping_cost − platform_fee_5pct
pat         = ebitda × (1 − CORPORATE_TAX_PCT)
```

Because these are live formulas, filling `cogs` on day 3 updates `ebitda` and `pat`
immediately. The hub never recomputes them and there is no stale-value window.
Readers must request computed values (`valueRenderOption: UNFORMATTED_VALUE`).

Everything outside this block stays `RAW`.

### 4.5 `invoices`

`invoice_no · order_no · invoice_date · place_of_supply · hsn · gst_rate ·
taxable_value · cgst · sgst · igst · round_off · invoice_total · media_id · status`

**One row per (invoice, GST rate).** A mixed-rate order writes two rows sharing an
invoice number. A single `gst_rate` per invoice would roll the whole invoice up at one
rate in B2CS — which is exactly the figure the GST portal reconciles — so the register
is rate-wise at source. Shipping tax folds into the row for the rate it was
apportioned to. `round_off` and `invoice_total` are invoice-level and repeat across
rows sharing a number.

`status` ∈ `ISSUED | VOID`. A `VOID` row exists only where the process died between
number allocation and a successful render — see §5.6. Voiding marks every row of that
number.

### 4.6 `contacts`, `campaigns`, `campaign_sends`, `b2cs`

`contacts`: `phone · name · opt_in_state · source · opted_in_at · last_order_at ·
order_count · total_spent`
`opt_in_state` ∈ `OPTED_IN | OPTED_OUT | UNKNOWN`; `source` ∈ `CHECKOUT | INBOUND | CTWA`.

`campaigns`: `campaign_id · template · media_id · body_params · segment ·
recipient_count · est_cost · state · created_at`
`state` ∈ `DRAFT | RUNNING | PAUSED | DONE`.

`campaign_sends`: `campaign_id · phone · wamid · status · error · queued_at · sent_at`
`status` ∈ `QUEUED | SENT | DELIVERED | READ | FAILED`.

`b2cs`: `month · place_of_supply · rate · taxable_value · igst · cgst · sgst ·
invoice_count · generated_at`

### 4.7 State machines

Two columns, deliberately separate — a COD order can be `CONFIRMED` and
`RTO_INITIATED` at the same time, and collapsing them forces a choice about which
truth to lose.

```
confirm_status (existing)
  PENDING ──confirm──→ CONFIRMED ──payment──→ PAID_EARLY   [Stage 2, flag off]
     ├──cancel button──→ CANCELLED
     └──(no phone)─────→ NO_RESPONSE

fulfillment_status (new)
  NEW ──fulfillment created──→ SHIPPED ──→ OFD ──→ DELIVERED
                                  │         │
                                  └─────────┴──→ RTO_INITIATED ──→ RTO_RETURNED
```

Every transition is guarded by its expected predecessor set. A transition from an
unexpected state is a logged no-op returning 200 — that is idempotency working, not
an error.

---

## 5. The GST engine

`core/gst.ts` is pure: no I/O, no clock, no config reads. Rates and thresholds are
passed in.

### 5.1 Slab rate, and the assumption that needs CA sign-off

Prices are GST-inclusive. The slab is "≤ ₹2,500 → 5%, above → 18%" per piece.

Applied strictly, the threshold is measured on the *taxable* value, which the rate
determines — a circularity. Solving it produces a dead zone: for an inclusive
per-piece price of ₹2,700, assuming 5% gives a taxable value of ₹2,571 (> 2,500, so
the rate should have been 18% — contradiction), while assuming 18% gives ₹2,288
(≤ 2,500, so it should have been 5% — also a contradiction). No rate is
self-consistent between roughly ₹2,625 and ₹2,950 inclusive.

**Decision: the threshold is applied to the inclusive per-piece price the customer
paid.** Deterministic, no dead zone, and it matches how Shopify tax rules are
normally configured.

> **This is the single assumption in this design most in need of a CA's review.**
> It is isolated in one function so changing it is a one-line change plus tests.

### 5.2 Computation

```
per line item:
  rate    = incl_unit_price <= GST_SLAB_THRESHOLD_INR ? GST_RATE_LOW : GST_RATE_HIGH
  taxable = round2(incl_line_total / (1 + rate))
  gst     = incl_line_total − taxable
```

**Shipping is a composite supply** and takes the principal supply's rate. A
mixed-rate order apportions the shipping charge across rates pro-rata by taxable
value, so a ₹99 shipping charge on an order that is 70% 5%-goods and 30%
18%-goods is split ₹69.30 / ₹29.70 before tax is backed out of each part.

### 5.3 Place of supply

`shipping_address.province_code` (ISO, e.g. `WB`) → 2-digit state code, via a
36-entry table. Shopify's free-text `province` is a fallback only; a missing or
unrecognised code flags the order on the dashboard rather than guessing.

- `pos_code == SELLER_STATE_CODE` (19, West Bengal) → **CGST + SGST**, half the rate each
- otherwise → **IGST** at the full rate

### 5.4 Reconciliation, and the Shopify cross-check

Per-line rounding guarantees drift. **A round-off line forces the invoice total to
equal the amount charged, exactly.** An invoice that differs from the payment by ₹0.01
is a real reconciliation problem, not a cosmetic one.

Separately, the hub compares its computed GST total against the order's `tax_lines`
**at intake**, not at invoicing — a wrong tax setting is worth knowing about the day
it starts, not weeks later when the parcel lands. Beyond a ±₹1 tolerance the gap is
written to `orders.gst_discrepancy` and surfaced on the dashboard. **The invoice still
issues on the hub's rule** — the check exists so a misconfigured Shopify tax setting
becomes visible instead of producing an invoice that silently disagrees with what was
charged.

An order carrying no `tax_lines` at all records no discrepancy. A store with tax
collection switched off would otherwise flag every single order, which makes the
signal useless rather than informative.

### 5.5 Invoice document

`pdfkit`, drawing directly — testable by asserting on draw calls, with no browser
dependency. One page, carrying every field a GST tax invoice requires:

supplier legal name, address, GSTIN · invoice number and date · buyer name and
shipping address · place of supply · HSN · description, quantity, taxable value ·
rate · CGST+SGST **or** IGST split · round-off · total in figures **and words** ·
"Computer generated invoice, no signature required".

### 5.6 Invoice numbering

Format `UM/26-27/0001`, scoped to the Indian financial year (Apr–Mar), sequential
and gapless.

Sheets has no atomic increment, and this is the one place a race corrupts data that
must be defended to an assessing officer. The hub deploys with `--max-instances=1`
(one instance serves 80 concurrent requests by default — far beyond this volume) and
guards allocation with an in-process async mutex.

Allocation, render, and rollback all happen **inside** the mutex, so a failed render
returns the number to the pool and the series stays gapless. Only a process death
mid-render leaves a gap, recorded as a `VOID` row in the register.

---

## 6. Flows

### 6.1 Shipment status ingestion

```
POST /webhook/shadowfax ─┐
                         ├─→ applyShipmentStatus(orderNo, status, at)
Cloud Scheduler, 4h ─────┘        ↓
  POST /internal/sync-shipments   guarded transition
  (non-terminal AWBs only)        ↓
                                  enqueue effects
```

**One convergence point** is the load-bearing decision here. Neither entry point
knows what effects fire; the state machine decides. A status arriving twice — once
pushed, once polled — therefore cannot double-send.

Effects are recorded in `events` keyed `orderNo:transition`.

**AWB → order mapping** comes from new Shopify webhook subscriptions,
`fulfillments/create` and `fulfillments/update`, which carry `tracking_number`
alongside the order. These create the `shipments` rows.

**Unknown Shadowfax status strings** return 200, log at warn, write `raw_status`, and
flag on the dashboard. Never a silent no-op — a silently-ignored status is an order
that stops moving with no signal.

### 6.2 DELIVERED

1. `fulfillment_status = DELIVERED`, `delivered_at`
2. COD only: Shopify `orderMarkAsPaid`
3. Invoice: allocate → compute → render → upload to Meta → send
   `order_delivered_invoice` as a document message → write the register
4. Ledger outcome pass: `DELIVERED`, `collected_amount`, `platform_fee_5pct`,
   taxable value, GST split
5. Queue the rating request for `RATING_DELAY_DAYS` later

### 6.3 RTO

**On `RTO_INITIATED`:**
1. Shopify `orderCancel`, reason `OTHER`, **`restock: false`**, note:
   *"user cancel, user did not take delivery or cancel the delivery"*
2. Add tag `rto`
3. Send `order_cancelled` with reason `RTO`
4. Ledger outcome `RTO`, `collected_amount = 0`, `platform_fee_5pct = 0`

**On `RTO_RETURNED`:** restock.

`orderCancel` only restocks *at cancel time*, so splitting cancel-now from
restock-later means the restock is a separate `inventoryAdjustQuantities` call
(+qty per variant, at the fulfillment location). Different API, different failure
modes, and it can **partially succeed across variants** — so it is its own queued
effect with its own retry and its own dashboard row on exhaustion.

### 6.4 Customer-initiated cancellation

Button tap → `confirm_status = CANCELLED`, `cancel_status = REVIEW_PENDING`.
The dashboard shows a review queue with a "Cancel in Shopify" action.

On the operator's click: `orderCancel` with reason `CUSTOMER_REQUEST` and
`restock: true` (nothing shipped, so cancel-time restock is correct), then send
`order_cancelled` with reason `CUSTOMER_REQUEST`.

**The message waits for approval.** Telling a customer they are cancelled and then
un-cancelling is worse than a few hours of delay.

### 6.5 Rating

Cron sweep (`POST /internal/rating-sweep`): orders `DELIVERED` for at least
`RATING_DELAY_DAYS` with no request sent → `order_rating`, three quick replies
(`⭐ 1–2`, `⭐ 3`, `⭐ 4–5`). WhatsApp allows a maximum of three.

On reply, store the rating, then:
- **4–5** → free-form follow-up inside the open 24h service window (₹0) with the
  Judge.me review link
- **1–2** → apology, and a service ticket on the dashboard

### 6.6 Marketing campaigns

**Opt-in**, three write paths into `contacts`:
- Checkout cart attribute `whatsapp_optin` → order `note_attributes` → read at intake.
  Shopify's native consent fields cover email and SMS, not WhatsApp, so this needs a
  checkout customisation.
- Any inbound WhatsApp message → implicit opt-in, source `INBOUND`
- CTWA ad clicks, later

**`STOP` handling is mandatory.** Inbound text matching stop/unsubscribe wording
flips the contact to `OPTED_OUT` immediately and permanently. This is not a courtesy:
ignoring it kills the number's quality rating, and a throttled number throttles
**order confirmations too**. The marketing system can take down the order pipeline
through Meta despite sharing no code with it.

**Segments** are fixed named predicates over `contacts`: `all-opted-in`,
`past-buyers`, `repeat-buyers`, `lapsed-90d`, `bought-product-type-X`.

**The sender must be chunked.** `min-instances=0` kills post-response work and
`max-instances=1` forbids long requests, so a 500-recipient send cannot live inside
one HTTP request.

```
dashboard Send → write campaign + N QUEUED rows → return immediately
Cloud Scheduler, 1 min → POST /internal/campaign-tick
    → claim next batch of QUEUED → send at ~1/sec → mark SENT/FAILED → return
```

Resumable, survives instance restarts, progress visible live, and it reuses the same
Cloud Scheduler already needed for shipment polling, the rating sweep, and effect
draining — one scheduler, four authed internal endpoints.

**Four guardrails**, each of which exists because violating it costs the number:
1. Non-`OPTED_IN` contacts are skipped, silently and always
2. Meta's daily messaging tier cap is config'd; the sender counts the last 24h from
   `campaign_sends` and **stops** at the cap rather than blasting into a block
3. At most one marketing message per contact per `MARKETING_MIN_DAYS_BETWEEN` days
4. A dashboard kill switch that pauses every running campaign

**Composer:** approved Marketing template → upload header image (→ Meta media id,
reused for the whole campaign) → body variables → segment → preview against a real
contact → **confirmation step showing recipient count and estimated cost**
(count × `MARKETING_RATE_INR`) → send.

**Reporting** reuses the existing Meta status webhook; `campaign_sends` rows move
`QUEUED → SENT → DELIVERED → READ` or `FAILED` with the error captured.
Click-through stays in Shopify analytics via UTM on the button URL.

### 6.7 B2CS

`POST /internal/b2cs?month=YYYY-MM`, and a dashboard button.

Group `invoices` for the month by `(place_of_supply, rate)`, summing taxable value
and tax. Written to the `b2cs` tab **and** offered as a CSV in the GST Returns Offline
Tool's exact column order:

`Type, Place Of Supply, Applicable % of Tax Rate, Rate, Taxable Value, Cess Amount, E-Commerce GSTIN`

Two correctness guards:
- **B2CL exclusion.** An inter-state invoice above ₹2.5L is B2CL, not B2CS. It must be
  excluded **and flagged** — never quietly folded in.
- **Invoices fire at DELIVERED**, which yields a clean property for free: RTO and
  cancelled orders never generate an invoice, so they never enter B2CS and no GST is
  filed on revenue that was never kept.

---

## 7. Failure handling

### 7.1 Ingestion is separated from effects

Phase 1's flows return 500 and let the sender retry, which works because each has
exactly one effect. RTO has four (cancel, tag, message, ledger); all-or-nothing retry
would re-run whatever already succeeded.

```
webhook → record the transition durably → 200 immediately
            └→ enqueue effects → /internal/drain-effects → per-effect retry + backoff
                                   → exhausted retries surface on the dashboard
```

Phase 1's single-effect flows keep their current simpler behaviour. Only multi-effect
flows go through the queue.

### 7.2 Table

| Condition | Response |
|---|---|
| Bad/missing Shadowfax auth | 401 |
| Unknown Shadowfax status string | 200 + warn + `raw_status` + dashboard flag |
| Illegal state transition | 200, logged no-op |
| Shopify cancel / restock / mark-paid fails | 200 to sender; effect retried independently; dashboard row after exhaustion |
| Invoice render fails | number rolled back inside the mutex; effect retried |
| Process dies mid-render | `VOID` row in the register; gap explained |
| Computed GST ≠ Shopify `tax_lines` (> ±₹1) | invoice still issues; discrepancy flagged |
| Meta media upload fails | effect retried; delivered message held, not dropped |
| Marketing send fails for one recipient | that row `FAILED` with the error; campaign continues |
| Sheets or Graph API failure in Phase 1 flows | 500, sender retries (unchanged) |

Logs remain single-line JSON with `order_no` where known. Tokens, signatures, and
full webhook bodies are never logged.

---

## 8. Configuration

Added to the existing set, all Zod-validated at boot:

| Variable | Purpose |
|---|---|
| `SHADOWFAX_BASE_URL` / `SHADOWFAX_API_KEY` | polling |
| `SHADOWFAX_WEBHOOK_SECRET` | webhook auth (mechanism TBC — §10) |
| `SELLER_LEGAL_NAME` / `SELLER_ADDRESS` / `SELLER_GSTIN` | invoice header |
| `SELLER_STATE_CODE` | `19` (West Bengal) |
| `DEFAULT_HSN` | catalogue-wide HSN |
| `GST_SLAB_THRESHOLD_INR` | `2500` |
| `GST_RATE_LOW` / `GST_RATE_HIGH` | `5` / `18` |
| `INVOICE_SERIES_PREFIX` | `UM` |
| `PLATFORM_FEE_PCT` | `5` — Shopify + Flexypay + gateway, blended |
| `CORPORATE_TAX_PCT` | for the PAT formula |
| `PAY_EARLY_ENABLED` | `false` — Stage 2 switch |
| `RATING_DELAY_DAYS` | `3` |
| `JUDGEME_REVIEW_URL` | link template |
| `MARKETING_DAILY_CAP` | Meta messaging tier |
| `MARKETING_RATE_INR` | cost estimate |
| `MARKETING_MIN_DAYS_BETWEEN` | `7` |
| `INTERNAL_TASK_TOKEN` | `/internal/*` auth |

---

## 9. Testing

Vitest, TDD on `core/` and `services/`, fakes at every adapter boundary, **no network
anywhere in the suite**.

**`core/` — pure, exhaustive:**
- `gst.ts`: slab boundaries at ₹2,499 / ₹2,500 / ₹2,501 inclusive; mixed-rate shipping
  apportionment; intra vs inter-state split; the round-off line forcing
  total == charged; zero shipping; single item; a ₹0 order
- `placeOfSupply.ts`: all 36 codes; missing `province_code`; unrecognised code
- `shipmentState.ts`: every legal transition advances; **every illegal one is a no-op**
- `b2cs.ts`: grouping; B2CL exclusion; an empty month
- `invoiceNumber.ts`: FY rollover at 1 April; zero-padding; series continuity
- `optOut.ts`: stop wording variants, and text that merely contains "stop"

**`services/` — against in-memory fakes:**
- **RTO arriving by webhook and by poll fires the Shopify cancel exactly once**
- restock retries independently of a succeeded cancel
- restock partially succeeding across variants retries only the failures
- delivered COD marks paid; delivered prepaid does not
- invoice render failure rolls the counter back and the next allocation reuses it
- rating sweep respects the delay and never re-sends
- opted-out contacts are skipped; the daily cap halts a campaign mid-run
- a campaign tick resumes correctly after an interrupted previous tick
- the ledger writer cannot address a column beyond `Q`

---

## 10. Open items

1. **Shadowfax webhook auth mechanism and status vocabulary.** The adapter is
   designed against a canonical internal status enum with a mapping table to be filled
   from Shadowfax's docs. Unknown strings log loudly rather than failing silently.
2. **Judge.me review-link shape** — per-product vs store-level. Config'd URL template
   either way.
3. **The GST-inclusive slab-threshold assumption (§5.1)** — needs CA sign-off.

---

## 11. Implementation plans

Two plans from this one spec, so a campaign bug cannot deploy alongside the order
pipeline.

**Plan 1 — the spine**, in dependency order:
1. Column-scoped `SheetStore`; delete whole-row `updateOrder` *(touches existing code)*
2. New tabs; ledger row at order time, with formulas
3. Shipment ingest: `fulfillments/*` webhook, Shadowfax webhook, poller
4. GST engine, invoice PDF, register
5. DELIVERED: mark-paid + invoice message
6. RTO: cancel/tag/message, then restock
7. Cancel review flow
8. Rating sweep + reply handling
9. B2CS tab + CSV
10. Dashboard additions

**Plan 2 — marketing:** opt-in capture → contacts → segments → composer → chunked
sender → reporting.

---

## 12. Operator checklist

- [ ] Ask Shadowfax to enable status webhooks; get their status vocabulary and auth mechanism
- [ ] Add Shopify webhooks `fulfillments/create` and `fulfillments/update`
- [ ] Add the `whatsapp_optin` checkout field
- [ ] Get 4 templates approved: `order_delivered_invoice` (document header),
      `order_cancelled` (reason variable), `order_rating` (3 quick replies),
      and 2–3 marketing variants (image header)
- [ ] Set `--max-instances=1` on the Cloud Run service
- [ ] Create the Cloud Scheduler jobs for the four `/internal/*` endpoints
- [ ] Fill `SELLER_GSTIN`, legal name, address, `DEFAULT_HSN`
- [ ] **Put the §5.1 slab-threshold assumption in front of your CA**
- [ ] Confirm the `PLATFORM_FEE_PCT` basis is collected amount, not gross order value

---

## 13. Exit criteria

**Plan 1**
- [ ] `npm test` passes
- [ ] A real delivered COD order: marks paid in Shopify, invoice PDF arrives on
      WhatsApp, GST split correct for both an intra-state and an inter-state buyer
- [ ] Invoice total matches the amount charged to the paisa
- [ ] A real RTO: order cancels with the note and `rto` tag, customer gets the
      cancellation message, stock returns only once the parcel is back
- [ ] The same RTO status delivered twice (webhook + poll) cancels exactly once
- [ ] Ledger row completes on delivery; filling `cogs` by hand updates EBITDA and PAT
      without the hub touching the row
- [ ] B2CS CSV for a month uploads to the GST portal without a format error
- [ ] Rating request arrives on day 3; each of the three buttons routes correctly

**Plan 2**
- [ ] Campaign to a 5-person test list: image renders, UTM present, report fills in
- [ ] A non-opted-in number is skipped
- [ ] Replying `STOP` flips the contact and excludes them from the next campaign
- [ ] A campaign paused mid-run resumes from where it stopped
