# WhatsApp Templates — Phase 1 + Stage 1 delivery spine

Create these in WhatsApp Manager → Account tools → Message templates.
All six are **Utility** category. Language: **English** (code `en`) — this must match
`TEMPLATE_LANG` in the environment.

Variable order below matches `bodyParams` in the code exactly. Changing the order in
Meta without changing the code will send the wrong values into the wrong slots.

---

## 1. `order_confirm_cod`

**Category:** Utility
**Buttons:** two Quick Reply buttons — `I Confirm` and `Cancel Order` (exact labels; the
code matches on them case-insensitively, ignoring emoji and punctuation)

**Body:**

```
Hi {{1}}, thanks for ordering from URBNMYTH.

Order {{2}}
{{3}}
Total: ₹{{4}} (Cash on Delivery)

Please confirm so we can pack and ship it today.
```

**Variables:** `{{1}}` customer first name · `{{2}}` order number · `{{3}}` items summary · `{{4}}` order total

**Sample values for Meta's review form:** `Aarav`, `#1042`, `Oversized Tee — Black x2, Cargo Pants — Olive x1`, `1899`

---

## 2. `order_confirm_prepaid`

**Category:** Utility
**Buttons:** none

**Body:**

```
Hi {{1}}, your URBNMYTH order is confirmed.

Order {{2}}
{{3}}
Paid: ₹{{4}}

We're packing it now and will share tracking as soon as it ships.
```

**Variables:** identical to `order_confirm_cod` — same four, same order.

**Sample values:** `Aarav`, `#1042`, `Oversized Tee — Black x2, Cargo Pants — Olive x1`, `1899`

---

## 3. `pay_early_link`

**Category:** Utility
**Buttons:** one **URL button**, label `Pay Now`, type **Dynamic**

Base URL: `https://payments.cashfree.com/links/{{1}}`
(In sandbox, use `https://payments-test.cashfree.com/links/{{1}}`.)

The code passes the Cashfree `link_id` as the dynamic suffix.

**Body:**

```
Great, {{1}} — your order is confirmed.

Pay ₹{{2}} online now and we'll waive the ₹{{3}} cash-on-delivery charge.
The link is valid for 24 hours. Prefer COD? Just ignore this, nothing changes.
```

**Variables:** `{{1}}` customer first name · `{{2}}` payable amount · `{{3}}` COD fee waived

**Sample values:** `Aarav`, `1849`, `50`

---

## 4. `order_delivered_invoice`

**Category:** Utility
**Header:** **Document** (media header) — the tax invoice PDF is attached here, uploaded to
Meta first and sent as the header's media id

**Body:**

```
Hi {{1}}, your URBNMYTH order {{2}} has been delivered.

Your GST tax invoice is attached above — please save it for your records.

Thanks for shopping with us!
```

**Variables:** `{{1}}` customer first name · `{{2}}` order number

**Sample values for Meta's review form:** `Aarav`, `#1042`

---

## 5. `order_cancelled`

**Category:** Utility
**Buttons:** none

**Body:**

```
Hi {{1}}, order {{2}} has been cancelled — {{3}}.

If any amount was collected, it will be refunded to the original payment method.
Reach out anytime if you have questions.
```

**Variables:** `{{1}}` customer first name · `{{2}}` order number · `{{3}}` reason phrase
(the code fills this in — e.g. `cancelled at your request`, `returned to us undelivered`)

**Sample values:** `Aarav`, `#1042`, `cancelled at your request`

---

## 6. `order_rating`

**Category:** Utility
**Buttons:** three Quick Reply buttons — `⭐ 1–2`, `⭐ 3`, `⭐ 4–5` (exact labels; the code
extracts the digits from whichever button text Meta echoes back, so emoji/dash variants
all resolve the same way)

**Body:**

```
Hi {{1}}, how would you rate your recent URBNMYTH order {{2}}?

Tap a button below to let us know.
```

**Variables:** `{{1}}` customer first name · `{{2}}` order number

**Sample values:** `Aarav`, `#1042`

---

## Notes on approval

- Write sentence case. ALL CAPS and excessive punctuation draw rejections.
- The URL button's base URL must be a real, reachable domain.
- Approval is usually minutes, occasionally up to 24 hours. A rejection tells you which
  policy was hit — fix and resubmit rather than creating a new template name.
- After approval, confirm the template name is spelled exactly as above. A mismatch
  surfaces as Meta error code 132001 in the hub logs.
