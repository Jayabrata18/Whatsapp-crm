# URBNMYTH — WhatsApp Automation + CRM Dashboard Build Plan

**Goal:** One low-cost system where every Shopify order triggers WhatsApp flows (confirmation → early payment → invoice → delivery updates → review request), plus marketing/abandoned-cart campaigns and a Claude-powered message generator — all visible in one CRM dashboard. Stricly in TypeScript/Node.js and normal lookups (no paid WhatsApp platforms, no third-party CRMs, no paid hosting). The system is designed to be 

**modular**: each phase is a working feature that can be tested and live before moving to the next. 


**Build order:** Strictly one phase at a time. Don't start Phase N+1 until Phase N is live and tested with real orders.

**Cost philosophy:** No paid WhatsApp platform (no AiSensy/Interakt/Wati subscription). Direct Meta Cloud API = ₹0 platform fee, you only pay Meta per delivered template message (~₹0.35–0.40 utility, ~₹0.88 marketing in India, rates change — check Meta's rate card). Hosting on Google Cloud Run's free tier (2M requests/month — a webhook receiver won't come close). Total fixed cost target: **₹0/month + per-message fees**.

---

## Phase 0 — Foundation (do this once, everything depends on it)

### 0.1 What YOU configure (no code)

1. **Business verification on Meta** — business.facebook.com → Security Centre → Start Verification. Upload GST certificate / PAN / Udyam. Takes 2 days–2 weeks. **Start today**, it's the slowest step and unlocks >250 conversations/day.
2. **Dedicated phone number** — get a fresh SIM (or a virtual number) for the API. ⚠️ A number on the WhatsApp Business *app* cannot be used on the API at the same time. If you want to keep chatting manually from your current number, use a NEW number for the API.
3. **Meta Developer App** — developers.facebook.com → My Apps → Create App → use case "Connect with customers through WhatsApp" → attach your **existing** Business Portfolio (the one with your ad account, don't create a duplicate).
4. **Permanent access token** — Business Settings → Users → System Users → create `urbnmyth-whatsapp-bot` (Admin) → Assign Assets (your App = Full control, your WABA = Full control) → Generate Token → expiry **Never** → permissions `whatsapp_business_messaging` + `whatsapp_business_management`. Copy once, store safely.
5. **Payment method** — attach a card in WhatsApp Manager billing settings (this is what Meta bills per-message fees to).
6. **Display name & profile** — set "URBNMYTH" as display name, add logo, website, address in WhatsApp Manager. Display name needs Meta approval.
7. **Hosting for the hub server — Google Cloud Run (decided):**
   - Console → Billing → link a billing account (needed even though Cloud Run's free tier — 2M requests/month — means this realistically costs ₹0)
   - Enable the **Cloud Run API** and **Cloud Build API** (search bar → Enable, for each)
   - Deploy straight from source, no Dockerfile needed: `gcloud run deploy urbnmyth-hub --source . --region asia-south1 --allow-unauthenticated` (asia-south1 = Mumbai, lowest latency from Kolkata; `--allow-unauthenticated` lets Meta/Shopify actually reach it)
   - This prints a permanent URL like `https://urbnmyth-hub-xxxxxxx-uc.a.run.app` — use it for every webhook (`.../webhook/meta`, `.../webhook/shopify`, etc.)
   - Set secrets via `gcloud run services update urbnmyth-hub --region asia-south1 --set-env-vars KEY=value` (or Secret Manager + `--set-secrets` for real credentials — don't hardcode API keys)
8. **Data store** — **Google Sheets** (one new spreadsheet: `URBNMYTH-CRM`), connected via a **Google Cloud service account with no key file**:
   - Enable the Google Sheets API in the same GCP project
   - Create a service account (IAM & Admin → Service Accounts) — no IAM role needed, access is controlled by sharing the Sheet itself
   - Share `URBNMYTH-CRM` with the service account's email (`...@your-project.iam.gserviceaccount.com`) as Editor
   - Attach it to the Cloud Run service: add `--service-account your-sa-email` to the `gcloud run deploy` command above
   - Code uses Application Default Credentials (`google-auth-library`'s `GoogleAuth`, no JSON key file to store or leak) — this plugs straight into your existing Apps Script BI dashboard, migrate to SQLite/Postgres later only if volume demands it

### 0.2 What CLAUDE CODE writes

- A single **Node.js "hub" server** (Express) — this is the backbone for ALL seven phases:
  - `GET /webhook/meta` — webhook verification (echo `hub.challenge`)
  - `POST /webhook/meta` — receives incoming WhatsApp messages + button clicks + delivery statuses
  - `POST /webhook/shopify` — receives Shopify order events (HMAC-verified)
  - `lib/whatsapp.js` — helper to send template messages, media messages, documents via Graph API
  - `lib/sheets.js` — read/write rows to the Google Sheets CRM store, authenticated via the Cloud Run service account's Application Default Credentials (no key file)
  - `.env` / Cloud Run env vars for: Meta token, phone number ID, WABA ID, Shopify webhook secret, Cashfree keys, Zoho keys
- One test script: send yourself a `hello_world` template to prove the token + number work.

### 0.3 Exit test
- [ ] Business verification submitted (approval can lag, fine)
- [ ] Test template message received on your personal phone
- [ ] Meta webhook verified & receiving your replies (log incoming messages)

---

## Phase 1 — Order confirmation with "I Confirm" button + early-payment link

**Flow:** Shopify order created → WhatsApp template with **"I Confirm ✅"** quick-reply button → click updates dashboard status → auto-send Cashfree payment link ("pay now, skip COD/delivery charges").

### 1.1 What YOU configure

1. **Create templates in WhatsApp Manager** (Category: **Utility** — cheaper, and correct for transactional):
   - `order_confirm_cod` — body: order no, items, amount, COD note + **Quick Reply button: "I Confirm"** (+ optional "Cancel Order" button)
   - `pay_early_link` — body: "Pay ₹{{amount}} now and save ₹{{cod_charge}} COD charges" + **URL button** with dynamic suffix (Cashfree link)
   - Submit for approval (minutes–24h). Write natural copy, no spammy ALL CAPS — rejections waste days.
2. **Shopify webhook** — Settings → Notifications → Webhooks → `Order creation` → point to `https://your-hub/webhook/shopify` (JSON). Copy the signing secret into `.env`.
3. **Cashfree** — enable **Payment Links API** in the Cashfree dashboard, copy App ID + Secret (use test keys first).
4. **Checkout phone field** — make phone number **required** at checkout (Shopify Settings → Checkout). No phone = no WhatsApp.
5. **Decide the discount logic** — e.g., "pay online now → COD fee waived" or a flat ₹X off. Keep it one rule.

### 1.2 What CLAUDE CODE writes

- Shopify webhook handler: parse order → detect COD (`payment_gateway_names` contains your COD gateway) → normalize phone to `91XXXXXXXXXX` → write row to Sheet (`orders` tab: order_no, name, phone, amount, cod?, confirm_status=PENDING, timestamps) → send `order_confirm_cod` template.
- Meta webhook handler: on button reply `"I Confirm"` → match phone+context to order → update Sheet `confirm_status=CONFIRMED` → call Cashfree `POST /links` (amount minus incentive, purpose = order no, expiry 24h) → send `pay_early_link` template with the link.
- Cashfree payment webhook handler: on `PAYMENT_SUCCESS` → mark order `PAID_EARLY` in Sheet → (optional) Shopify Admin API: mark order paid / add tag `paid-early`.
- **Dashboard section** (in your existing BI dashboard): "COD Confirmations" table — order no, customer, status chip (PENDING / CONFIRMED / PAID_EARLY / NO_RESPONSE), confirm rate %. Reads the same Sheet.
- Idempotency: ignore duplicate webhooks (Shopify retries) using order_no dedupe.

### 1.3 Exit test
- [ ] Place a real COD test order → message arrives < 1 min
- [ ] Tap "I Confirm" → dashboard flips to CONFIRMED
- [ ] Payment link arrives, test-pay it → status flips to PAID_EARLY
- [ ] Duplicate webhook doesn't double-message

**Cost:** 2 utility messages/order ≈ ₹0.70–0.80 per COD order. The RTO you save on ONE fake order pays for hundreds of these.

---

## Phase 2 — Invoice on WhatsApp

**Flow:** Order confirmed/paid → generate invoice in Zoho Books → send the PDF as a WhatsApp **document message**.

### 2.1 What YOU configure

1. **Zoho Books API access** — Zoho API Console → create a "Self Client" → note Client ID/Secret → generate a refresh token with `ZohoBooks.invoices.ALL` scope. Note your Organization ID.
2. Decide the trigger: invoice on **payment** (early-paid orders) and on **delivery** (COD) is the clean GST-wise pattern — confirm with your CA.
3. **Template** `invoice_delivery` (Utility) — "Hi {{name}}, your invoice for order {{order_no}} is attached." (Document-header templates, or send doc inside the 24h service window opened by their "I Confirm" reply — free!)

### 2.2 What CLAUDE CODE writes

- `lib/zoho.js` — OAuth refresh-token flow, `createInvoice(order)` mapping Shopify line items → Zoho items (GST slab: 5% below ₹2,500, 18% at/above — reuse your existing tax rules), `getInvoicePdf(id)`.
- Upload PDF to Meta media endpoint → send document message. Prefer sending **within the 24-hour service window** after the customer's button click = the message is **free**.
- Log `invoice_sent` in Sheet; dashboard column added.

### 2.3 Exit test
- [ ] Test order → invoice appears in Zoho Books with correct GST
- [ ] PDF lands in WhatsApp, opens correctly on a phone

---

## Phase 3 — Out-for-delivery + delivered thank-you with coupon

**Flow:** Shadowfax status `OUT_FOR_DELIVERY` → heads-up message. Status `DELIVERED` → thank-you + coupon code for next purchase.

### 3.1 What YOU configure

1. **Shadowfax webhooks** — ask your Shadowfax account manager to enable status webhooks to `https://your-hub/webhook/shadowfax` (you're already on their Unified API for the tracking page). If webhooks aren't available on your plan, fall back to polling every 30 min (Claude Code writes the cron).
2. **Templates** (Utility): `out_for_delivery` (order no, AWB, "keep ₹{{amount}} ready" for COD), `delivered_thanks` ("Thank you! Here's {{coupon}} for 10% off your next drop" + URL button to store).
3. **Coupon strategy** — create a Shopify **discount code pattern** (e.g., unique codes via Admin API, or one rotating monthly code `MYTH10-AUG`). Unique codes = trackable repeat-purchase attribution in your BI dashboard.

### 3.2 What CLAUDE CODE writes

- Shadowfax webhook/poller: map AWB → order (Sheet lookup) → on OFD send `out_for_delivery`, on DELIVERED send `delivered_thanks` with a coupon (generated via Shopify Admin API `discountCodeBasicCreate`, 30-day expiry, one-use).
- State machine guard: never send the same status twice; log every send in a `messages` tab (order_no, template, timestamp, wamid, delivery status from Meta webhooks).
- Dashboard: delivery funnel (Shipped → OFD → Delivered) + coupon redemption count.

### 3.3 Exit test
- [ ] Real shipment triggers both messages at the right moments
- [ ] Coupon works at checkout and shows in dashboard when redeemed

---

## Phase 4 — Marketing campaigns with product image

**Flow:** You pick a segment + product image + copy in the dashboard → bulk-send a Marketing template with image header.

### 4.1 What YOU configure

1. ⚠️ **Opt-in is mandatory** for marketing messages (Meta policy — violations kill your number's quality rating). Add:
   - Checkout checkbox: "Send me offers on WhatsApp" (Shopify checkout customization / order note attribute)
   - A `whatsapp_optin` column in the CRM Sheet; ONLY opted-in numbers get marketing.
2. **Template** `product_drop` (Category: **Marketing**) — **Image header** + body with {{1}} name, {{2}} offer + URL button to product. Create 2–3 variants (Meta rotates better, and rejections don't block you).
3. Product images: reuse your Higgsfield-standardized flat-lays — consistent look = brand recall in chat.
4. Start slow: your number has a daily messaging tier (250 → 1K → 10K…). Blast too hard too early = blocks.

### 4.2 What CLAUDE CODE writes

- Dashboard "Campaigns" section: pick template, upload/choose image, select segment (all opted-in / past buyers / bought category X), preview, **Send** with a confirmation step showing recipient count + estimated cost (count × ₹0.88).
- Sender with rate limiting (e.g., 1 msg/sec), retry on transient errors, skip non-opted-in, log per-recipient result.
- Campaign report: sent / delivered / read (from Meta status webhooks) / clicked (UTM on the button URL → your Shopify analytics).

### 4.3 Exit test
- [ ] Campaign to a 5-person test list → image renders, link has UTM, report fills in

**Cost:** ~₹0.88 × recipients. A 500-person drop ≈ ₹440 — compare that to your Meta Ads CPM and you'll likely find WhatsApp beats it for repeat buyers.

---

## Phase 5 — Abandoned checkout recovery

**Flow:** Checkout started, not completed in N hours → reminder with cart link (+ optional small incentive in message 2).

### 5.1 What YOU configure

1. Shopify webhook: `Checkout creation` + `Checkout update` → your hub. (Shopify's `abandoned_checkout_url` is the recovery link.)
2. **Templates** (Marketing category — recovery messages count as marketing): `cart_reminder_1` (2h after abandonment, no discount, just "your cart is waiting" + image), `cart_reminder_2` (24h, small incentive). **Max 2 messages.** More = spam reports = quality rating drops.
3. Opt-in rule applies here too — only message if phone captured AND opted in.

### 5.2 What CLAUDE CODE writes

- Abandonment detector: store checkout events; a cron (every 15 min) finds checkouts >2h old with no matching order (match by checkout token/email/phone) → send reminder 1; >24h → reminder 2; mark recovered when order lands.
- Dashboard: abandoned count, messaged, recovered, recovery revenue (this is THE metric — expect 10–25% recovery vs ~3–8% for email).

### 5.3 Exit test
- [ ] Abandon a test cart → reminder at ~2h with working recovery link → completing purchase stops reminder 2

---

## Phase 6 — Claude-powered marketing message generator in the dashboard

**Flow:** Dashboard section "AI Copywriter" — you type product + occasion + tone → Claude generates 3 caption/message variants → you pick/edit → it pre-fills the Phase 4 campaign form.

### 6.1 What YOU configure

1. Anthropic API key (console.anthropic.com) — pay-as-you-go; Haiku-class model is plenty for short marketing copy and costs a fraction of a rupee per generation.
2. Write your **brand voice note** once (tone, words to avoid, no hard-sell of brand/logo name — matches how you already like captions).

### 6.2 What CLAUDE CODE writes

- `POST /api/generate-copy` on the hub: takes product name, offer, audience, occasion → calls Anthropic Messages API with a system prompt embedding your brand voice + WhatsApp template constraints (char limits, {{1}} variable slots, no prohibited content) → returns 3 variants as JSON.
- Dashboard UI: form → variant cards → "Use this" → drops into campaign composer. Also a "remix" button for regenerating a single variant.
- Guardrail: generated copy still goes through Meta **template approval** (or is sent as free-form only inside open 24h service windows). The UI should label which path applies.

### 6.3 Exit test
- [ ] Generate → edit → send a campaign end-to-end without leaving the dashboard

---

## Phase 7 — Product review & rating (WhatsApp + email)

**Flow:** 3 days after DELIVERED → WhatsApp message with 1–5 star quick-reply buttons (or a link) + parallel email. Ratings land in dashboard; 4–5 stars get nudged to post publicly.

### 7.1 What YOU configure

1. **Template** `review_request` (Utility if purely transactional feedback, Marketing if it promotes) — 3 quick-reply buttons: "⭐ 1–2", "⭐ 3", "⭐ 4–5" (WhatsApp allows max 3 quick replies) or a URL button to a review page.
2. Email path: **Shopify's built-in email** or a free-tier app (see suggestions) — schedule 3 days post-delivery.
3. Decide where public reviews live: on-site product reviews (Judge.me free plan) vs Google.

### 7.2 What CLAUDE CODE writes

- Cron: find orders DELIVERED ≥3 days, review_requested=false → send template, mark sent.
- Button-reply handler: store rating in Sheet (`reviews` tab). If 4–5 → auto-reply (free, inside service window) with the product's review-page link asking to post it. If 1–2 → auto-reply "so sorry — reply here and we'll fix it", and flag in dashboard as **service ticket**.
- Dashboard: average rating per product, low-rating alerts, review conversion rate. Feed per-product ratings into your product-profitability view later.

### 7.3 Exit test
- [ ] Simulated delivered order gets the ask on day 3; each button routes correctly

---

## CRM Dashboard — what it looks like assembled

One new section in your existing BI dashboard (or a page on the Node hub) with tabs:

| Tab | Data | Phase |
|---|---|---|
| Orders & Confirmations | status pipeline, confirm %, early-pay conversion | 1 |
| Invoices | sent/failed | 2 |
| Delivery | OFD/Delivered funnel, coupon redemptions | 3 |
| Campaigns | sent/delivered/read/clicked, cost | 4 |
| Abandoned Carts | recovery rate, revenue recovered | 5 |
| AI Copywriter | generate & send | 6 |
| Reviews | ratings, alerts | 7 |
| Message Log | every WhatsApp send + Meta delivery status | all |

All backed by the one `URBNMYTH-CRM` Google Sheet → your Apps Script BI dashboard can read it too, no new database to pay for or maintain.

---

## Suggestions, add-ons & low-cost apps worth connecting

**Do these, they're free/cheap and compound:**

1. **Judge.me (free plan)** — on-site product reviews with photos; pairs with Phase 7 (WhatsApp collects the rating, Judge.me hosts the public review). Photo reviews on streetwear PDPs measurably lift conversion.
2. **Shopify Flow (free, built-in)** — no-code automations for edge cases: auto-tag `high-RTO-pincode` orders, auto-tag repeat buyers into a "VIP" segment you can target in Phase 4.
3. **Cloud Monitoring uptime checks (free, built into GCP)** — since the hub is on Cloud Run, use Cloud Monitoring's free uptime check instead of a third-party pinger; it also gives you an alert if a webhook ever starts failing.
4. **Cloud Run min-instances=0 stays the default** — don't bump it up "to avoid cold starts" unless you actually see a problem; cold starts on Cloud Run are sub-second to a couple seconds, not the 30–50s Render's free tier has, so it's rarely worth the (small) always-on cost.
5. **Cashfree "payment link reminders"** — Cashfree can auto-remind on unpaid links; switch it OFF and let YOUR WhatsApp flow do reminders, so the customer isn't double-messaged.
6. **Meta CTWA (Click-to-WhatsApp) ads** — since you already run Meta Ads: ads that open a WhatsApp chat give you a **72-hour free messaging window** with that person and capture their number with implicit opt-in. Cheapest legit way to grow your marketing list for Phase 4/5.
7. **WhatsApp chat widget on the store** — a simple free `wa.me` link button in your theme (you already built share popups — same pattern). Every inbound chat = free 24h service window + an opted-in-ish contact.
8. **Later, if volume grows:** move Sheets → SQLite/Postgres; add a queue (BullMQ) for campaign sends. Not now — don't over-engineer before you have the volume.

**Things to deliberately AVOID (cost traps):**
- Monthly WhatsApp platforms (₹1,500–5,000/mo) — you're building exactly what they sell.
- Marking transactional templates as "Marketing" or vice-versa — wrong category = higher cost or rejection.
- Buying phone-number lists — instant ban risk; opt-in only.
- Sending >2 abandoned-cart messages or daily marketing blasts — quality rating drops throttle your whole number, including order confirmations.

---

## Master checklist (your side, in order)

- [ ] Phase 0: verification submitted, number ready, app + permanent token created, hub deployed to Cloud Run, service account shared with CRM Sheet
- [ ] Phase 1: 2 templates approved, Shopify webhook set, Cashfree keys, phone required at checkout
- [ ] Phase 2: Zoho self-client + refresh token, invoice trigger decided with CA
- [ ] Phase 3: Shadowfax webhooks enabled, 2 templates approved, coupon rule decided
- [ ] Phase 4: opt-in checkbox live, marketing templates approved, images picked
- [ ] Phase 5: checkout webhooks set, 2 recovery templates approved
- [ ] Phase 6: Anthropic API key, brand voice note written
- [ ] Phase 7: review template approved, Judge.me installed, email timing set

Hand each phase's "What Claude Code writes" block to Claude Code as-is — it's scoped to be one working feature per session.