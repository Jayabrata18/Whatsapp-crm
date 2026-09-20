# Launching Stage 1 — the delivery spine

Everything in this file is a step only a human can take. The code is done; these
are the credentials, approvals and eyeball checks it depends on.

Work top to bottom — step 1 has a multi-day approval delay, so start it first.

---

## 1. Get three WhatsApp templates approved

Meta review takes days. Start here.

Phase 0-1 already covers `order_confirm_cod`, `order_confirm_prepaid` and
`pay_early_link`. Stage 1 adds three:

| Template | Category | Notable |
|---|---|---|
| `order_delivered_invoice` | Utility | **Document header** — the tax invoice PDF attaches here |
| `order_cancelled` | Utility | `{{1}}` name · `{{2}}` order no · `{{3}}` reason phrase |
| `order_rating` | Utility | Three quick replies: `⭐ 1–2`, `⭐ 3`, `⭐ 4–5` |

Exact body copy, variable order, and sample values for Meta's review form are in
[`docs/templates.md`](docs/templates.md).

> **The names and button labels must match exactly.** The code matches incoming
> replies against those literal strings. A renamed button does not error — it
> silently stops rating capture from working.

`pay_early_link` is **not** needed for Stage 1: `PAY_EARLY_ENABLED` defaults to
`false` and Cashfree is deferred to Stage 2. The adapter, service and route all
still exist, so enabling it later is one environment variable.

---

## 2. Set every required environment variable

`src/config.ts` validates with Zod at startup, so a missing value **crashes the
service on boot** rather than failing later. That is deliberate — but it means
the list has to be complete before the first deploy.

`deploy.sh` now passes all twenty of these (non-secrets as `--set-env-vars`,
secrets as `--set-secrets`) and refuses to run without the ones it expects in
your shell. It previously passed only ten, which meant the container it built
crash-looped on boot.

### You must supply these (no defaults)

| Variable | Where it comes from |
|---|---|
| `META_ACCESS_TOKEN` | Meta app |
| `META_PHONE_NUMBER_ID` | Meta WhatsApp number |
| `META_WABA_ID` | Meta WhatsApp Business Account |
| `META_VERIFY_TOKEN` | you invent it; must match the webhook config |
| `META_APP_SECRET` | Meta app |
| `SHOPIFY_WEBHOOK_SECRET` | Shopify webhook settings |
| `SHOPIFY_STORE_DOMAIN` | e.g. `urbnmyth.myshopify.com` |
| `SHOPIFY_ADMIN_TOKEN` | Shopify custom app |
| `SHOPIFY_LOCATION_ID` | Shopify fulfillment location RTO stock returns to |
| `SHEET_ID` | the Google Sheet's id |
| `DASHBOARD_TOKEN` | you invent it; guards the operator dashboard |
| `INTERNAL_TASK_TOKEN` | you invent it; **minimum 16 characters** |
| `SHADOWFAX_BASE_URL` | Shadowfax account manager |
| `SHADOWFAX_API_KEY` | Shadowfax account manager |
| `SHADOWFAX_WEBHOOK_SECRET` | you invent it; give the same value to Shadowfax |
| `SELLER_LEGAL_NAME` | your GST registration |
| `SELLER_ADDRESS` | your GST registration |
| `SELLER_GSTIN` | **exactly 15 characters**, and its first two **must** equal `SELLER_STATE_CODE` |
| `DEFAULT_HSN` | ≥4 chars; `6109` for knitted apparel |
| `JUDGEME_REVIEW_URL` | your Judge.me review page |

The GSTIN rule is now enforced at boot. The first two digits of a GSTIN *are* the
state code, and a mismatch is not a cosmetic error: every invoice would print one
state's GSTIN while declaring supplies from another, and every CGST+SGST-vs-IGST
decision would be taken against the wrong home state. Silent, systematic, and
only visible at assessment.

`INTERNAL_TASK_TOKEN` is read once from Secret Manager (`internal-task-token`)
and used for two things — the service's own copy and the bearer header on all
three Cloud Scheduler jobs — precisely so the two cannot drift. A drift would be
a 401 on every scheduled job, with nothing but a log line to say so.

### These have sensible defaults — override only if wrong

`PORT` 8080 · `SELLER_STATE_CODE` 19 (West Bengal) · `COD_FEE_INR` 50 ·
`GST_SLAB_THRESHOLD_INR` 2500 · `GST_RATE_LOW` 5 · `GST_RATE_HIGH` 18 ·
`INVOICE_SERIES_PREFIX` UM · `PLATFORM_FEE_PCT` 5 · `CORPORATE_TAX_PCT` 25 ·
`RATING_DELAY_DAYS` 3 · `TEMPLATE_LANG` en · `PAY_EARLY_ENABLED` false ·
`COD_GATEWAY_NAMES` `cash on delivery,cod`

`CASHFREE_APP_ID` / `CASHFREE_SECRET_KEY` / `CASHFREE_ENV` are unused while
`PAY_EARLY_ENABLED=false`.

---

## 3. Grant the Shopify app its scopes

The custom app's Admin API token needs all of:

```
write_orders  read_orders  write_inventory  read_products  read_inventory
```

A missing scope fails at runtime with an authorization error that looks nothing
like a scope problem, so check this before debugging anything else.

---

## 4. Create the Google Sheet tabs

Run this once against the sheet named by `SHEET_ID`:

```
SHEET_ID=your-spreadsheet-id npm run setup:sheets
```

It creates the eight tabs the hub reads and writes —

```
orders   messages   events   shipments   invoices   effects   ledger   b2cs
```

— and writes each one's header row from the same constants the code itself uses,
so the column order cannot drift from what the readers expect. It is idempotent:
a tab that already exists is left exactly as it is, so re-running it is safe and
it will never touch data you have.

Authentication is the same Application Default Credentials the service uses.
Either `gcloud auth application-default login` as yourself, or run it with the
service account whose email the sheet is shared with as an **Editor**.

Do this **before the first order**, not after. Every reader addresses a hardcoded
range (`orders!A:U`, `b2cs!A:F`, …) and Google answers HTTP 400 `Unable to parse
range` for a tab that does not exist — so on a bare spreadsheet the first
fulfillment webhook, the first delivery and the first B2CS run all fail outright.
Every reader also skips row 1 as the header, so a tab created by hand without one
silently loses its first record.

The `ledger` tab has a column contract worth understanding:

- **A–Q** — written by the hub. Never edit by hand; it overwrites.
- **R–V** — **yours.** Costs you fill in manually. The hub has a hardcoded
  column ceiling at Q and structurally cannot write here.
- **W–Y** — spreadsheet formulas (net revenue, EBITDA, PAT) that recompute from
  your R–V entries automatically.

---

## 5. Deploy at one instance

`deploy.sh` sets `--max-instances=1`, and that is load-bearing, not a cost
saving. The gapless invoice series and four read-then-write guards
(`InvoicingService`, `CancellationService.approve`, `ReportingService.generate`,
`ShipmentSyncService.applyShipmentStatus`) use in-process mutexes that only
serialise within a single instance. Raising the instance count reintroduces the
exact races those guards were written to close — including duplicate invoice
numbers, which is a GST compliance problem.

One exception is inherent and cannot be configured away: **max-instances is
enforced per revision.** During a traffic migration the outgoing and incoming
revisions can both serve for a few seconds, each with its own mutexes and neither
aware of the other. Deploy when the shop is quiet, and glance at the invoice
register afterwards.

Then register the four Cloud Scheduler jobs (`deploy.sh` contains the commands):
`sync-shipments` every 4h · `rating-sweep` daily · `drain-effects` every 5 min ·
campaign tick commented out until Plan 2.

---

## 6. Three things that need your eyes, not a test

**Open a generated invoice PDF and look at it.** Automated checks prove the
legally required fields are drawn, the columns do not overlap, and a long
description wraps without colliding with the next row. Whether it reads as a
professional tax invoice is a judgement no test made, and no human has opened
one yet. Do this before the first real invoice goes to a customer.

**Confirm Shadowfax's real status vocabulary with your account manager.** Our
mapping from their status strings to our fulfillment states is an educated
guess — the spec flags it as an open item. If their strings differ, parcels
silently stop moving. The dashboard's **Health** panel lists unmapped statuses
for exactly this reason; check it in the first week.

`NDR` and `UNDELIVERED` are deliberately **not** mapped. An NDR is a failed
delivery attempt, not a return, and the courier normally re-attempts — so they
land in the unmapped list for you to judge, rather than cancelling a live order
and telling the customer their parcel came back while it is still out. If
Shadowfax confirms a string that genuinely means "coming back to you", add it to
`STATUS_MAP` in `src/adapters/shadowfax.ts`; no other file changes.

**Watch the Health panel's "Blocked invoices" list in the first week.** The hub
now refuses to invoice an order whose place of supply is unresolved, whose
frozen line data is missing, or whose round-off exceeds ±₹1 — rather than
guessing a state, a tax rate, or burying an unexplained gap in the Round Off
line of a legal document. Expect entries at cutover: every order placed before
the `lines_json` column existed has a blank column U and cannot be invoiced
until it is filled in.

To recover a blocked order: fix the underlying cell (`lines_json` in `orders`
column U, or `pos_code` in `ledger` column E), then set that order's `delivered`
row in the `effects` tab back to `PENDING` and clear its `next_attempt_at` to a
past timestamp. The next `drain-effects` tick picks it up and completes the
delivery — mark-as-paid, ledger close and invoice — exactly as it would have.

---

## 7. Exit criteria — run these against the real store

From the plan. Do not call Stage 1 done until each passes.

- [ ] `npm test && npm run typecheck && npm run build` all pass
- [ ] Real delivered COD order → marked paid in Shopify, invoice PDF arrives on WhatsApp
- [ ] GST split correct for both an intra-state (CGST+SGST) and inter-state (IGST) buyer
- [ ] Invoice total matches the amount charged, to the paisa
- [ ] **A discounted order invoices correctly** — place an order with a discount
      code, confirm the invoice's Round Off is a few paise and not the discount,
      and that the taxable value reflects what was actually paid
- [ ] Real RTO → cancelled with the note and `rto` tag, customer messaged, stock
      returns only once the parcel is physically back
- [ ] The same RTO status arriving by webhook *and* poll cancels exactly once
- [ ] Ledger row completes on delivery; filling `cogs` by hand updates EBITDA and
      PAT without the hub touching the row
- [ ] **Run one month's B2CS CSV through the GST Returns Offline Tool before the
      first real filing.** The `Place Of Supply` column currently emits a bare
      `19` (`src/core/b2cs.ts:91`) and the tool may expect `19-West Bengal`. This
      is unverified — nobody has imported one of our files yet. Do it with a
      throwaway month's data, in the tool, before anything is filed: the fix is
      one line, but only if you find it before the deadline rather than after.
- [ ] B2CS CSV for a month uploads to the GST portal without a format error
- [ ] Rating request arrives on day 3; all three buttons route correctly
- [ ] Replaying an old Shopify order webhook still sends no second message

---

## Known limitations shipped deliberately

- **`orderCancel` is asynchronous.** Shopify returns a job id; we log it and
  treat acceptance as success rather than polling to completion. A cancel that
  fails *after* acceptance would be recorded as done. Worth watching early.
- **The already-cancelled detection matches on message text.** Shopify exposes
  no error code for it (the enum was checked). If they reword the message, the
  cancel fails loudly with the exact text logged — a one-line fix, by design,
  rather than a silent no-op.
- **No per-product HSN.** Every invoice line uses `DEFAULT_HSN`. Fine for a
  single-category catalogue; revisit if the range broadens.
- **Buyer address on invoices is pincode + state**, not a street address. Legal
  below the ₹50,000 B2C threshold, which the ~₹5,000 order ceiling keeps it
  well under.
- **Only two discount sources are modelled**: Shopify's per-line
  `discount_allocations` and, failing those, order-level `total_discounts`, both
  netted into the per-piece price before the ₹2,500 GST slab is decided. Anything
  else that makes the collected amount disagree with the line total — a gift
  card, a partial refund, a price edit after the order was frozen — is caught by
  the ±₹1 round-off guard and blocks the invoice rather than distorting it.
- **Place-of-supply codes accept two spellings** for Uttarakhand, Odisha,
  Chhattisgarh and Telangana (`UT`/`UK`, `OR`/`OD`, `CT`/`CG`, `TG`/`TS`),
  because which one Shopify sends for India is not documented as stable. Any
  province code outside that table blocks the invoice rather than guessing.
