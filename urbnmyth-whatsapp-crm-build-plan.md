# URBNMYTH — WhatsApp Automation + CRM Build Plan

**Goal:** One low-cost system where every Shopify order runs through WhatsApp
(confirmation → delivery + GST invoice → rating), where failed deliveries clean
themselves up in Shopify automatically, where every order's economics land in a
spreadsheet you can file GST from, and where marketing campaigns go out from the
same place. Strictly TypeScript/Node. No paid WhatsApp platform, no third-party CRM,
no paid hosting.

**Cost philosophy:** Direct Meta Cloud API = ₹0 platform fee; you pay Meta per
delivered template message only (~₹0.35–0.40 utility, ~₹0.88 marketing in India —
check Meta's current rate card). Cloud Run free tier, Google Sheets as the store.
**Fixed cost target: ₹0/month + per-message fees.**

**Build order:** one working feature at a time. Nothing starts until the thing it
depends on is live and tested against real orders.

---

## Where this stands

| | Status |
|---|---|
| **Phase 0** — hub foundation | ✅ Built |
| **Phase 1** — order confirmation | ✅ Built |
| **Phase 1** — early COD payment link | ✅ Built, **moved to Stage 2**, disabled by flag |
| **Stage 1** | 📄 Specced — `docs/superpowers/specs/2026-09-15-stage-1-design.md` |
| **Stage 2** | Not started |

The original seven-phase plan is superseded by the two stages below. Phases 0 and 1
are kept as-is because they shipped; everything after them was re-scoped on
2026-09-15.

---

## Stage 1 — the scope

### WhatsApp messages

1. **Order confirmation** — shipped, unchanged
2. **Order delivered**, with the GST invoice attached as a document
3. **Order rating**, with a Judge.me follow-up for happy customers
4. **Order cancelled** — one template, reason as a variable (undeliverable /
   customer cancelled / refused delivery)
5. **Marketing campaigns**

*Early COD payment is Stage 2.*

### Automation

6. **RTO cleanup** — when Shadowfax reports a return, cancel the Shopify order with
   the note *"user cancel, user did not take delivery or cancel the delivery"*, tag it
   `rto`, and restock the items
7. **COD delivered → mark paid** in Shopify

### Data

8. **Per-order finance ledger** in the CRM Sheet — order no, pincode, state, SKUs,
   item amount, shipping charged, total, COD/prepaid, GST on goods, GST on shipping,
   delivered/RTO, the blended 5% platform charge, EBITDA, PAT. Auto-filled on
   delivery. Five columns you fill by hand: COD charges, **shipping cost**, COGS,
   RTO loss, notes — the hub cannot write to them.
9. **GSTR-1 B2CS** — statewise, rate-wise, monthly, downloadable in the GST offline
   tool's format.

---

## Phase 0 — Foundation ✅ BUILT

### What you configured

1. **Business verification on Meta** — business.facebook.com → Security Centre.
   Unlocks >250 conversations/day.
2. **Dedicated phone number** — a number on the WhatsApp Business *app* cannot be used
   on the API at the same time.
3. **Meta Developer App** — use case "Connect with customers through WhatsApp",
   attached to the existing Business Portfolio.
4. **Permanent access token** — system user `urbnmyth-whatsapp-bot`, expiry Never,
   scopes `whatsapp_business_messaging` + `whatsapp_business_management`.
5. **Billing** — card attached in WhatsApp Manager.
6. **Display name & profile** — "URBNMYTH", logo, website, address.
7. **Google Cloud Run** — `asia-south1` (Mumbai), deployed from source, no Dockerfile.
   ⚠️ **Stage 1 adds `--max-instances=1`** — see the invoice numbering note below.
8. **Google Sheets store** — one `URBNMYTH-CRM` spreadsheet, service account with no
   key file, access granted by sharing the Sheet. Code uses Application Default
   Credentials.

### What was built

The Express hub: Meta webhook (verify + receive), Shopify webhook (HMAC-verified),
`lib/whatsapp` (templates, media, documents), `lib/sheets` (read/write via ADC),
config validated at boot.

---

## Phase 1 — Order confirmation ✅ BUILT

Shopify order created → row in the Sheet → WhatsApp confirmation template →
**"I Confirm"** / **"Cancel Order"** quick replies → dashboard reflects status.

- `order_confirm_cod` — COD orders, two quick-reply buttons
- `order_confirm_prepaid` — prepaid orders, no buttons
- Phone normalised to `91XXXXXXXXXX`; orders with no usable phone go straight to
  `NO_RESPONSE`
- Duplicate Shopify webhooks deduped on order id

**Changing in Stage 1:** the "Cancel Order" button currently only marks the Sheet.
It will queue the order for your review on the dashboard, and cancel + restock in
Shopify once you approve.

---

## Stage 1 — Plan 1: the delivery spine

**Spec:** `docs/superpowers/specs/2026-09-15-stage-1-design.md`

### What you configure

1. **Shadowfax webhooks** — ask your account manager to push status changes to
   `https://your-hub/webhook/shadowfax`, and get their **status vocabulary** and
   **auth mechanism**. A 4-hourly poller runs as a safety net either way.
2. **Shopify webhooks** — add `fulfillments/create` and `fulfillments/update`. These
   carry the AWB, which is how a Shadowfax status finds its order.
3. **Templates** (Utility):
   - `order_delivered_invoice` — document header, invoice attached
   - `order_cancelled` — reason as a variable
   - `order_rating` — three quick replies (`⭐ 1–2`, `⭐ 3`, `⭐ 4–5`); WhatsApp
     allows a maximum of three
4. **Invoice identity** — `SELLER_LEGAL_NAME`, `SELLER_ADDRESS`, `SELLER_GSTIN`,
   `DEFAULT_HSN`, `INVOICE_SERIES_PREFIX`.
5. **Cloud Run `--max-instances=1`.** GST requires a gapless invoice series and
   Sheets has no atomic increment; one instance (80 concurrent requests by default,
   far beyond your volume) makes the counter safe at zero cost.
6. **Cloud Scheduler** — four jobs hitting `/internal/sync-shipments`,
   `/internal/rating-sweep`, `/internal/drain-effects`, `/internal/campaign-tick`.
7. **Judge.me** — free plan; decide whether the review link is per-product or
   store-level.
8. ⚠️ **Take the GST slab assumption to your CA.** Prices are GST-inclusive, and the
   hub applies the ₹2,500 threshold to the **inclusive per-piece price**. The strict
   reading (threshold on the taxable value) is circular and has an unsolvable dead
   zone around ₹2,625–2,950. See §5.1 of the spec — it is isolated in one function
   and cheap to change.

### What Claude Code writes

1. Column-scoped Sheet writes; the whole-row `updateOrder` is **deleted** so it can
   never erase your hand-filled ledger columns
2. New tabs (`shipments`, `ledger`, `invoices`, `b2cs`, `contacts`, `campaigns`,
   `campaign_sends`); ledger row created at order time with **live Sheets formulas**
   for net revenue / EBITDA / PAT, so filling COGS three days later updates them by
   itself
3. Shipment ingestion — webhook and poller converging on one guarded transition
   function, so a status arriving twice cannot double-send
4. The GST engine (slab rate, inclusive → taxable, shipping apportioned pro-rata
   across mixed rates, CGST+SGST vs IGST) and the invoice PDF
5. **Delivered** → mark COD paid in Shopify → invoice → message → ledger →
   queue the rating request
6. **RTO** → cancel + note + `rto` tag on initiate; restock when the parcel is
   physically back
7. **Cancel review queue** on the dashboard
8. **Rating sweep** at day 3; 4–5★ gets the Judge.me link free inside the service
   window, 1–2★ opens a service ticket
9. **B2CS** — `b2cs` Sheet tab plus a CSV in the GST offline tool's format
10. Dashboard: delivery funnel, RTO list, invoice register, cancel review queue,
    GST discrepancy flags, failed-effect queue

### Exit test

- [ ] Real delivered COD order → marked paid in Shopify, invoice arrives on WhatsApp
- [ ] GST split correct for both an intra-state and an inter-state buyer
- [ ] Invoice total matches the amount charged to the paisa
- [ ] Real RTO → cancelled with note + `rto` tag, customer messaged, stock returns
      only once the parcel is back
- [ ] The same RTO status arriving by webhook *and* poll cancels exactly once
- [ ] Filling `cogs` by hand updates EBITDA and PAT without the hub touching the row
- [ ] B2CS CSV uploads to the GST portal without a format error
- [ ] Rating request arrives on day 3; all three buttons route correctly

**Cost:** ~2 utility messages per delivered order ≈ ₹0.70–0.80. One prevented RTO
pays for hundreds.

---

## Stage 1 — Plan 2: marketing campaigns

### What you configure

1. ⚠️ **Opt-in is mandatory.** Add a `whatsapp_optin` checkout field — Shopify's
   native consent fields cover email and SMS, not WhatsApp. Only opted-in numbers
   get marketing.
2. **Templates** (Marketing category) — image header, body variables, URL button with
   UTM. Make 2–3 variants; rejections then don't block you.
3. **Images** — reuse the standardised flat-lays. Consistent look = brand recall in chat.
4. **Know your tier.** Your number has a daily messaging cap (250 → 1K → 10K…).
   Set `MARKETING_DAILY_CAP` to match.

### What Claude Code writes

- `contacts` opt-in registry, fed from checkout, inbound messages, and later CTWA
- **`STOP` handling** — permanent opt-out on any unsubscribe wording
- Fixed named segments (`all-opted-in`, `past-buyers`, `repeat-buyers`, `lapsed-90d`,
  `bought-product-type-X`)
- Dashboard composer: template → image → variables → segment → preview →
  **confirmation showing recipient count and estimated cost** → send
- A **chunked** sender driven by Cloud Scheduler, because `min-instances=0` kills
  post-response work and `max-instances=1` forbids long requests. Resumable, ~1 msg/sec
- Guardrails: opted-out skipped; daily cap **halts** the run rather than blasting into
  a block; one marketing message per contact per 7 days; dashboard kill switch
- Per-recipient reporting off the existing Meta status webhook

### Exit test

- [ ] Campaign to a 5-person test list → image renders, UTM present, report fills in
- [ ] A non-opted-in number is skipped
- [ ] Replying `STOP` excludes that contact from the next campaign
- [ ] A campaign paused mid-run resumes where it stopped

**Why this is a separate deploy:** marketing shares no data and no code paths with the
order pipeline, but it *can* take the pipeline down through Meta — a quality-rating
drop throttles your order confirmations too. It ships on its own.

---

## Stage 2 — later

1. **Early COD payment** — already built. `PAY_EARLY_ENABLED=true` and the Cashfree
   keys switch it on: "I Confirm" → payment link for the total minus the COD fee →
   `PAID_EARLY` on success.
2. **Abandoned checkout recovery** — max 2 messages, opt-in applies.
3. **Claude-powered copywriter** in the dashboard, feeding the campaign composer.
4. **Out-for-delivery message**, if the delivered-only flow proves too quiet.

---

## The CRM dashboard, assembled

| Tab | Data |
|---|---|
| Orders & Confirmations | status pipeline, confirm % |
| Delivery | shipped → OFD → delivered funnel, RTO list |
| Cancellations | review queue, cancel reasons |
| Invoices | register, GST discrepancy flags, voids |
| Ledger | per-order economics, EBITDA, PAT |
| GST | monthly B2CS, CSV download |
| Campaigns | sent / delivered / read, cost, kill switch |
| Reviews | ratings, low-rating tickets |
| Health | failed effects, unmapped Shadowfax statuses |

All backed by the one `URBNMYTH-CRM` Sheet, so the existing Apps Script BI dashboard
keeps reading it.

---

## Architecture notes worth remembering

- **Sheets stays the store.** Volume doesn't justify a second one. **Upgrade trigger:**
  move to Firestore if the message log ever shows a genuine double-send, or the ledger
  passes ~5,000 rows.
- **The hub never writes your ledger columns.** COD charges, COGS, RTO loss and notes
  live in a block the writer cannot address.
- **Derived columns are formulas, not values** — no stale-number window.
- **Invoices are issued at delivery**, so RTO and cancelled orders never generate one
  and you never file GST on revenue you didn't keep.
- **Multi-effect flows record the transition first, then retry effects individually.**
  All-or-nothing retry would re-run whatever already succeeded.

---

## Cost traps to keep avoiding

- Monthly WhatsApp platforms (₹1,500–5,000/mo) — this *is* what they sell
- Marking transactional templates as Marketing or vice-versa
- Buying phone lists — instant ban risk, opt-in only
- Daily marketing blasts — a quality-rating drop throttles your order confirmations too
