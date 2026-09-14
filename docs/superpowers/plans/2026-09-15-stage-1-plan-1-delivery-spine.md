# Stage 1 — Plan 1: Delivery Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take an order from "shipped" to "delivered with a GST invoice on WhatsApp" or "returned, cancelled and restocked in Shopify", recording the economics of either outcome in a ledger you can file GST from.

**Architecture:** The existing four-layer shape is unchanged — `routes → services → core`, adapters injected at construction, `core/` importing nothing outward. Shadowfax status arrives by webhook *or* poller and both converge on one guarded transition function, so a status seen twice cannot fire effects twice. Multi-effect flows record the transition durably, then enqueue effects that retry individually.

**Tech Stack:** TypeScript (strict, ESM), Node 24, Express 5, Vitest, `googleapis` (Sheets, ADC), `pdfkit`, Zod.

**Spec:** `docs/superpowers/specs/2026-09-15-stage-1-design.md`

## Global Constraints

- **TypeScript strict mode, ESM.** All relative imports carry the `.js` extension.
- **`core/` is pure.** No I/O, no `Date.now()`, no config reads. Clocks and config are parameters.
- **No network in the test suite.** Every adapter has an interface; tests use fakes.
- **TDD.** Failing test first, verified failing, then minimal implementation.
- **Money is INR.** Rupee amounts round to 2 decimals via `round2`; the slab threshold is `2500` and compares against the **GST-inclusive per-piece price** (spec §5.1).
- **Seller state code is `19`** (West Bengal). Same state → CGST+SGST at half rate each; different → IGST at full rate.
- **Invoice series is gapless.** Allocation, render, and rollback all happen inside one mutex.
- **The hub must never write ledger columns R–V.** The ledger writer has a hardcoded column ceiling of `Q`.
- **Sheets `valueInputOption`** is `RAW` everywhere except ledger columns W–Y, which are `USER_ENTERED`.
- Commit after every task. Conventional commit prefixes (`feat:`, `refactor:`, `test:`).

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `src/core/placeOfSupply.ts` | province code → state code; intra vs inter-state |
| `src/core/gst.ts` | slab rate, inclusive→taxable, shipping apportionment, reconciliation |
| `src/core/invoiceNumber.ts` | Indian FY derivation, series formatting |
| `src/core/shipmentState.ts` | fulfillment state machine |
| `src/core/ledgerRow.ts` | order → ledger values + formula strings |
| `src/core/b2cs.ts` | invoice records → statewise rate-wise rollup |
| `src/core/amountInWords.ts` | Indian-format rupees in words, for the invoice |
| `src/core/mutex.ts` | promise-chain mutex |
| `src/adapters/invoicePdf.ts` | `InvoiceRenderer` + `PdfKitRenderer` |
| `src/adapters/shadowfax.ts` | `ShipmentTracker` + `ShadowfaxClient`, status mapping |
| `src/services/effects.ts` | durable effect queue, retry with backoff |
| `src/services/shipmentSync.ts` | the single convergence point |
| `src/services/invoicing.ts` | allocate → render → upload → send → register |
| `src/services/delivery.ts` | DELIVERED effects |
| `src/services/rto.ts` | RTO_INITIATED and RTO_RETURNED effects |
| `src/services/cancellation.ts` | review queue → cancel + restock + message |
| `src/services/rating.ts` | day-3 sweep, reply handling |
| `src/services/reporting.ts` | B2CS tab + CSV |
| `src/routes/shadowfax.ts` | `POST /webhook/shadowfax` |
| `src/routes/internal.ts` | the four scheduler endpoints |

**Modified:** `src/adapters/sheets.ts` (interface), `src/adapters/googleSheetStore.ts`, `src/adapters/shopifyAdmin.ts`, `src/adapters/whatsapp.ts`, `src/config.ts`, `src/services/orderIntake.ts`, `src/services/confirmation.ts`, `src/services/payment.ts`, `src/routes/shopify.ts`, `src/routes/meta.ts`, `src/views/dashboard.ts`, `src/server.ts`, `test/fakes/inMemorySheetStore.ts`, `test/fakes/stubClients.ts`, `docs/templates.md`, `.env.example`, `deploy.sh`.

---

## Task 1: Column-scoped Sheet writes

The whole-row `updateOrder` is the one piece of existing code that would silently destroy operator data once the ledger exists. It goes first, before anything can depend on it.

**Files:**
- Modify: `src/adapters/sheets.ts`
- Modify: `src/adapters/googleSheetStore.ts`
- Modify: `src/services/confirmation.ts`, `src/services/payment.ts` (call sites)
- Modify: `test/fakes/inMemorySheetStore.ts`
- Test: `test/adapters/googleSheetStore.test.ts`

**Interfaces:**
- Produces:
  - `SheetsApi.appendValues(sheetId, range, values): Promise<{ updatedRange: string }>` — **signature change**, now returns the range so a caller can learn the row number it landed on
  - `SheetsApi.batchUpdateValues(sheetId, data: Array<{ range: string; values: unknown[][]; raw?: boolean }>): Promise<void>`
  - `SheetStore.updateOrderFields(orderNo: string, patch: Partial<OrderRow>): Promise<void>`
  - `SheetStore.updateOrder` — **deleted**

- [ ] **Step 1: Write the failing test**

In `test/adapters/googleSheetStore.test.ts`:

```ts
it('writes only the columns named in the patch', async () => {
  const writes: Array<{ range: string; values: unknown[][] }> = [];
  const api: SheetsApi = {
    async getValues() {
      return [
        [...ORDER_HEADERS],
        ['#1042', '99', 'Aarav', '919876543210', 1899, 50, 1849,
         'TRUE', 'PENDING', '', '2026-09-01T00:00:00.000Z', '', ''],
      ];
    },
    async appendValues() { return { updatedRange: 'orders!A2:S2' }; },
    async updateValues() { throw new Error('updateValues must not be used'); },
    async batchUpdateValues(_id, data) { writes.push(...data.map((d) => ({ range: d.range, values: d.values }))); },
  };
  const store = new GoogleSheetStore(api, 'sheet-1');

  await store.updateOrderFields('#1042', { confirmStatus: 'CONFIRMED', confirmedAt: '2026-09-02T00:00:00.000Z' });

  expect(writes).toEqual([
    { range: 'orders!I2:I2', values: [['CONFIRMED']] },
    { range: 'orders!L2:L2', values: [['2026-09-02T00:00:00.000Z']] },
  ]);
});

it('has no method capable of writing a whole order row', () => {
  expect((GoogleSheetStore.prototype as Record<string, unknown>).updateOrder).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adapters/googleSheetStore.test.ts -t 'only the columns'`
Expected: FAIL — `store.updateOrderFields is not a function`.

- [ ] **Step 3: Add the column map and the new methods**

In `src/adapters/sheets.ts`, add below `ORDER_HEADERS`:

```ts
/** Field → column letter. The single source of truth for where each field lives. */
export const ORDER_COLUMNS: Record<keyof OrderRow, string> = {
  orderNo: 'A', orderId: 'B', customerName: 'C', phone: 'D',
  amount: 'E', codFee: 'F', payable: 'G', isCod: 'H',
  confirmStatus: 'I', paymentLink: 'J', createdAt: 'K',
  confirmedAt: 'L', paidAt: 'M',
};
```

Replace `updateOrder` in the `SheetStore` interface with:

```ts
  /** Writes ONLY the columns named in `patch`. There is deliberately no whole-row write. */
  updateOrderFields(orderNo: string, patch: Partial<OrderRow>): Promise<void>;
```

In `src/adapters/googleSheetStore.ts`, extend `SheetsApi`:

```ts
export interface SheetsApi {
  getValues(sheetId: string, range: string): Promise<unknown[][]>;
  appendValues(sheetId: string, range: string, values: unknown[][]): Promise<{ updatedRange: string }>;
  updateValues(sheetId: string, range: string, values: unknown[][]): Promise<void>;
  batchUpdateValues(
    sheetId: string,
    data: Array<{ range: string; values: unknown[][]; raw?: boolean }>,
  ): Promise<void>;
}
```

Replace `GoogleSheetStore.updateOrder` with:

```ts
  async updateOrderFields(orderNo: string, patch: Partial<OrderRow>): Promise<void> {
    const entry = (await this.orderRowsWithIndex()).find((e) => e.row.orderNo === orderNo);
    if (!entry) return;

    const data = (Object.keys(patch) as Array<keyof OrderRow>)
      .filter((field) => patch[field] !== undefined)
      .map((field) => {
        const col = ORDER_COLUMNS[field];
        const raw = patch[field];
        const value = typeof raw === 'boolean' ? (raw ? 'TRUE' : 'FALSE') : raw;
        return {
          range: `orders!${col}${entry.sheetRow}:${col}${entry.sheetRow}`,
          values: [[value as string | number]],
        };
      });

    if (data.length > 0) await this.batchWrite(data);
  }

  private async batchWrite(data: Array<{ range: string; values: unknown[][]; raw?: boolean }>) {
    await this.api.batchUpdateValues(this.sheetId, data);
  }
```

Delete `orderRowToValues`' use in updates (it is still used by `appendOrder`).

In `createSheetsApi`, make `appendValues` return the range and add the batch method:

```ts
    async appendValues(sheetId, range, values) {
      const res = await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: values as unknown[][] },
      });
      return { updatedRange: res.data.updates?.updatedRange ?? '' };
    },
    async batchUpdateValues(sheetId, data) {
      // Split by valueInputOption: formulas must be USER_ENTERED, everything else RAW.
      const groups: Array<['RAW' | 'USER_ENTERED', typeof data]> = [
        ['RAW', data.filter((d) => d.raw !== false)],
        ['USER_ENTERED', data.filter((d) => d.raw === false)],
      ];
      for (const [valueInputOption, group] of groups) {
        if (group.length === 0) continue;
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetId,
          requestBody: {
            valueInputOption,
            data: group.map((d) => ({ range: d.range, values: d.values as unknown[][] })),
          },
        });
      }
    },
```

> `raw: false` means "this is a formula". It reads oddly, but inverting it would make `RAW` the opt-in and every existing caller would have to change.

- [ ] **Step 4: Update the fake and the call sites**

In `test/fakes/inMemorySheetStore.ts`, rename `updateOrder` → `updateOrderFields` (body is unchanged — the fake is a plain object merge either way).

In `src/services/confirmation.ts` and `src/services/payment.ts`, rename every `store.updateOrder(` call to `store.updateOrderFields(`.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS. The typecheck is what proves no call site was missed.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/sheets.ts src/adapters/googleSheetStore.ts src/services/confirmation.ts src/services/payment.ts test/
git commit -m "refactor: replace whole-row order writes with column-scoped ones"
```

---

## Task 2: Stage 1 configuration

**Files:**
- Modify: `src/config.ts`, `.env.example`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `Config` extended with `shadowfaxBaseUrl`, `shadowfaxApiKey`, `shadowfaxWebhookSecret`, `sellerLegalName`, `sellerAddress`, `sellerGstin`, `sellerStateCode`, `defaultHsn`, `gstSlabThresholdInr`, `gstRateLow`, `gstRateHigh`, `invoiceSeriesPrefix`, `platformFeePct`, `corporateTaxPct`, `payEarlyEnabled`, `ratingDelayDays`, `judgemeReviewUrl`, `internalTaskToken` — all `string | number | boolean` as named.

- [ ] **Step 1: Write the failing test**

```ts
it('loads Stage 1 business rules with defaults', () => {
  const cfg = loadConfig({ ...baseEnv, SELLER_GSTIN: '19AAAAA0000A1Z5' });
  expect(cfg.gstSlabThresholdInr).toBe(2500);
  expect(cfg.gstRateLow).toBe(5);
  expect(cfg.gstRateHigh).toBe(18);
  expect(cfg.sellerStateCode).toBe('19');
  expect(cfg.platformFeePct).toBe(5);
  expect(cfg.ratingDelayDays).toBe(3);
  expect(cfg.payEarlyEnabled).toBe(false);
});

it('rejects a GSTIN of the wrong length', () => {
  expect(() => loadConfig({ ...baseEnv, SELLER_GSTIN: 'nope' })).toThrow(/SELLER_GSTIN/);
});
```

`baseEnv` is the existing fixture in this file; extend it with the new required vars (`SELLER_LEGAL_NAME`, `SELLER_ADDRESS`, `SELLER_GSTIN`, `DEFAULT_HSN`, `SHADOWFAX_BASE_URL`, `SHADOWFAX_API_KEY`, `SHADOWFAX_WEBHOOK_SECRET`, `INTERNAL_TASK_TOKEN`, `JUDGEME_REVIEW_URL`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts -v`
Expected: FAIL — `cfg.gstSlabThresholdInr` is `undefined`.

- [ ] **Step 3: Extend the schema**

In `src/config.ts`, add to the Zod object:

```ts
  SHADOWFAX_BASE_URL: z.string().url(),
  SHADOWFAX_API_KEY: z.string().min(1),
  SHADOWFAX_WEBHOOK_SECRET: z.string().min(1),
  SELLER_LEGAL_NAME: z.string().min(1),
  SELLER_ADDRESS: z.string().min(1),
  SELLER_GSTIN: z.string().length(15),
  SELLER_STATE_CODE: z.string().length(2).default('19'),
  DEFAULT_HSN: z.string().min(4),
  GST_SLAB_THRESHOLD_INR: z.coerce.number().positive().default(2500),
  GST_RATE_LOW: z.coerce.number().nonnegative().default(5),
  GST_RATE_HIGH: z.coerce.number().nonnegative().default(18),
  INVOICE_SERIES_PREFIX: z.string().min(1).default('UM'),
  PLATFORM_FEE_PCT: z.coerce.number().nonnegative().default(5),
  CORPORATE_TAX_PCT: z.coerce.number().nonnegative().default(25),
  PAY_EARLY_ENABLED: z.enum(['true', 'false']).default('false'),
  RATING_DELAY_DAYS: z.coerce.number().int().positive().default(3),
  JUDGEME_REVIEW_URL: z.string().url(),
  INTERNAL_TASK_TOKEN: z.string().min(16),
```

Add the matching `Config` fields and map them in the return, with
`payEarlyEnabled: e.PAY_EARLY_ENABLED === 'true'`.

Also relax the Cashfree vars to `.optional()` with a `.default('')` — pay-early is off by default now and the hub must boot without Cashfree keys.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Mirror everything into `.env.example`** with the defaults shown above and blank values for the secrets.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts .env.example test/config.test.ts
git commit -m "feat: add Stage 1 configuration"
```

---

## Task 3: Extend the orders tab to A:T

**Files:**
- Modify: `src/adapters/sheets.ts`, `src/adapters/googleSheetStore.ts`
- Modify: `src/services/orderIntake.ts`
- Test: `test/adapters/googleSheetStore.test.ts`, `test/services/orderIntake.test.ts`

**Interfaces:**
- Consumes: `ORDER_COLUMNS` (Task 1)
- Produces: `OrderRow` extended with
  `fulfillmentStatus: FulfillmentStatus`, `awb: string`, `cancelStatus: 'NONE'|'REVIEW_PENDING'|'CANCELLED'`, `cancelReason: string`, `invoiceNo: string`, `rating: string`, `gstDiscrepancy: number`

- [ ] **Step 1: Write the failing test**

```ts
it('round-trips the Stage 1 order columns', () => {
  const row: OrderRow = { ...baseOrderRow, fulfillmentStatus: 'SHIPPED', awb: 'SF123',
    cancelStatus: 'REVIEW_PENDING', cancelReason: 'CUSTOMER_REQUEST', invoiceNo: 'UM/26-27/0007',
    rating: '4-5', gstDiscrepancy: 0 };
  expect(valuesToOrderRow(orderRowToValues(row))).toEqual(row);
});

it('maps every OrderRow field to a distinct column', () => {
  const cols = Object.values(ORDER_COLUMNS);
  expect(new Set(cols).size).toBe(cols.length);
  expect(cols.length).toBe(ORDER_HEADERS.length);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adapters/googleSheetStore.test.ts`
Expected: FAIL — object mismatch, the new keys are dropped.

- [ ] **Step 3: Implement**

Append to `ORDER_HEADERS`: `'fulfillment_status', 'awb', 'cancel_status', 'cancel_reason', 'invoice_no', 'rating', 'gst_discrepancy'`.

Add to `ORDER_COLUMNS`: `fulfillmentStatus: 'N', awb: 'O', cancelStatus: 'P', cancelReason: 'Q', invoiceNo: 'R', rating: 'S', gstDiscrepancy: 'T'`.

Extend `orderRowToValues` (append the seven values in that order) and `valuesToOrderRow`:

```ts
    fulfillmentStatus: (str(values[13]) || 'NEW') as OrderRow['fulfillmentStatus'],
    awb: str(values[14]),
    cancelStatus: (str(values[15]) || 'NONE') as OrderRow['cancelStatus'],
    cancelReason: str(values[16]),
    invoiceNo: str(values[17]),
    rating: str(values[18]),
    gstDiscrepancy: num(values[19]),
```

Change `ORDERS_RANGE` to `'orders!A:T'` and the update range in `updateOrderFields` accordingly.

In `orderIntake.ts`, add the seven new fields to the constructed row:
`fulfillmentStatus: 'NEW', awb: '', cancelStatus: 'NONE', cancelReason: '', invoiceNo: '', rating: '', gstDiscrepancy: 0`.

> `gstDiscrepancy` holds the gap between the GST the hub computes from the slab rule
> and what Shopify actually charged (spec §5.4). Task 9 fills it; Task 23 surfaces
> any non-zero value on the dashboard.

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ test/
git commit -m "feat: extend orders tab with fulfillment, cancellation and invoice columns"
```

---

## Task 4: `core/placeOfSupply.ts`

**Files:**
- Create: `src/core/placeOfSupply.ts`
- Test: `test/core/placeOfSupply.test.ts`

**Interfaces:**
- Produces:
  - `stateCodeFor(provinceCode: string | null | undefined): string | null`
  - `isInterState(posCode: string, sellerStateCode: string): boolean`
  - `STATE_CODES: Record<string, string>` — ISO province code → 2-digit GST state code

- [ ] **Step 1: Write the failing test**

```ts
import { stateCodeFor, isInterState, STATE_CODES } from '../../src/core/placeOfSupply.js';

describe('stateCodeFor', () => {
  it('maps West Bengal to 19', () => expect(stateCodeFor('WB')).toBe('19'));
  it('maps Maharashtra to 27', () => expect(stateCodeFor('MH')).toBe('27'));
  it('maps Delhi to 07', () => expect(stateCodeFor('DL')).toBe('07'));
  it('is case-insensitive', () => expect(stateCodeFor('wb')).toBe('19'));
  it('returns null for an unknown code', () => expect(stateCodeFor('XX')).toBeNull());
  it('returns null for missing input', () => {
    expect(stateCodeFor(null)).toBeNull();
    expect(stateCodeFor(undefined)).toBeNull();
    expect(stateCodeFor('')).toBeNull();
  });
  it('covers all 36 states and union territories', () => {
    expect(Object.keys(STATE_CODES)).toHaveLength(36);
    expect(new Set(Object.values(STATE_CODES)).size).toBe(36);
  });
});

describe('isInterState', () => {
  it('is false within the seller state', () => expect(isInterState('19', '19')).toBe(false));
  it('is true outside it', () => expect(isInterState('27', '19')).toBe(true));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/placeOfSupply.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * ISO 3166-2:IN subdivision code → GST state code. Shopify sends the ISO code in
 * `shipping_address.province_code`, which is far more reliable than the free-text
 * `province` field.
 */
export const STATE_CODES: Record<string, string> = {
  JK: '01', HP: '02', PB: '03', CH: '04', UT: '05', HR: '06', DL: '07',
  RJ: '08', UP: '09', BR: '10', SK: '11', AR: '12', NL: '13', MN: '14',
  MZ: '15', TR: '16', ML: '17', AS: '18', WB: '19', JH: '20', OR: '21',
  CT: '22', MP: '23', GJ: '24', DH: '26', MH: '27', KA: '29', GA: '30',
  LD: '31', KL: '32', TN: '33', TG: '36', AN: '35', PY: '34', AP: '37',
  LA: '38',
};

export function stateCodeFor(provinceCode: string | null | undefined): string | null {
  if (!provinceCode) return null;
  return STATE_CODES[provinceCode.trim().toUpperCase()] ?? null;
}

export function isInterState(posCode: string, sellerStateCode: string): boolean {
  return posCode !== sellerStateCode;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/core/placeOfSupply.test.ts`
Expected: PASS. If the 36-entry assertion fails, the map is wrong — fix the map, not the test.

- [ ] **Step 5: Commit**

```bash
git add src/core/placeOfSupply.ts test/core/placeOfSupply.test.ts
git commit -m "feat: add place-of-supply state code mapping"
```

---

## Task 5: `core/gst.ts`

The heart of the invoice. Pure, and the most thoroughly tested module in the codebase.

**Files:**
- Create: `src/core/gst.ts`
- Test: `test/core/gst.test.ts`

**Interfaces:**
- Consumes: `isInterState` (Task 4)
- Produces:

```ts
export interface GstRates { thresholdInr: number; low: number; high: number; }
export interface GstLine { inclUnitPrice: number; quantity: number; }
export interface TaxPart { rate: number; taxable: number; tax: number; }
export interface GstBreakdown {
  goods: TaxPart[];
  shipping: TaxPart[];
  taxableTotal: number;
  taxTotal: number;
  roundOff: number;
  total: number;
}
export interface TaxSplit { cgst: number; sgst: number; igst: number; }

export function round2(value: number): number;
export function rateFor(inclUnitPrice: number, rates: GstRates): number;
export function computeGst(
  lines: GstLine[], shippingIncl: number, amountCharged: number, rates: GstRates,
): GstBreakdown;
export function splitTax(tax: number, interState: boolean): TaxSplit;
```

- [ ] **Step 1: Write the failing test**

```ts
const RATES = { thresholdInr: 2500, low: 5, high: 18 };

describe('rateFor — threshold is on the INCLUSIVE per-piece price (spec §5.1)', () => {
  it('is 5% just below the threshold', () => expect(rateFor(2499, RATES)).toBe(5));
  it('is 5% exactly at the threshold', () => expect(rateFor(2500, RATES)).toBe(5));
  it('is 18% just above it', () => expect(rateFor(2501, RATES)).toBe(18));
  it('is 18% inside the strict reading\'s dead zone', () => expect(rateFor(2700, RATES)).toBe(18));
});

describe('computeGst', () => {
  it('backs tax out of an inclusive single-rate order', () => {
    const b = computeGst([{ inclUnitPrice: 1899, quantity: 1 }], 0, 1899, RATES);
    expect(b.goods).toEqual([{ rate: 5, taxable: 1808.57, tax: 90.43 }]);
    expect(b.total).toBe(1899);
  });

  it('apportions shipping pro-rata across mixed rates', () => {
    // 5% goods taxable ~952.38, 18% goods taxable ~2542.37 → shipping splits 27.3% / 72.7%
    const b = computeGst(
      [{ inclUnitPrice: 1000, quantity: 1 }, { inclUnitPrice: 3000, quantity: 1 }],
      100, 4100, RATES,
    );
    expect(b.shipping.map((p) => p.rate)).toEqual([5, 18]);
    const shippingIncl = b.shipping.reduce((s, p) => s + p.taxable + p.tax, 0);
    expect(round2(shippingIncl)).toBe(100);
  });

  it('forces the total to equal the amount charged, exactly', () => {
    const b = computeGst(
      [{ inclUnitPrice: 333, quantity: 3 }, { inclUnitPrice: 777, quantity: 1 }],
      49, 1825, RATES,
    );
    expect(b.total).toBe(1825);
    expect(round2(b.taxableTotal + b.taxTotal + b.roundOff)).toBe(1825);
    expect(Math.abs(b.roundOff)).toBeLessThan(1);
  });

  it('handles zero shipping', () => {
    const b = computeGst([{ inclUnitPrice: 500, quantity: 1 }], 0, 500, RATES);
    expect(b.shipping).toEqual([]);
  });

  it('handles a zero-value order without dividing by zero', () => {
    const b = computeGst([], 0, 0, RATES);
    expect(b).toMatchObject({ goods: [], shipping: [], taxableTotal: 0, taxTotal: 0, total: 0 });
  });

  it('multiplies quantity by the unit price but rates on the unit price', () => {
    const b = computeGst([{ inclUnitPrice: 2000, quantity: 3 }], 0, 6000, RATES);
    expect(b.goods[0]!.rate).toBe(5); // 2000 per piece, not 6000
  });
});

describe('splitTax', () => {
  it('halves into CGST and SGST within the state', () => {
    expect(splitTax(90.43, false)).toEqual({ cgst: 45.22, sgst: 45.21, igst: 0 });
  });
  it('puts the whole amount in IGST across states', () => {
    expect(splitTax(90.43, true)).toEqual({ cgst: 0, sgst: 0, igst: 90.43 });
  });
});
```

> The CGST/SGST halving of an odd paisa must not lose or invent a paisa — hence
> `45.22 + 45.21`, not `45.22 + 45.22`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/gst.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function rateFor(inclUnitPrice: number, rates: GstRates): number {
  return inclUnitPrice <= rates.thresholdInr ? rates.low : rates.high;
}

function backOutTax(incl: number, rate: number): TaxPart {
  const taxable = round2(incl / (1 + rate / 100));
  return { rate, taxable, tax: round2(incl - taxable) };
}

export function computeGst(
  lines: GstLine[], shippingIncl: number, amountCharged: number, rates: GstRates,
): GstBreakdown {
  // Group by rate first so an order with three 5% items produces one 5% part.
  const inclByRate = new Map<number, number>();
  for (const line of lines) {
    const rate = rateFor(line.inclUnitPrice, rates);
    inclByRate.set(rate, (inclByRate.get(rate) ?? 0) + line.inclUnitPrice * line.quantity);
  }

  const goods = [...inclByRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, incl]) => backOutTax(incl, rate));

  // Shipping is a composite supply: it takes the principal supply's rate, and a
  // mixed-rate order apportions it pro-rata by taxable value.
  const goodsTaxable = goods.reduce((sum, p) => sum + p.taxable, 0);
  let shipping: TaxPart[] = [];
  if (shippingIncl > 0 && goods.length > 0) {
    let allocated = 0;
    shipping = goods.map((part, i) => {
      const isLast = i === goods.length - 1;
      // The last slice absorbs the rounding remainder so the parts sum to the charge.
      const slice = isLast
        ? round2(shippingIncl - allocated)
        : round2((shippingIncl * part.taxable) / goodsTaxable);
      allocated = round2(allocated + slice);
      return backOutTax(slice, part.rate);
    });
  }

  const parts = [...goods, ...shipping];
  const taxableTotal = round2(parts.reduce((s, p) => s + p.taxable, 0));
  const taxTotal = round2(parts.reduce((s, p) => s + p.tax, 0));

  // Per-line rounding guarantees drift. The round-off line makes the invoice total
  // equal the amount charged exactly — a ₹0.01 gap is a real reconciliation problem.
  const roundOff = round2(amountCharged - taxableTotal - taxTotal);

  return { goods, shipping, taxableTotal, taxTotal, roundOff, total: round2(amountCharged) };
}

export function splitTax(tax: number, interState: boolean): TaxSplit {
  if (interState) return { cgst: 0, sgst: 0, igst: round2(tax) };
  const cgst = round2(tax / 2);
  // The remainder, not a second rounding — halving an odd paisa must not lose it.
  return { cgst, sgst: round2(tax - cgst), igst: 0 };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/core/gst.test.ts -v`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/core/gst.ts test/core/gst.test.ts
git commit -m "feat: add GST computation with shipping apportionment and reconciliation"
```

---

## Task 6: `core/invoiceNumber.ts` and `core/mutex.ts`

**Files:**
- Create: `src/core/invoiceNumber.ts`, `src/core/mutex.ts`
- Test: `test/core/invoiceNumber.test.ts`, `test/core/mutex.test.ts`

**Interfaces:**
- Produces:
  - `financialYear(date: Date): string` — `'26-27'`
  - `formatInvoiceNumber(prefix: string, fy: string, seq: number): string`
  - `parseSequence(invoiceNo: string): number`
  - `class Mutex { run<T>(fn: () => Promise<T>): Promise<T> }`

- [ ] **Step 1: Write the failing tests**

```ts
// invoiceNumber.test.ts — boundaries are in IST; India has no DST.
describe('financialYear', () => {
  it('is 26-27 in September 2026', () => expect(financialYear(new Date('2026-09-15T12:00:00Z'))).toBe('26-27'));
  it('is 25-26 on 31 March 2026 IST', () => expect(financialYear(new Date('2026-03-31T18:00:00Z'))).toBe('25-26'));
  it('is 26-27 on 1 April 2026 IST', () => expect(financialYear(new Date('2026-03-31T18:31:00Z'))).toBe('26-27'));
});

describe('formatInvoiceNumber', () => {
  it('zero-pads to four digits', () => expect(formatInvoiceNumber('UM', '26-27', 7)).toBe('UM/26-27/0007'));
  it('does not truncate past four digits', () => expect(formatInvoiceNumber('UM', '26-27', 12345)).toBe('UM/26-27/12345'));
});

describe('parseSequence', () => {
  it('reads the sequence back', () => expect(parseSequence('UM/26-27/0007')).toBe(7));
  it('returns 0 for a malformed number', () => expect(parseSequence('garbage')).toBe(0));
});

// mutex.test.ts
it('serialises overlapping runs', async () => {
  const mutex = new Mutex();
  const order: string[] = [];
  const slow = mutex.run(async () => { order.push('a-start'); await new Promise((r) => setTimeout(r, 20)); order.push('a-end'); });
  const fast = mutex.run(async () => { order.push('b-start'); order.push('b-end'); });
  await Promise.all([slow, fast]);
  expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
});

it('releases the lock when the body throws', async () => {
  const mutex = new Mutex();
  await expect(mutex.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  await expect(mutex.run(async () => 'ok')).resolves.toBe('ok');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/core/invoiceNumber.test.ts test/core/mutex.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/core/invoiceNumber.ts`:

```ts
const IST_OFFSET_MINUTES = 330;

/** Indian financial year (April–March) for a moment in time, as `YY-YY`. */
export function financialYear(date: Date): string {
  const ist = new Date(date.getTime() + IST_OFFSET_MINUTES * 60_000);
  const year = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? year : year - 1;
  const pad = (y: number) => String(y % 100).padStart(2, '0');
  return `${pad(start)}-${pad(start + 1)}`;
}

export function formatInvoiceNumber(prefix: string, fy: string, seq: number): string {
  return `${prefix}/${fy}/${String(seq).padStart(4, '0')}`;
}

export function parseSequence(invoiceNo: string): number {
  const tail = invoiceNo.split('/').at(-1) ?? '';
  const parsed = Number.parseInt(tail, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
```

`src/core/mutex.ts`:

```ts
/**
 * Serialises async work in one process. Sufficient for invoice numbering because
 * the service runs with --max-instances=1; see spec §5.6.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/core/invoiceNumber.test.ts test/core/mutex.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/invoiceNumber.ts src/core/mutex.ts test/core/
git commit -m "feat: add invoice numbering and an in-process mutex"
```

---

## Task 7: `core/shipmentState.ts`

**Files:**
- Create: `src/core/shipmentState.ts`
- Test: `test/core/shipmentState.test.ts`

**Interfaces:**
- Produces:
  - `type FulfillmentStatus = 'NEW' | 'SHIPPED' | 'OFD' | 'DELIVERED' | 'RTO_INITIATED' | 'RTO_RETURNED'`
  - `canTransition(from: FulfillmentStatus, to: FulfillmentStatus): boolean`
  - `isTerminal(status: FulfillmentStatus): boolean`
  - `ALL_STATUSES: readonly FulfillmentStatus[]`

- [ ] **Step 1: Write the failing test**

```ts
const LEGAL: Array<[FulfillmentStatus, FulfillmentStatus]> = [
  ['NEW', 'SHIPPED'], ['SHIPPED', 'OFD'], ['SHIPPED', 'DELIVERED'],
  ['SHIPPED', 'RTO_INITIATED'], ['OFD', 'DELIVERED'], ['OFD', 'RTO_INITIATED'],
  ['RTO_INITIATED', 'RTO_RETURNED'],
];

it('allows every legal transition', () => {
  for (const [from, to] of LEGAL) expect(canTransition(from, to)).toBe(true);
});

it('rejects every transition that is not legal', () => {
  const legal = new Set(LEGAL.map(([f, t]) => `${f}->${t}`));
  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      if (legal.has(`${from}->${to}`)) continue;
      expect(canTransition(from, to)).toBe(false);
    }
  }
});

it('never allows a terminal status to advance', () => {
  for (const to of ALL_STATUSES) {
    expect(canTransition('DELIVERED', to)).toBe(false);
    expect(canTransition('RTO_RETURNED', to)).toBe(false);
  }
});

it('rejects a repeat of the current status', () => {
  expect(canTransition('SHIPPED', 'SHIPPED')).toBe(false);
});

it('marks only DELIVERED and RTO_RETURNED terminal', () => {
  expect(ALL_STATUSES.filter(isTerminal)).toEqual(['DELIVERED', 'RTO_RETURNED']);
});
```

> The exhaustive rejection loop is the important one. Every guard this code provides
> comes from transitions being refused, so testing only the happy path tests nothing.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/shipmentState.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
export type FulfillmentStatus =
  | 'NEW' | 'SHIPPED' | 'OFD' | 'DELIVERED' | 'RTO_INITIATED' | 'RTO_RETURNED';

export const ALL_STATUSES = [
  'NEW', 'SHIPPED', 'OFD', 'DELIVERED', 'RTO_INITIATED', 'RTO_RETURNED',
] as const satisfies readonly FulfillmentStatus[];

const ALLOWED: Record<FulfillmentStatus, readonly FulfillmentStatus[]> = {
  NEW: ['SHIPPED'],
  SHIPPED: ['OFD', 'DELIVERED', 'RTO_INITIATED'],
  OFD: ['DELIVERED', 'RTO_INITIATED'],
  DELIVERED: [],
  RTO_INITIATED: ['RTO_RETURNED'],
  RTO_RETURNED: [],
};

export function canTransition(from: FulfillmentStatus, to: FulfillmentStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function isTerminal(status: FulfillmentStatus): boolean {
  return ALLOWED[status].length === 0;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/core/shipmentState.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/shipmentState.ts test/core/shipmentState.test.ts
git commit -m "feat: add the fulfillment state machine"
```

---

## Task 8: New sheet tabs in the store

**Files:**
- Modify: `src/adapters/sheets.ts`, `src/adapters/googleSheetStore.ts`, `test/fakes/inMemorySheetStore.ts`
- Test: `test/adapters/googleSheetStore.test.ts`

**Interfaces:**
- Consumes: `FulfillmentStatus` (Task 7), `batchUpdateValues` (Task 1)
- Produces:

```ts
export interface ShipmentRow {
  orderNo: string; awb: string; courier: string; status: FulfillmentStatus;
  shippedAt: string; ofdAt: string; deliveredAt: string;
  rtoInitiatedAt: string; rtoReturnedAt: string; lastSyncedAt: string; rawStatus: string;
}
/**
 * One row per (invoice, GST rate). A mixed-rate order produces two rows sharing an
 * invoice number — collapsing them into a single `gstRate` would roll the whole
 * invoice up at one rate in B2CS, which is exactly the number the GST portal checks.
 * Shipping tax is folded into the row for the rate it was apportioned to.
 * `invoiceTotal` and `roundOff` are invoice-level and repeat across a shared number.
 */
export interface InvoiceRow {
  invoiceNo: string; orderNo: string; invoiceDate: string; placeOfSupply: string; hsn: string;
  gstRate: number; taxableValue: number; cgst: number; sgst: number; igst: number;
  roundOff: number; invoiceTotal: number; mediaId: string; status: 'ISSUED' | 'VOID';
}
export interface EffectRow {
  effectId: string; orderNo: string; kind: string; payloadJson: string;
  attempts: number; state: 'PENDING' | 'DONE' | 'FAILED';
  lastError: string; createdAt: string; nextAttemptAt: string;
}

// added to SheetStore:
upsertShipment(row: ShipmentRow): Promise<void>;
findShipmentByAwb(awb: string): Promise<ShipmentRow | null>;
listOpenShipments(): Promise<ShipmentRow[]>;          // non-terminal only
appendInvoiceLines(rows: InvoiceRow[]): Promise<void>;   // all rows share one invoice number
listInvoices(): Promise<InvoiceRow[]>;
lastInvoiceSequence(fy: string): Promise<number>;
voidInvoice(invoiceNo: string): Promise<void>;           // marks every row of that number VOID
appendEffect(row: EffectRow): Promise<void>;
listDueEffects(nowIso: string): Promise<EffectRow[]>;
updateEffect(effectId: string, patch: Partial<EffectRow>): Promise<void>;
```

- [ ] **Step 1: Write the failing test**

```ts
it('upserts a shipment by AWB rather than appending a duplicate', async () => {
  const store = new InMemorySheetStore();
  await store.upsertShipment({ ...baseShipment, awb: 'SF1', status: 'SHIPPED' });
  await store.upsertShipment({ ...baseShipment, awb: 'SF1', status: 'OFD' });
  expect(store.shipments).toHaveLength(1);
  expect((await store.findShipmentByAwb('SF1'))?.status).toBe('OFD');
});

it('lists only non-terminal shipments as open', async () => {
  const store = new InMemorySheetStore();
  await store.upsertShipment({ ...baseShipment, awb: 'A', status: 'SHIPPED' });
  await store.upsertShipment({ ...baseShipment, awb: 'B', status: 'DELIVERED' });
  await store.upsertShipment({ ...baseShipment, awb: 'C', status: 'RTO_RETURNED' });
  expect((await store.listOpenShipments()).map((s) => s.awb)).toEqual(['A']);
});

it('returns the last invoice sequence for a financial year, ignoring other years', async () => {
  const store = new InMemorySheetStore();
  await store.appendInvoiceLines([{ ...baseInvoice, invoiceNo: 'UM/25-26/0009' }]);
  await store.appendInvoiceLines([{ ...baseInvoice, invoiceNo: 'UM/26-27/0003' }]);
  expect(await store.lastInvoiceSequence('26-27')).toBe(3);
  expect(await store.lastInvoiceSequence('27-28')).toBe(0);
});

it('counts a VOID invoice as consuming its sequence', async () => {
  const store = new InMemorySheetStore();
  await store.appendInvoiceLines([{ ...baseInvoice, invoiceNo: 'UM/26-27/0004', status: 'VOID' }]);
  expect(await store.lastInvoiceSequence('26-27')).toBe(4);
});

it('stores one row per rate for a mixed-rate invoice, not one per invoice', async () => {
  const store = new InMemorySheetStore();
  await store.appendInvoiceLines([
    { ...baseInvoice, invoiceNo: 'UM/26-27/0005', gstRate: 5, taxableValue: 952.38 },
    { ...baseInvoice, invoiceNo: 'UM/26-27/0005', gstRate: 18, taxableValue: 2542.37 },
  ]);
  expect(await store.listInvoices()).toHaveLength(2);
  expect(await store.lastInvoiceSequence('26-27')).toBe(5);   // one number, not two
});

it('returns only effects whose next attempt is due', async () => {
  const store = new InMemorySheetStore();
  await store.appendEffect({ ...baseEffect, effectId: 'e1', nextAttemptAt: '2026-09-15T10:00:00.000Z' });
  await store.appendEffect({ ...baseEffect, effectId: 'e2', nextAttemptAt: '2026-09-15T12:00:00.000Z' });
  await store.appendEffect({ ...baseEffect, effectId: 'e3', state: 'DONE', nextAttemptAt: '2026-09-15T10:00:00.000Z' });
  expect((await store.listDueEffects('2026-09-15T11:00:00.000Z')).map((e) => e.effectId)).toEqual(['e1']);
});
```

Put `baseShipment`, `baseInvoice`, `baseEffect` in `test/fixtures/stage1.ts` as fully-populated objects.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adapters/googleSheetStore.test.ts`
Expected: FAIL — `store.upsertShipment is not a function`.

- [ ] **Step 3: Implement**

Add the row interfaces, `SHIPMENT_HEADERS`, `INVOICE_HEADERS`, `EFFECT_HEADERS`, and matching `*_COLUMNS` maps to `src/adapters/sheets.ts`, following the shape established for orders in Task 1.

Add the methods to `GoogleSheetStore`, reusing the `orderRowsWithIndex` pattern — read the range, slice off the header, pair each row with its sheet row number, then write back only the columns that changed. `lastInvoiceSequence` filters on the FY segment of `invoice_no` and takes the max of `parseSequence`, **including `VOID` rows** (a voided number is consumed, never reissued).

Implement the same methods on `InMemorySheetStore` with plain arrays.

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/ test/
git commit -m "feat: add shipments, invoices and effects tabs to the sheet store"
```

---

## Task 9: `core/ledgerRow.ts` and the ledger tab

**Files:**
- Create: `src/core/ledgerRow.ts`
- Modify: `src/adapters/sheets.ts`, `src/adapters/googleSheetStore.ts`, `test/fakes/inMemorySheetStore.ts`
- Modify: `src/services/orderIntake.ts`
- Test: `test/core/ledgerRow.test.ts`, `test/services/orderIntake.test.ts`

**Interfaces:**
- Consumes: `appendValues` returning `updatedRange` (Task 1)
- Produces:

```ts
export interface LedgerOrderFields {
  orderNo: string; orderDate: string; pincode: string; state: string; posCode: string;
  skus: string; itemAmount: number; shippingCharged: number; grossAmount: number; isCod: boolean;
}
export interface LedgerOutcomeFields {
  taxableValue: number; gstRate: number; gstOnGoods: number; gstOnShipping: number;
  outcome: 'DELIVERED' | 'RTO' | 'CANCELLED'; collectedAmount: number; platformFee: number;
}
export function ledgerOrderValues(f: LedgerOrderFields): (string | number)[];   // A–J
export function ledgerFormulas(sheetRow: number, corporateTaxPct: number): string[]; // W–Y

// added to SheetStore:
appendLedgerOrder(fields: LedgerOrderFields, corporateTaxPct: number): Promise<void>;
updateLedgerOutcome(orderNo: string, fields: LedgerOutcomeFields): Promise<void>;
listLedger(): Promise<Record<string, unknown>[]>;
```

- [ ] **Step 1: Write the failing test**

```ts
it('builds the A–J order block in column order', () => {
  expect(ledgerOrderValues({
    orderNo: '#1042', orderDate: '2026-09-15', pincode: '700001', state: 'West Bengal',
    posCode: '19', skus: 'TEE-BLK-L x2', itemAmount: 1800, shippingCharged: 99,
    grossAmount: 1899, isCod: true,
  })).toEqual(['#1042', '2026-09-15', '700001', 'West Bengal', '19', 'TEE-BLK-L x2', 1800, 99, 1899, 'TRUE']);
});

it('builds W–Y formulas against the given sheet row', () => {
  expect(ledgerFormulas(5, 25)).toEqual([
    '=P5-M5-N5-R5-U5',
    '=W5-T5-S5-Q5',
    '=X5*(1-0.25)',
  ]);
});

it('never emits a formula referencing a column past Y', () => {
  const refs = ledgerFormulas(2, 25).join(' ').match(/[A-Z]+(?=\d)/g) ?? [];
  for (const ref of refs) expect(ref <= 'Y').toBe(true);
});
```

And in `test/services/orderIntake.test.ts`:

```ts
it('writes a ledger row at order intake', async () => {
  const store = new InMemorySheetStore();
  await makeIntake(store).handle(codOrderPayload);
  expect(store.ledger).toHaveLength(1);
  expect(store.ledger[0]).toMatchObject({ orderNo: '#1042', posCode: '19' });
});

it('leaves the operator block untouched at intake', async () => {
  const store = new InMemorySheetStore();
  await makeIntake(store).handle(codOrderPayload);
  expect(store.ledger[0]).not.toHaveProperty('cogs');
  expect(store.ledger[0]).not.toHaveProperty('rtoLoss');
});

it('records no discrepancy when Shopify agrees with the slab rule', async () => {
  const store = new InMemorySheetStore();
  // ₹1899 inclusive at 5% → ₹90.43 GST; the payload's tax_lines say the same.
  await makeIntake(store).handle({ ...codOrderPayload, tax_lines: [{ price: '90.43' }] });
  expect((await store.findOrderByNo('#1042'))?.gstDiscrepancy).toBe(0);
});

it('records the gap when Shopify charged a different rate', async () => {
  const store = new InMemorySheetStore();
  await makeIntake(store).handle({ ...codOrderPayload, tax_lines: [{ price: '289.68' }] }); // 18%
  expect((await store.findOrderByNo('#1042'))?.gstDiscrepancy).toBe(199.25);
});

it('treats a gap under ₹1 as agreement, since per-line rounding always drifts', async () => {
  const store = new InMemorySheetStore();
  await makeIntake(store).handle({ ...codOrderPayload, tax_lines: [{ price: '90.90' }] });
  expect((await store.findOrderByNo('#1042'))?.gstDiscrepancy).toBe(0);
});

it('records no discrepancy when the payload carries no tax_lines at all', async () => {
  const store = new InMemorySheetStore();
  await makeIntake(store).handle({ ...codOrderPayload, tax_lines: undefined });
  expect((await store.findOrderByNo('#1042'))?.gstDiscrepancy).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/core/ledgerRow.test.ts test/services/orderIntake.test.ts`
Expected: FAIL — module not found; `store.ledger` undefined.

- [ ] **Step 3: Implement**

`src/core/ledgerRow.ts`:

```ts
/**
 * Ledger columns. A–Q are the hub's. R–V belong to the operator and the hub has no
 * method that can address them. W–Y are formulas so that filling COGS by hand on
 * day three updates EBITDA and PAT without the hub ever revisiting the row.
 */
export const LEDGER_HEADERS = [
  'order_no', 'order_date', 'pincode', 'state', 'pos_code', 'skus',
  'item_amount', 'shipping_charged', 'gross_amount', 'is_cod',        // A–J
  'taxable_value', 'gst_rate', 'gst_on_goods', 'gst_on_shipping',
  'outcome', 'collected_amount', 'platform_fee_5pct',                 // K–Q
  'cod_charges', 'shipping_cost', 'cogs', 'rto_loss', 'notes',        // R–V — OPERATOR
  'net_revenue', 'ebitda', 'pat',                                     // W–Y — formulas
] as const;

/** The hub must never write past this column. */
export const LEDGER_HUB_CEILING = 'Q';

export function ledgerOrderValues(f: LedgerOrderFields): (string | number)[] {
  return [
    f.orderNo, f.orderDate, f.pincode, f.state, f.posCode, f.skus,
    f.itemAmount, f.shippingCharged, f.grossAmount, f.isCod ? 'TRUE' : 'FALSE',
  ];
}

export function ledgerOutcomeValues(f: LedgerOutcomeFields): (string | number)[] {
  return [
    f.taxableValue, f.gstRate, f.gstOnGoods, f.gstOnShipping,
    f.outcome, f.collectedAmount, f.platformFee,
  ];
}

export function ledgerFormulas(sheetRow: number, corporateTaxPct: number): string[] {
  const r = sheetRow;
  return [
    `=P${r}-M${r}-N${r}-R${r}-U${r}`,        // net_revenue
    `=W${r}-T${r}-S${r}-Q${r}`,              // ebitda
    `=X${r}*(1-${corporateTaxPct / 100})`,   // pat
  ];
}
```

In `GoogleSheetStore`:

```ts
  async appendLedgerOrder(fields: LedgerOrderFields, corporateTaxPct: number): Promise<void> {
    const { updatedRange } = await this.api.appendValues(
      this.sheetId, 'ledger!A:J', [ledgerOrderValues(fields)],
    );
    const sheetRow = Number.parseInt(updatedRange.match(/!\D+(\d+)/)?.[1] ?? '0', 10);
    if (sheetRow === 0) return;
    await this.api.batchUpdateValues(this.sheetId, [
      { range: `ledger!W${sheetRow}:Y${sheetRow}`, values: [ledgerFormulas(sheetRow, corporateTaxPct)], raw: false },
    ]);
  }

  async updateLedgerOutcome(orderNo: string, fields: LedgerOutcomeFields): Promise<void> {
    const sheetRow = await this.ledgerRowFor(orderNo);
    if (sheetRow === null) return;
    // K–Q only. The ceiling is why this is a hardcoded range, not a computed one.
    await this.api.batchUpdateValues(this.sheetId, [
      { range: `ledger!K${sheetRow}:${LEDGER_HUB_CEILING}${sheetRow}`, values: [ledgerOutcomeValues(fields)] },
    ]);
  }
```

`ledgerRowFor` reads `ledger!A:A` and finds the 1-indexed row whose value equals `orderNo`.

In `orderIntake.ts`, after `store.appendOrder(row)`, add the ledger write. `parseShopifyOrder` must also now return `pincode`, `provinceCode`, `provinceName`, `shippingCharged`, `itemAmount`, `lines` and `shopifyTaxTotal` — extend `ParsedOrder` and the parser to read `shipping_address.zip`, `shipping_address.province_code`, `shipping_address.province`, `total_shipping_price_set.shop_money.amount`, `subtotal_price`, per-line `price`/`quantity`, and:

```ts
  const shopifyTaxTotal = round2(
    (Array.isArray(raw.tax_lines) ? raw.tax_lines : [])
      .reduce((sum, line) => sum + Number(line?.price ?? 0), 0),
  );
```

Then add the §5.4 cross-check to `OrderIntakeService.handle`, right after the ledger write:

```ts
const GST_TOLERANCE_INR = 1;

// The operator chose the slab rule over Shopify's tax_lines, so the invoice will
// always follow the slab rule. This check exists so a misconfigured Shopify tax
// setting surfaces as a visible flag instead of an invoice that silently disagrees
// with what the customer was charged. See spec §5.4.
const breakdown = computeGst(parsed.lines, parsed.shippingCharged, parsed.amount, rates);
const gap = round2(Math.abs(breakdown.taxTotal - parsed.shopifyTaxTotal));
const discrepancy = parsed.shopifyTaxTotal > 0 && gap >= GST_TOLERANCE_INR ? gap : 0;

if (discrepancy > 0) {
  log('warn', 'computed GST disagrees with Shopify tax_lines', {
    order_no: parsed.orderNo, computed: breakdown.taxTotal, shopify: parsed.shopifyTaxTotal,
  });
  await store.updateOrderFields(parsed.orderNo, { gstDiscrepancy: discrepancy });
}
```

`OrderIntakeDeps` gains `rates: GstRates` and `corporateTaxPct: number`; wire both from config in `src/server.ts`.

> The `shopifyTaxTotal > 0` guard matters: a store with tax collection switched off sends
> no `tax_lines`, and flagging every single order in that case would make the signal
> useless rather than informative.

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ test/
git commit -m "feat: write a ledger row with live formulas at order intake"
```

---

## Task 10: Shopify Admin write operations

**Files:**
- Modify: `src/adapters/shopifyAdmin.ts`
- Test: `test/adapters/shopifyAdmin.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ShopifyWriter extends OrderTagger {
  cancelOrder(orderId: string, opts: { reason: 'OTHER' | 'CUSTOMER'; note: string; restock: boolean }): Promise<void>;
  markAsPaid(orderId: string): Promise<void>;
  adjustInventory(items: Array<{ inventoryItemId: string; locationId: string; delta: number }>): Promise<void>;
  getOrderLineItems(orderId: string): Promise<Array<{ inventoryItemId: string; quantity: number }>>;
}
```

- [ ] **Step 1: Write the failing test**

```ts
it('cancels with the RTO note and no restock', async () => {
  let body: any;
  const client = new ShopifyAdminClient({ storeDomain: 'x.myshopify.com', adminToken: 't',
    fetchImpl: async (_url, init) => { body = JSON.parse(String((init as RequestInit).body)); return okJson({ data: { orderCancel: { userErrors: [] } } }); } });

  await client.cancelOrder('99', { reason: 'OTHER', restock: false,
    note: 'user cancel, user did not take delivery or cancel the delivery' });

  expect(body.variables).toMatchObject({
    orderId: 'gid://shopify/Order/99', reason: 'OTHER', restock: false,
    staffNote: 'user cancel, user did not take delivery or cancel the delivery',
  });
});

it('throws on a userErrors response even though HTTP was 200', async () => {
  const client = new ShopifyAdminClient({ storeDomain: 'x', adminToken: 't',
    fetchImpl: async () => okJson({ data: { orderCancel: { userErrors: [{ message: 'already cancelled' }] } } }) });
  await expect(client.cancelOrder('99', { reason: 'OTHER', note: 'n', restock: false }))
    .rejects.toThrow(/already cancelled/);
});

it('sends one inventory delta per item', async () => {
  let body: any;
  const client = new ShopifyAdminClient({ storeDomain: 'x', adminToken: 't',
    fetchImpl: async (_u, init) => { body = JSON.parse(String((init as RequestInit).body)); return okJson({ data: { inventoryAdjustQuantities: { userErrors: [] } } }); } });

  await client.adjustInventory([
    { inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/9', delta: 2 },
  ]);

  expect(body.variables.input.changes).toEqual([
    { inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/9', delta: 2 },
  ]);
});
```

`okJson` is a small helper returning `new Response(JSON.stringify(v), { status: 200 })`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adapters/shopifyAdmin.test.ts`
Expected: FAIL — `client.cancelOrder is not a function`.

- [ ] **Step 3: Implement**

Extract the existing error-checking into a reusable private `graphql(query, variables, mutationName)` method, then add:

```ts
const ORDER_CANCEL = `
  mutation cancelOrder($orderId: ID!, $reason: OrderCancelReason!, $restock: Boolean!,
                       $refund: Boolean!, $staffNote: String) {
    orderCancel(orderId: $orderId, reason: $reason, restock: $restock,
                refund: $refund, staffNote: $staffNote) {
      userErrors { field message }
    }
  }
`;

const ORDER_MARK_AS_PAID = `
  mutation markPaid($input: OrderMarkAsPaidInput!) {
    orderMarkAsPaid(input: $input) { userErrors { field message } }
  }
`;

const INVENTORY_ADJUST = `
  mutation adjust($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) { userErrors { field message } }
  }
`;
```

`cancelOrder` passes `refund: false` — refunds are a money decision and stay manual.
`adjustInventory` sends `name: 'available'` and `reason: 'restock'` in the input.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/adapters/shopifyAdmin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/shopifyAdmin.ts test/adapters/shopifyAdmin.test.ts
git commit -m "feat: add Shopify cancel, mark-as-paid and inventory adjustment"
```

---

## Task 11: WhatsApp media, document and text sends

**Files:**
- Modify: `src/adapters/whatsapp.ts`, `test/fakes/stubClients.ts`
- Test: `test/adapters/whatsapp.test.ts`

**Interfaces:**
- Produces, added to `WhatsAppClient`:

```ts
uploadMedia(input: { bytes: Buffer; filename: string; mimeType: string }): Promise<{ mediaId: string }>;
sendDocument(input: { to: string; mediaId: string; filename: string; caption?: string }): Promise<{ wamid: string }>;
sendText(input: { to: string; body: string }): Promise<{ wamid: string }>;
```

`SendTemplateInput` also gains `documentHeaderMediaId?: string` and `imageHeaderMediaId?: string`.

- [ ] **Step 1: Write the failing test**

```ts
it('uploads media as multipart and returns the id', async () => {
  let captured: RequestInit | undefined;
  const client = new GraphWhatsAppClient({ accessToken: 't', phoneNumberId: '1',
    fetchImpl: async (_u, init) => { captured = init as RequestInit; return okJson({ id: 'media-42' }); } });

  const { mediaId } = await client.uploadMedia({ bytes: Buffer.from('%PDF-1.4'), filename: 'inv.pdf', mimeType: 'application/pdf' });

  expect(mediaId).toBe('media-42');
  expect(captured?.body).toBeInstanceOf(FormData);
});

it('attaches a document header to a template', async () => {
  let body: any;
  const client = new GraphWhatsAppClient({ accessToken: 't', phoneNumberId: '1',
    fetchImpl: async (_u, init) => { body = JSON.parse(String((init as RequestInit).body)); return okJson({ messages: [{ id: 'wamid.1' }] }); } });

  await client.sendTemplate({ to: '919876543210', template: 'order_delivered_invoice',
    languageCode: 'en', bodyParams: ['Aarav', '#1042'], documentHeaderMediaId: 'media-42' });

  expect(body.template.components[0]).toEqual({
    type: 'header',
    parameters: [{ type: 'document', document: { id: 'media-42', filename: 'invoice.pdf' } }],
  });
});

it('throws when the upload response carries no id', async () => {
  const client = new GraphWhatsAppClient({ accessToken: 't', phoneNumberId: '1',
    fetchImpl: async () => okJson({}) });
  await expect(client.uploadMedia({ bytes: Buffer.alloc(1), filename: 'a.pdf', mimeType: 'application/pdf' }))
    .rejects.toThrow(/no media id/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adapters/whatsapp.test.ts`
Expected: FAIL — `client.uploadMedia is not a function`.

- [ ] **Step 3: Implement**

`uploadMedia` POSTs `FormData` (`messaging_product=whatsapp`, `type`, `file` as a `Blob`) to
`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/media` and reads `id` from the response.

In `sendTemplate`, **unshift** the header component before the body — Graph requires header first:

```ts
    if (input.documentHeaderMediaId) {
      components.unshift({
        type: 'header',
        parameters: [{ type: 'document', document: { id: input.documentHeaderMediaId, filename: 'invoice.pdf' } }],
      } as unknown as Component);
    }
```

Widen the `Component.parameters` type to accept document and image parameter shapes rather than casting at each site.

`sendText` posts `{ messaging_product, to, type: 'text', text: { body } }` — used only inside an open 24h service window, where it is free.

Extend the stub in `test/fakes/stubClients.ts` with recording implementations of all three.

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/whatsapp.ts test/
git commit -m "feat: add WhatsApp media upload, document and text sends"
```

---

## Task 12: Invoice PDF rendering

**Files:**
- Create: `src/core/amountInWords.ts`, `src/adapters/invoicePdf.ts`
- Test: `test/core/amountInWords.test.ts`, `test/adapters/invoicePdf.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `GstBreakdown`, `TaxSplit` (Task 5)
- Produces:

```ts
export function rupeesInWords(amount: number): string;

export interface InvoiceData {
  invoiceNo: string; invoiceDate: string;
  seller: { legalName: string; address: string; gstin: string };
  buyer: { name: string; address: string };
  placeOfSupply: string; hsn: string;
  lines: Array<{ description: string; quantity: number; taxable: number; rate: number; tax: number }>;
  shippingTaxable: number; shippingTax: number;
  split: TaxSplit; roundOff: number; total: number;
}
export interface InvoiceRenderer { render(data: InvoiceData): Promise<Buffer>; }
export class PdfKitRenderer implements InvoiceRenderer { /* ... */ }
```

- [ ] **Step 1: Install pdfkit**

Run: `npm install pdfkit && npm install -D @types/pdfkit`

- [ ] **Step 2: Write the failing tests**

```ts
// amountInWords.test.ts — Indian numbering, not Western.
it('writes lakhs and crores, not millions', () => {
  expect(rupeesInWords(125000)).toBe('One Lakh Twenty Five Thousand Rupees Only');
  expect(rupeesInWords(10000000)).toBe('One Crore Rupees Only');
});
it('includes paise when present', () => {
  expect(rupeesInWords(1899.5)).toBe('One Thousand Eight Hundred Ninety Nine Rupees and Fifty Paise Only');
});
it('handles zero', () => expect(rupeesInWords(0)).toBe('Zero Rupees Only'));

// invoicePdf.test.ts
it('produces a PDF containing every legally required field', async () => {
  const bytes = await new PdfKitRenderer().render(sampleInvoiceData);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  const text = bytes.toString('latin1');
  for (const needed of ['UM/26-27/0007', '19AAAAA0000A1Z5', 'Place of Supply', 'HSN', 'CGST', 'SGST', 'no signature required']) {
    expect(text).toContain(needed);
  }
});

it('shows IGST instead of CGST/SGST for an inter-state buyer', async () => {
  const bytes = await new PdfKitRenderer().render({ ...sampleInvoiceData, split: { cgst: 0, sgst: 0, igst: 90.43 } });
  const text = bytes.toString('latin1');
  expect(text).toContain('IGST');
  expect(text).not.toContain('CGST');
});
```

> Asserting on `latin1` text works because pdfkit writes uncompressed text operators
> by default. If a future pdfkit enables compression, pass `{ compress: false }`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/core/amountInWords.test.ts test/adapters/invoicePdf.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

`rupeesInWords` splits rupees and paise, then renders rupees with the Indian grouping
(crore / lakh / thousand / hundred / tens-units) using a units table for 0–19 and a tens
table for 20–90.

`PdfKitRenderer.render` creates `new PDFDocument({ size: 'A4', margin: 40, compress: false })`,
collects `data` events into chunks, resolves the concatenated `Buffer` on `end`, and draws:
the seller block, "TAX INVOICE" title, invoice number and date, buyer block, place of supply,
a line-item table (description, HSN, qty, taxable, rate, tax), the shipping line, the tax split
(CGST+SGST **or** IGST, never both), round-off, total in figures, total in words, and the
"Computer generated invoice, no signature required" footer.

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/core/amountInWords.test.ts test/adapters/invoicePdf.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/core/amountInWords.ts src/adapters/invoicePdf.ts test/
git commit -m "feat: render GST tax invoices as PDFs"
```

---

## Task 13: The effect queue

**Files:**
- Create: `src/services/effects.ts`
- Test: `test/services/effects.test.ts`

**Interfaces:**
- Consumes: `EffectRow`, `appendEffect`, `listDueEffects`, `updateEffect` (Task 8)
- Produces:

```ts
export type EffectHandler = (payload: unknown) => Promise<void>;
export interface EffectServiceDeps {
  store: SheetStore;
  handlers: Record<string, EffectHandler>;
  maxAttempts?: number;   // default 5
  now?: () => Date;
}
export class EffectService {
  enqueue(orderNo: string, kind: string, payload: unknown): Promise<void>;
  drain(): Promise<{ done: number; retried: number; failed: number }>;
}
```

- [ ] **Step 1: Write the failing test**

```ts
it('marks an effect DONE when its handler succeeds', async () => {
  const store = new InMemorySheetStore();
  const svc = new EffectService({ store, handlers: { tag: async () => {} }, now: () => new Date('2026-09-15T10:00:00Z') });
  await svc.enqueue('#1042', 'tag', { tag: 'rto' });
  expect(await svc.drain()).toEqual({ done: 1, retried: 0, failed: 0 });
  expect(store.effects[0]!.state).toBe('DONE');
});

it('backs off exponentially on failure and keeps the error', async () => {
  const store = new InMemorySheetStore();
  const svc = new EffectService({ store, handlers: { tag: async () => { throw new Error('shopify down'); } },
    now: () => new Date('2026-09-15T10:00:00Z') });
  await svc.enqueue('#1042', 'tag', {});
  expect(await svc.drain()).toEqual({ done: 0, retried: 1, failed: 0 });

  const row = store.effects[0]!;
  expect(row.state).toBe('PENDING');
  expect(row.attempts).toBe(1);
  expect(row.lastError).toContain('shopify down');
  expect(row.nextAttemptAt).toBe('2026-09-15T10:01:00.000Z'); // 60s * 2^0
});

it('gives up after maxAttempts and marks FAILED', async () => {
  const store = new InMemorySheetStore();
  await store.appendEffect({ ...baseEffect, kind: 'tag', attempts: 4, nextAttemptAt: '2026-01-01T00:00:00.000Z' });
  const svc = new EffectService({ store, handlers: { tag: async () => { throw new Error('nope'); } },
    maxAttempts: 5, now: () => new Date('2026-09-15T10:00:00Z') });
  expect(await svc.drain()).toEqual({ done: 0, retried: 0, failed: 1 });
  expect(store.effects[0]!.state).toBe('FAILED');
});

it('fails an effect whose kind has no handler rather than retrying forever', async () => {
  const store = new InMemorySheetStore();
  const svc = new EffectService({ store, handlers: {}, now: () => new Date('2026-09-15T10:00:00Z') });
  await svc.enqueue('#1042', 'mystery', {});
  expect(await svc.drain()).toEqual({ done: 0, retried: 0, failed: 1 });
});

it('keeps draining after one effect throws', async () => {
  const store = new InMemorySheetStore();
  const svc = new EffectService({ store, handlers: { bad: async () => { throw new Error('x'); }, good: async () => {} },
    now: () => new Date('2026-09-15T10:00:00Z') });
  await svc.enqueue('#1', 'bad', {});
  await svc.enqueue('#2', 'good', {});
  expect(await svc.drain()).toEqual({ done: 1, retried: 1, failed: 0 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/services/effects.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
const BASE_BACKOFF_MS = 60_000;

export class EffectService {
  private readonly now: () => Date;
  private readonly maxAttempts: number;

  constructor(private readonly deps: EffectServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.maxAttempts = deps.maxAttempts ?? 5;
  }

  async enqueue(orderNo: string, kind: string, payload: unknown): Promise<void> {
    const iso = this.now().toISOString();
    await this.deps.store.appendEffect({
      effectId: `${orderNo}:${kind}:${iso}`,
      orderNo, kind, payloadJson: JSON.stringify(payload),
      attempts: 0, state: 'PENDING', lastError: '', createdAt: iso, nextAttemptAt: iso,
    });
  }

  async drain(): Promise<{ done: number; retried: number; failed: number }> {
    const due = await this.deps.store.listDueEffects(this.now().toISOString());
    let done = 0, retried = 0, failed = 0;

    for (const effect of due) {
      const handler = this.deps.handlers[effect.kind];
      if (!handler) {
        // An unknown kind will never succeed, so retrying it just burns attempts.
        await this.deps.store.updateEffect(effect.effectId, {
          state: 'FAILED', lastError: `no handler for kind=${effect.kind}`,
        });
        failed += 1;
        continue;
      }

      try {
        await handler(JSON.parse(effect.payloadJson));
        await this.deps.store.updateEffect(effect.effectId, { state: 'DONE', lastError: '' });
        done += 1;
      } catch (error) {
        const attempts = effect.attempts + 1;
        const message = error instanceof Error ? error.message : String(error);

        if (attempts >= this.maxAttempts) {
          await this.deps.store.updateEffect(effect.effectId, { attempts, state: 'FAILED', lastError: message });
          failed += 1;
        } else {
          const delay = BASE_BACKOFF_MS * 2 ** (attempts - 1);
          await this.deps.store.updateEffect(effect.effectId, {
            attempts, lastError: message,
            nextAttemptAt: new Date(this.now().getTime() + delay).toISOString(),
          });
          retried += 1;
        }
      }
    }

    return { done, retried, failed };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/services/effects.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/effects.ts test/services/effects.test.ts
git commit -m "feat: add a durable effect queue with exponential backoff"
```

---

## Task 14: Shadowfax adapter and status mapping

**Files:**
- Create: `src/adapters/shadowfax.ts`
- Test: `test/adapters/shadowfax.test.ts`

**Interfaces:**
- Consumes: `FulfillmentStatus` (Task 7)
- Produces:

```ts
export interface TrackedShipment { awb: string; status: FulfillmentStatus | null; rawStatus: string; at: string; }
export interface ShipmentTracker { fetchStatuses(awbs: string[]): Promise<TrackedShipment[]>; }
export function mapShadowfaxStatus(raw: string): FulfillmentStatus | null;
export function parseShadowfaxWebhook(payload: unknown): TrackedShipment | null;
export class ShadowfaxClient implements ShipmentTracker { /* ... */ }
```

- [ ] **Step 1: Write the failing test**

```ts
describe('mapShadowfaxStatus', () => {
  it.each([
    ['DELIVERED', 'DELIVERED'], ['delivered', 'DELIVERED'],
    ['OUT_FOR_DELIVERY', 'OFD'], ['Out for Delivery', 'OFD'],
    ['PICKED_UP', 'SHIPPED'], ['IN_TRANSIT', 'SHIPPED'],
    ['RTO_INITIATED', 'RTO_INITIATED'], ['RTO Initiated', 'RTO_INITIATED'],
    ['RTO_DELIVERED', 'RTO_RETURNED'], ['Returned to Client', 'RTO_RETURNED'],
  ])('maps %s to %s', (raw, expected) => expect(mapShadowfaxStatus(raw)).toBe(expected));

  it('returns null for an unrecognised status so the caller can flag it', () => {
    expect(mapShadowfaxStatus('TELEPORTED')).toBeNull();
  });
});

describe('parseShadowfaxWebhook', () => {
  it('extracts awb, status and timestamp', () => {
    expect(parseShadowfaxWebhook({ awb_number: 'SF123', status: 'DELIVERED', timestamp: '2026-09-15T10:00:00Z' }))
      .toEqual({ awb: 'SF123', status: 'DELIVERED', rawStatus: 'DELIVERED', at: '2026-09-15T10:00:00.000Z' });
  });

  it('preserves the raw status even when unmapped', () => {
    expect(parseShadowfaxWebhook({ awb_number: 'SF1', status: 'TELEPORTED' }))
      .toMatchObject({ status: null, rawStatus: 'TELEPORTED' });
  });

  it('returns null when there is no AWB to key on', () => {
    expect(parseShadowfaxWebhook({ status: 'DELIVERED' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adapters/shadowfax.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Shadowfax's exact status vocabulary is an open item in the spec (§10). Every
 * string we know about lives here; anything else maps to null, which the caller
 * turns into a loud warning and a dashboard flag rather than a silent no-op.
 * Add rows here as Shadowfax confirms them — no other file needs to change.
 */
const STATUS_MAP: Record<string, FulfillmentStatus> = {
  PICKED_UP: 'SHIPPED', IN_TRANSIT: 'SHIPPED', SHIPPED: 'SHIPPED', DISPATCHED: 'SHIPPED',
  OUT_FOR_DELIVERY: 'OFD', OFD: 'OFD',
  DELIVERED: 'DELIVERED',
  RTO_INITIATED: 'RTO_INITIATED', RTO: 'RTO_INITIATED', RTO_IN_TRANSIT: 'RTO_INITIATED',
  UNDELIVERED: 'RTO_INITIATED', NDR: 'RTO_INITIATED',
  RTO_DELIVERED: 'RTO_RETURNED', RETURNED_TO_CLIENT: 'RTO_RETURNED', RTO_COMPLETED: 'RTO_RETURNED',
};

function normalise(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

export function mapShadowfaxStatus(raw: string): FulfillmentStatus | null {
  return STATUS_MAP[normalise(raw)] ?? null;
}
```

`parseShadowfaxWebhook` reads `awb_number ?? awb ?? waybill`, `status ?? current_status`,
and `timestamp ?? updated_at`, defaulting the timestamp to now. It returns `null` when the
AWB is missing, because without one there is nothing to match an order against.

`ShadowfaxClient.fetchStatuses` GETs `${baseUrl}/track?awbs=<csv>` with
`Authorization: Bearer ${apiKey}`, chunking the AWB list at 50 per request, and maps each
result through `mapShadowfaxStatus`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/adapters/shadowfax.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/shadowfax.ts test/adapters/shadowfax.test.ts
git commit -m "feat: add the Shadowfax adapter and status mapping"
```

---

## Task 15: `services/shipmentSync.ts` — the convergence point

The load-bearing task. Both ingestion paths meet here, and this is what makes double-delivery safe.

**Files:**
- Create: `src/services/shipmentSync.ts`
- Test: `test/services/shipmentSync.test.ts`

**Interfaces:**
- Consumes: `canTransition`, `isTerminal` (Task 7); `SheetStore` shipment methods (Task 8); `EffectService` (Task 13); `ShipmentTracker` (Task 14)
- Produces:

```ts
export type SyncResult = 'applied' | 'ignored_illegal' | 'ignored_unknown_status' | 'no_shipment';
export interface ShipmentSyncDeps {
  store: SheetStore; effects: EffectService; tracker: ShipmentTracker; now?: () => Date;
}
export class ShipmentSyncService {
  applyShipmentStatus(awb: string, status: FulfillmentStatus | null, rawStatus: string, at: string): Promise<SyncResult>;
  syncOpenShipments(): Promise<{ checked: number; applied: number }>;
  recordFulfillment(orderNo: string, awb: string, courier: string): Promise<void>;
}
```

- [ ] **Step 1: Write the failing test**

```ts
it('applies a legal transition and enqueues its effects', async () => {
  const { svc, store } = harness();
  await svc.recordFulfillment('#1042', 'SF1', 'shadowfax');

  expect(await svc.applyShipmentStatus('SF1', 'DELIVERED', 'DELIVERED', AT)).toBe('applied');
  expect((await store.findShipmentByAwb('SF1'))?.status).toBe('DELIVERED');
  expect(store.effects.map((e) => e.kind)).toEqual(['delivered']);
});

it('fires effects exactly once when the same status arrives twice', async () => {
  const { svc, store } = harness();
  await svc.recordFulfillment('#1042', 'SF1', 'shadowfax');

  await svc.applyShipmentStatus('SF1', 'RTO_INITIATED', 'RTO_INITIATED', AT);   // webhook
  const second = await svc.applyShipmentStatus('SF1', 'RTO_INITIATED', 'RTO_INITIATED', AT); // poller

  expect(second).toBe('ignored_illegal');
  expect(store.effects.filter((e) => e.kind === 'rto_initiated')).toHaveLength(1);
});

it('never regresses a delivered shipment', async () => {
  const { svc, store } = harness();
  await svc.recordFulfillment('#1042', 'SF1', 'shadowfax');
  await svc.applyShipmentStatus('SF1', 'DELIVERED', 'DELIVERED', AT);

  expect(await svc.applyShipmentStatus('SF1', 'OFD', 'OUT_FOR_DELIVERY', AT)).toBe('ignored_illegal');
  expect((await store.findShipmentByAwb('SF1'))?.status).toBe('DELIVERED');
});

it('records an unmapped status without changing state', async () => {
  const { svc, store } = harness();
  await svc.recordFulfillment('#1042', 'SF1', 'shadowfax');

  expect(await svc.applyShipmentStatus('SF1', null, 'TELEPORTED', AT)).toBe('ignored_unknown_status');
  const row = await store.findShipmentByAwb('SF1');
  expect(row?.status).toBe('SHIPPED');
  expect(row?.rawStatus).toBe('TELEPORTED');  // preserved for diagnosis
});

it('ignores a status for an AWB it has never seen', async () => {
  const { svc } = harness();
  expect(await svc.applyShipmentStatus('UNKNOWN', 'DELIVERED', 'DELIVERED', AT)).toBe('no_shipment');
});

it('polls only non-terminal shipments', async () => {
  const { svc, store, tracker } = harness();
  await svc.recordFulfillment('#1', 'A', 'shadowfax');
  await svc.recordFulfillment('#2', 'B', 'shadowfax');
  await svc.applyShipmentStatus('B', 'DELIVERED', 'DELIVERED', AT);

  await svc.syncOpenShipments();
  expect(tracker.requestedAwbs).toEqual([['A']]);
});
```

`harness()` builds an `InMemorySheetStore`, a real `EffectService` with no-op handlers, and a
stub tracker recording the AWBs it was asked for.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/services/shipmentSync.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
const EFFECT_FOR: Partial<Record<FulfillmentStatus, string>> = {
  DELIVERED: 'delivered',
  RTO_INITIATED: 'rto_initiated',
  RTO_RETURNED: 'rto_returned',
};

export class ShipmentSyncService {
  // ...
  /**
   * The single place a fulfillment status changes. The webhook and the poller both
   * call it; neither knows what effects fire. That is what makes a status arriving
   * twice safe — the guard rejects the second one before any effect is enqueued.
   */
  async applyShipmentStatus(
    awb: string, status: FulfillmentStatus | null, rawStatus: string, at: string,
  ): Promise<SyncResult> {
    const shipment = await this.store.findShipmentByAwb(awb);
    if (!shipment) {
      log('warn', 'shipment status for unknown awb', { awb, raw_status: rawStatus });
      return 'no_shipment';
    }

    const nowIso = this.now().toISOString();

    if (status === null) {
      // Never a silent no-op: an ignored status is an order that stops moving.
      log('warn', 'unmapped shadowfax status', { awb, order_no: shipment.orderNo, raw_status: rawStatus });
      await this.store.upsertShipment({ ...shipment, rawStatus, lastSyncedAt: nowIso });
      return 'ignored_unknown_status';
    }

    if (!canTransition(shipment.status, status)) {
      log('info', 'shipment transition ignored', {
        awb, order_no: shipment.orderNo, from: shipment.status, to: status,
      });
      await this.store.upsertShipment({ ...shipment, rawStatus, lastSyncedAt: nowIso });
      return 'ignored_illegal';
    }

    const stamps: Partial<ShipmentRow> = {
      SHIPPED: { shippedAt: at }, OFD: { ofdAt: at }, DELIVERED: { deliveredAt: at },
      RTO_INITIATED: { rtoInitiatedAt: at }, RTO_RETURNED: { rtoReturnedAt: at },
      NEW: {},
    }[status];

    await this.store.upsertShipment({ ...shipment, ...stamps, status, rawStatus, lastSyncedAt: nowIso });
    await this.store.updateOrderFields(shipment.orderNo, { fulfillmentStatus: status });

    const kind = EFFECT_FOR[status];
    if (kind) await this.effects.enqueue(shipment.orderNo, kind, { orderNo: shipment.orderNo, awb, at });

    return 'applied';
  }
}
```

`syncOpenShipments` calls `listOpenShipments()`, passes their AWBs to
`tracker.fetchStatuses`, and feeds each result back through `applyShipmentStatus`.

`recordFulfillment` upserts a `SHIPPED` shipment row and writes `awb` and
`fulfillmentStatus: 'SHIPPED'` onto the order.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/services/shipmentSync.test.ts -v`
Expected: PASS — in particular the double-delivery test.

- [ ] **Step 5: Commit**

```bash
git add src/services/shipmentSync.ts test/services/shipmentSync.test.ts
git commit -m "feat: converge webhook and poller on one guarded shipment transition"
```

---

## Task 16: `services/invoicing.ts`

**Files:**
- Create: `src/services/invoicing.ts`
- Test: `test/services/invoicing.test.ts`

**Interfaces:**
- Consumes: `Mutex`, `financialYear`, `formatInvoiceNumber` (Task 6); `computeGst`, `splitTax` (Task 5); `stateCodeFor`, `isInterState` (Task 4); `InvoiceRenderer` (Task 12); invoice store methods (Task 8)
- Produces:

```ts
export interface InvoicingDeps {
  store: SheetStore; renderer: InvoiceRenderer; whatsapp: WhatsAppClient;
  seller: { legalName: string; address: string; gstin: string; stateCode: string };
  hsn: string; rates: GstRates; seriesPrefix: string; templateLang: string;
  now?: () => Date;
}
export const TEMPLATE_DELIVERED = 'order_delivered_invoice';
export class InvoicingService {
  issueForOrder(orderNo: string): Promise<{ invoiceNo: string } | null>;
}
```

- [ ] **Step 1: Write the failing test**

```ts
it('allocates the next number, renders, uploads and sends', async () => {
  const { svc, store, whatsapp } = harness();
  const result = await svc.issueForOrder('#1042');

  expect(result?.invoiceNo).toBe('UM/26-27/0001');
  expect(whatsapp.documents).toHaveLength(0);
  expect(whatsapp.templates[0]).toMatchObject({
    template: 'order_delivered_invoice', documentHeaderMediaId: 'media-1',
  });
  expect(store.invoices[0]).toMatchObject({ invoiceNo: 'UM/26-27/0001', status: 'ISSUED' });
  expect((await store.findOrderByNo('#1042'))?.invoiceNo).toBe('UM/26-27/0001');
});

it('rolls the counter back when rendering fails, so the series stays gapless', async () => {
  const { svc, store } = harness({ renderer: { render: async () => { throw new Error('pdf boom'); } } });

  await expect(svc.issueForOrder('#1042')).rejects.toThrow('pdf boom');
  expect(store.invoices).toHaveLength(0);

  const { svc: svc2, store: store2 } = harness();
  expect((await svc2.issueForOrder('#1042'))?.invoiceNo).toBe('UM/26-27/0001');
});

it('never issues two numbers concurrently', async () => {
  const { svc } = harness({ orders: ['#1', '#2', '#3'] });
  const issued = await Promise.all(['#1', '#2', '#3'].map((no) => svc.issueForOrder(no)));
  expect(issued.map((i) => i?.invoiceNo).sort()).toEqual(['UM/26-27/0001', 'UM/26-27/0002', 'UM/26-27/0003']);
});

it('splits CGST and SGST for a West Bengal buyer', async () => {
  const { svc, store } = harness({ provinceCode: 'WB' });
  await svc.issueForOrder('#1042');
  expect(store.invoices[0]).toMatchObject({ igst: 0 });
  expect(store.invoices[0]!.cgst).toBeGreaterThan(0);
});

it('uses IGST for a Maharashtra buyer', async () => {
  const { svc, store } = harness({ provinceCode: 'MH' });
  await svc.issueForOrder('#1042');
  expect(store.invoices[0]).toMatchObject({ cgst: 0, sgst: 0 });
  expect(store.invoices[0]!.igst).toBeGreaterThan(0);
});

it('is a no-op when the order already has an invoice', async () => {
  const { svc, store } = harness();
  await svc.issueForOrder('#1042');
  expect(await svc.issueForOrder('#1042')).toBeNull();
  expect(store.invoices).toHaveLength(1);
});

it('writes one register row per rate for a mixed-rate order, under one number', async () => {
  const { svc, store } = harness({ lines: [
    { inclUnitPrice: 1000, quantity: 1 },   // 5%
    { inclUnitPrice: 3000, quantity: 1 },   // 18%
  ] });
  await svc.issueForOrder('#1042');

  expect(store.invoices.map((i) => i.gstRate)).toEqual([5, 18]);
  expect(new Set(store.invoices.map((i) => i.invoiceNo)).size).toBe(1);
  expect(store.invoices.every((i) => i.invoiceTotal === store.invoices[0]!.invoiceTotal)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/services/invoicing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
export class InvoicingService {
  private readonly mutex = new Mutex();

  async issueForOrder(orderNo: string): Promise<{ invoiceNo: string } | null> {
    const order = await this.deps.store.findOrderByNo(orderNo);
    if (!order) return null;
    if (order.invoiceNo) return null;  // already invoiced; effect retries land here

    /*
     * Allocation, render and rollback all happen inside the mutex. GST requires a
     * gapless series, so a failed render must return the number to the pool before
     * any other caller can allocate. See spec §5.6.
     */
    return this.mutex.run(async () => {
      const issuedAt = this.now();
      const fy = financialYear(issuedAt);
      const seq = (await this.deps.store.lastInvoiceSequence(fy)) + 1;
      const invoiceNo = formatInvoiceNumber(this.deps.seriesPrefix, fy, seq);

      const { data, breakdown } = this.buildInvoiceData(order, invoiceNo, issuedAt);

      // Nothing is persisted until the render succeeds, so a throw here consumes
      // no sequence number at all — the next call allocates the same one.
      const bytes = await this.deps.renderer.render(data);
      const { mediaId } = await this.deps.whatsapp.uploadMedia({
        bytes, filename: `${invoiceNo.replace(/\//g, '-')}.pdf`, mimeType: 'application/pdf',
      });

      // One register row per rate. Shipping folds into the row for the rate it was
      // apportioned to, so the rate-wise taxable values here are exactly what B2CS needs.
      const interState = isInterState(data.placeOfSupply, this.deps.seller.stateCode);
      const byRate = new Map<number, { taxable: number; tax: number }>();
      for (const part of [...breakdown.goods, ...breakdown.shipping]) {
        const bucket = byRate.get(part.rate) ?? { taxable: 0, tax: 0 };
        byRate.set(part.rate, {
          taxable: round2(bucket.taxable + part.taxable),
          tax: round2(bucket.tax + part.tax),
        });
      }

      await this.deps.store.appendInvoiceLines(
        [...byRate.entries()].sort((a, b) => a[0] - b[0]).map(([rate, sums]) => {
          const split = splitTax(sums.tax, interState);
          return {
            invoiceNo, orderNo, invoiceDate: issuedAt.toISOString(),
            placeOfSupply: data.placeOfSupply, hsn: this.deps.hsn,
            gstRate: rate, taxableValue: sums.taxable,
            cgst: split.cgst, sgst: split.sgst, igst: split.igst,
            roundOff: breakdown.roundOff, invoiceTotal: breakdown.total,
            mediaId, status: 'ISSUED' as const,
          };
        }),
      );
      await this.deps.store.updateOrderFields(orderNo, { invoiceNo });

      const { wamid } = await this.deps.whatsapp.sendTemplate({
        to: order.phone, template: TEMPLATE_DELIVERED, languageCode: this.deps.templateLang,
        bodyParams: [order.customerName, order.orderNo], documentHeaderMediaId: mediaId,
      });
      await this.deps.store.appendMessage({
        orderNo, template: TEMPLATE_DELIVERED, wamid, direction: 'out',
        status: 'sent', timestamp: issuedAt.toISOString(),
      });

      return { invoiceNo };
    });
  }
}
```

`buildInvoiceData(order, invoiceNo, issuedAt)` returns `{ data: InvoiceData; breakdown: GstBreakdown }`.
It reads the ledger row for line amounts and the order's province code, derives the place of
supply via `stateCodeFor` (falling back to the seller state and logging a warning if the code
is unrecognised), calls `computeGst`, and calls `splitTax(breakdown.taxTotal, interState)` for
the document's invoice-level tax split.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/services/invoicing.test.ts -v`
Expected: PASS — especially the rollback and concurrency cases.

- [ ] **Step 5: Commit**

```bash
git add src/services/invoicing.ts test/services/invoicing.test.ts
git commit -m "feat: issue GST invoices with a gapless series"
```

---

## Task 17: `services/delivery.ts`

**Files:**
- Create: `src/services/delivery.ts`
- Test: `test/services/delivery.test.ts`

**Interfaces:**
- Consumes: `ShopifyWriter` (Task 10), `InvoicingService` (Task 16), ledger methods (Task 9)
- Produces: `class DeliveryService { onDelivered(orderNo: string): Promise<void> }`

- [ ] **Step 1: Write the failing test**

```ts
it('marks a COD order paid in Shopify', async () => {
  const { svc, shopify } = harness({ isCod: true });
  await svc.onDelivered('#1042');
  expect(shopify.markedPaid).toEqual(['99']);
});

it('does not mark a prepaid order paid', async () => {
  const { svc, shopify } = harness({ isCod: false });
  await svc.onDelivered('#1042');
  expect(shopify.markedPaid).toEqual([]);
});

it('writes the DELIVERED ledger outcome with the platform fee on the collected amount', async () => {
  const { svc, store } = harness({ isCod: true, amount: 1899 });
  await svc.onDelivered('#1042');
  expect(store.ledger[0]).toMatchObject({ outcome: 'DELIVERED', collectedAmount: 1899, platformFee: 94.95 });
});

it('issues the invoice', async () => {
  const { svc, invoicing } = harness();
  await svc.onDelivered('#1042');
  expect(invoicing.issued).toEqual(['#1042']);
});

it('propagates an invoicing failure so the effect retries', async () => {
  const { svc } = harness({ invoicingThrows: true });
  await expect(svc.onDelivered('#1042')).rejects.toThrow();
});

it('does not re-mark an order that is already paid', async () => {
  const { svc, shopify } = harness({ isCod: true, paidAt: '2026-09-10T00:00:00.000Z' });
  await svc.onDelivered('#1042');
  expect(shopify.markedPaid).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/services/delivery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`onDelivered` loads the order; if `isCod && !paidAt` calls `shopify.markAsPaid(order.orderId)`
and writes `paidAt`; writes the ledger outcome with
`collectedAmount = order.amount` and
`platformFee = round2(collectedAmount * platformFeePct / 100)`; then calls
`invoicing.issueForOrder(orderNo)`. Any throw propagates so the effect queue retries.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/services/delivery.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/delivery.ts test/services/delivery.test.ts
git commit -m "feat: handle delivered orders — mark COD paid, invoice, close the ledger"
```

---

## Task 18: `services/rto.ts`

**Files:**
- Create: `src/services/rto.ts`
- Test: `test/services/rto.test.ts`

**Interfaces:**
- Consumes: `ShopifyWriter` (Task 10), ledger methods (Task 9)
- Produces:

```ts
export const RTO_CANCEL_NOTE = 'user cancel, user did not take delivery or cancel the delivery';
export const TEMPLATE_CANCELLED = 'order_cancelled';
export class RtoService {
  onRtoInitiated(orderNo: string): Promise<void>;
  onRtoReturned(orderNo: string): Promise<void>;
}
```

- [ ] **Step 1: Write the failing test**

```ts
it('cancels without restocking and tags rto on initiate', async () => {
  const { svc, shopify } = harness();
  await svc.onRtoInitiated('#1042');
  expect(shopify.cancels).toEqual([{ orderId: '99', reason: 'OTHER', note: RTO_CANCEL_NOTE, restock: false }]);
  expect(shopify.tags).toEqual([{ orderId: '99', tag: 'rto' }]);
});

it('sends the cancellation message with RTO as the reason', async () => {
  const { svc, whatsapp } = harness();
  await svc.onRtoInitiated('#1042');
  expect(whatsapp.templates[0]).toMatchObject({
    template: 'order_cancelled', bodyParams: ['Aarav', '#1042', 'returned to us undelivered'],
  });
});

it('records an RTO ledger outcome with no collection and no platform fee', async () => {
  const { svc, store } = harness();
  await svc.onRtoInitiated('#1042');
  expect(store.ledger[0]).toMatchObject({ outcome: 'RTO', collectedAmount: 0, platformFee: 0 });
});

it('restocks only on return, not on initiate', async () => {
  const { svc, shopify } = harness();
  await svc.onRtoInitiated('#1042');
  expect(shopify.inventoryAdjustments).toEqual([]);

  await svc.onRtoReturned('#1042');
  expect(shopify.inventoryAdjustments).toEqual([
    [{ inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/9', delta: 2 }],
  ]);
});

it('propagates a restock failure so the effect retries independently of the cancel', async () => {
  const { svc, shopify } = harness({ adjustThrows: true });
  await svc.onRtoInitiated('#1042');            // succeeded
  await expect(svc.onRtoReturned('#1042')).rejects.toThrow();
  expect(shopify.cancels).toHaveLength(1);      // not re-run
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/services/rto.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`onRtoInitiated`: cancel (`reason: 'OTHER'`, `note: RTO_CANCEL_NOTE`, `restock: false`) →
`addTag(orderId, 'rto')` → `updateOrderFields(orderNo, { cancelStatus: 'CANCELLED', cancelReason: 'RTO', confirmStatus: 'CANCELLED' })` →
`updateLedgerOutcome(orderNo, { outcome: 'RTO', collectedAmount: 0, platformFee: 0, ... })` →
send `order_cancelled` with `bodyParams: [name, orderNo, 'returned to us undelivered']`.

`onRtoReturned`: `getOrderLineItems(orderId)` → `adjustInventory(items.map(i => ({ ...i, locationId, delta: i.quantity })))`.

> Restock is deliberately a separate method reached by a separate effect. `orderCancel`
> only restocks at cancel time, so splitting cancel-now from restock-later means a
> different API with different failure modes — and it can partially succeed across
> variants, which is why it retries on its own.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/services/rto.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/rto.ts test/services/rto.test.ts
git commit -m "feat: cancel and tag on RTO initiate, restock on return"
```

---

## Task 19: `services/cancellation.ts` — the review queue

**Files:**
- Create: `src/services/cancellation.ts`
- Modify: `src/services/confirmation.ts`
- Test: `test/services/cancellation.test.ts`, `test/services/confirmation.test.ts`

**Interfaces:**
- Produces:

```ts
export class CancellationService {
  queueForReview(orderNo: string, reason: 'CUSTOMER_REQUEST'): Promise<void>;
  listPendingReview(): Promise<OrderRow[]>;
  approve(orderNo: string): Promise<void>;
}
```

- [ ] **Step 1: Write the failing test**

```ts
it('queues without touching Shopify or messaging the customer', async () => {
  const { svc, shopify, whatsapp, store } = harness();
  await svc.queueForReview('#1042', 'CUSTOMER_REQUEST');

  expect(shopify.cancels).toEqual([]);
  expect(whatsapp.templates).toEqual([]);   // telling them, then un-cancelling, is worse than a delay
  expect((await store.findOrderByNo('#1042'))?.cancelStatus).toBe('REVIEW_PENDING');
});

it('cancels WITH restock on approval, since nothing shipped', async () => {
  const { svc, shopify } = harness();
  await svc.queueForReview('#1042', 'CUSTOMER_REQUEST');
  await svc.approve('#1042');
  expect(shopify.cancels).toEqual([{ orderId: '99', reason: 'CUSTOMER', note: 'customer cancelled', restock: true }]);
});

it('sends the cancellation message only after approval', async () => {
  const { svc, whatsapp } = harness();
  await svc.queueForReview('#1042', 'CUSTOMER_REQUEST');
  await svc.approve('#1042');
  expect(whatsapp.templates[0]).toMatchObject({ template: 'order_cancelled', bodyParams: ['Aarav', '#1042', 'cancelled at your request'] });
});

it('lists only orders awaiting review', async () => {
  const { svc, store } = harness({ extraOrders: [{ orderNo: '#2', cancelStatus: 'NONE' }] });
  await svc.queueForReview('#1042', 'CUSTOMER_REQUEST');
  expect((await svc.listPendingReview()).map((o) => o.orderNo)).toEqual(['#1042']);
});

it('is a no-op when approving an order that is not pending review', async () => {
  const { svc, shopify } = harness();
  await svc.approve('#1042');
  expect(shopify.cancels).toEqual([]);
});
```

In `test/services/confirmation.test.ts`, replace the old cancel assertion:

```ts
it('queues a cancel button reply for review rather than cancelling outright', async () => {
  const { svc, store } = confirmationHarness();
  await svc.handleButtonReply({ phone: '919876543210', buttonText: 'Cancel Order', messageId: 'wamid.1' });
  const order = await store.findOrderByNo('#1042');
  expect(order?.confirmStatus).toBe('CANCELLED');
  expect(order?.cancelStatus).toBe('REVIEW_PENDING');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/services/cancellation.test.ts test/services/confirmation.test.ts`
Expected: FAIL — module not found; `cancelStatus` still `'NONE'`.

- [ ] **Step 3: Implement**

`queueForReview` writes `confirmStatus: 'CANCELLED', cancelStatus: 'REVIEW_PENDING', cancelReason`.
`listPendingReview` filters `listOrders()` on `cancelStatus === 'REVIEW_PENDING'`.
`approve` guards on that same status, then cancels with `restock: true`, writes
`cancelStatus: 'CANCELLED'`, writes the `CANCELLED` ledger outcome, and sends
`order_cancelled` with reason text `'cancelled at your request'`.

In `confirmation.ts`, route the `Cancel Order` branch through `cancellation.queueForReview`.

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/ test/services/
git commit -m "feat: route customer cancellations through an operator review queue"
```

---

## Task 20: `services/rating.ts`

**Files:**
- Create: `src/services/rating.ts`
- Modify: `src/routes/meta.ts` (route rating button replies)
- Test: `test/services/rating.test.ts`

**Interfaces:**
- Produces:

```ts
export const TEMPLATE_RATING = 'order_rating';
export class RatingService {
  sweep(): Promise<{ sent: number }>;
  handleRatingReply(phone: string, buttonText: string): Promise<'stored' | 'no_match'>;
}
```

- [ ] **Step 1: Write the failing test**

```ts
const NOW = new Date('2026-09-15T10:00:00Z');

it('asks only orders delivered at least the configured number of days ago', async () => {
  const { svc, whatsapp } = harness({ delivered: {
    '#old': '2026-09-11T10:00:00.000Z',   // 4 days — due
    '#edge': '2026-09-12T10:00:00.000Z',  // exactly 3 days — due
    '#new': '2026-09-14T10:00:00.000Z',   // 1 day — not due
  } });
  expect(await svc.sweep()).toEqual({ sent: 2 });
  expect(whatsapp.templates.map((t) => t.bodyParams[1])).toEqual(['#old', '#edge']);
});

it('never asks the same order twice', async () => {
  const { svc } = harness({ delivered: { '#1042': '2026-09-11T10:00:00.000Z' } });
  await svc.sweep();
  expect(await svc.sweep()).toEqual({ sent: 0 });
});

it('sends the Judge.me link on a 4-5 rating, inside the free service window', async () => {
  const { svc, store, whatsapp } = harness({ delivered: { '#1042': '2026-09-11T10:00:00.000Z' } });
  await svc.sweep();

  expect(await svc.handleRatingReply('919876543210', '⭐ 4–5')).toBe('stored');
  expect((await store.findOrderByNo('#1042'))?.rating).toBe('4-5');
  expect(whatsapp.texts[0]!.body).toContain('https://judge.me/review');
});

it('apologises and does not send a review link on a 1-2 rating', async () => {
  const { svc, store, whatsapp } = harness({ delivered: { '#1042': '2026-09-11T10:00:00.000Z' } });
  await svc.sweep();

  await svc.handleRatingReply('919876543210', '⭐ 1–2');
  expect((await store.findOrderByNo('#1042'))?.rating).toBe('1-2');
  expect(whatsapp.texts[0]!.body).not.toContain('judge.me');
  expect(whatsapp.texts[0]!.body).toMatch(/sorry/i);
});

it('ignores a rating reply from an unknown phone', async () => {
  const { svc } = harness({ delivered: {} });
  expect(await svc.handleRatingReply('910000000000', '⭐ 3')).toBe('no_match');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/services/rating.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`sweep` lists orders with `fulfillmentStatus === 'DELIVERED'` and no rating request logged,
joins to `shipments` for `deliveredAt`, filters on
`now - deliveredAt >= ratingDelayDays * 86_400_000`, sends `order_rating` and logs the send.

`handleRatingReply` normalises the button text to `1-2 | 3 | 4-5` by digit extraction (so
emoji and dash variants all work), finds the most recent delivered order for the phone,
writes `rating`, then replies with `sendText` — free inside the open 24h service window
opened by the customer's own button tap.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/services/rating.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/rating.ts src/routes/meta.ts test/services/rating.test.ts
git commit -m "feat: request and record post-delivery ratings"
```

---

## Task 21: `core/b2cs.ts` and `services/reporting.ts`

**Files:**
- Create: `src/core/b2cs.ts`, `src/services/reporting.ts`
- Test: `test/core/b2cs.test.ts`, `test/services/reporting.test.ts`

**Interfaces:**
- Consumes: `InvoiceRow` (Task 8)
- Produces:

```ts
export interface B2csRow {
  placeOfSupply: string; rate: number; taxableValue: number; cess: number; invoiceCount: number;
}
export const B2CL_THRESHOLD_INR = 250_000;
export function rollupB2cs(invoices: InvoiceRow[], month: string, sellerStateCode: string):
  { rows: B2csRow[]; excluded: InvoiceRow[] };
export function toB2csCsv(rows: B2csRow[]): string;

export class ReportingService {
  generate(month: string): Promise<{ rows: B2csRow[]; excluded: InvoiceRow[]; csv: string }>;
}
```

- [ ] **Step 1: Write the failing test**

```ts
it('groups by place of supply and rate', () => {
  const { rows } = rollupB2cs([
    inv({ placeOfSupply: '19', gstRate: 5, taxableValue: 1000 }),
    inv({ placeOfSupply: '19', gstRate: 5, taxableValue: 500 }),
    inv({ placeOfSupply: '27', gstRate: 18, taxableValue: 2000 }),
  ], '2026-09', '19');

  expect(rows).toEqual([
    { placeOfSupply: '19', rate: 5, taxableValue: 1500, cess: 0, invoiceCount: 2 },
    { placeOfSupply: '27', rate: 18, taxableValue: 2000, cess: 0, invoiceCount: 1 },
  ]);
});

it('counts an invoice once even when it contributes rows at two rates', () => {
  const { rows } = rollupB2cs([
    inv({ invoiceNo: 'UM/26-27/0005', placeOfSupply: '19', gstRate: 5, taxableValue: 952.38 }),
    inv({ invoiceNo: 'UM/26-27/0005', placeOfSupply: '19', gstRate: 18, taxableValue: 2542.37 }),
  ], '2026-09', '19');

  expect(rows).toEqual([
    { placeOfSupply: '19', rate: 5, taxableValue: 952.38, cess: 0, invoiceCount: 1 },
    { placeOfSupply: '19', rate: 18, taxableValue: 2542.37, cess: 0, invoiceCount: 1 },
  ]);
});

it('excludes an inter-state invoice above the B2CL threshold and reports it', () => {
  const big = inv({ placeOfSupply: '27', gstRate: 18, taxableValue: 300_000, invoiceTotal: 354_000 });
  const { rows, excluded } = rollupB2cs([big, inv({ placeOfSupply: '27', gstRate: 18, taxableValue: 1000 })], '2026-09', '19');
  expect(excluded).toEqual([big]);
  expect(rows).toEqual([{ placeOfSupply: '27', rate: 18, taxableValue: 1000, cess: 0, invoiceCount: 1 }]);
});

it('excludes every rate row of a B2CL invoice, not just the one that tripped it', () => {
  const lines = [
    inv({ invoiceNo: 'UM/26-27/0009', placeOfSupply: '27', gstRate: 5, taxableValue: 500, invoiceTotal: 354_000 }),
    inv({ invoiceNo: 'UM/26-27/0009', placeOfSupply: '27', gstRate: 18, taxableValue: 299_500, invoiceTotal: 354_000 }),
  ];
  const { rows, excluded } = rollupB2cs(lines, '2026-09', '19');
  expect(rows).toEqual([]);
  expect(excluded).toHaveLength(2);
});

it('keeps a large INTRA-state invoice in B2CS — the threshold is inter-state only', () => {
  const big = inv({ placeOfSupply: '19', gstRate: 18, taxableValue: 300_000, invoiceTotal: 354_000 });
  const { rows, excluded } = rollupB2cs([big], '2026-09', '19');
  expect(excluded).toEqual([]);
  expect(rows[0]!.taxableValue).toBe(300_000);
});

it('ignores VOID invoices and invoices from other months', () => {
  const { rows } = rollupB2cs([
    inv({ status: 'VOID', taxableValue: 999 }),
    inv({ invoiceDate: '2026-08-04T00:00:00.000Z', taxableValue: 888 }),
    inv({ taxableValue: 100 }),
  ], '2026-09', '19');
  expect(rows).toEqual([{ placeOfSupply: '19', rate: 5, taxableValue: 100, cess: 0, invoiceCount: 1 }]);
});

it('returns no rows for a month with no invoices', () => {
  expect(rollupB2cs([], '2026-09', '19').rows).toEqual([]);
});

it('emits the GST offline tool column order', () => {
  expect(toB2csCsv([{ placeOfSupply: '27', rate: 18, taxableValue: 2000, cess: 0, invoiceCount: 1 }]).split('\n')).toEqual([
    'Type,Place Of Supply,Applicable % of Tax Rate,Rate,Taxable Value,Cess Amount,E-Commerce GSTIN',
    'OE,27,,18,2000,0,',
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/core/b2cs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
export function rollupB2cs(invoices: InvoiceRow[], month: string, sellerStateCode: string) {
  const inMonth = invoices.filter(
    (row) => row.status !== 'VOID' && row.invoiceDate.startsWith(month),
  );

  /*
   * B2CL: inter-state invoices above ₹2.5L belong in a different GSTR-1 table.
   * The decision is per INVOICE, not per rate row — a mixed-rate invoice over the
   * threshold must have all its rows excluded, or half of it would be filed in the
   * wrong table. Excluding silently would understate a return, so they come back
   * to the caller to be flagged.
   */
  const b2clNumbers = new Set(
    inMonth
      .filter((row) => row.placeOfSupply !== sellerStateCode && row.invoiceTotal > B2CL_THRESHOLD_INR)
      .map((row) => row.invoiceNo),
  );

  const excluded = inMonth.filter((row) => b2clNumbers.has(row.invoiceNo));
  const buckets = new Map<string, B2csRow & { numbers: Set<string> }>();

  for (const row of inMonth) {
    if (b2clNumbers.has(row.invoiceNo)) continue;

    const key = `${row.placeOfSupply}:${row.gstRate}`;
    const bucket = buckets.get(key) ?? {
      placeOfSupply: row.placeOfSupply, rate: row.gstRate,
      taxableValue: 0, cess: 0, invoiceCount: 0, numbers: new Set<string>(),
    };
    bucket.taxableValue = round2(bucket.taxableValue + row.taxableValue);
    // Count invoices, not rate rows — a mixed-rate invoice is still one invoice.
    bucket.numbers.add(row.invoiceNo);
    buckets.set(key, bucket);
  }

  const rows = [...buckets.values()]
    .map(({ numbers, ...bucket }) => ({ ...bucket, invoiceCount: numbers.size }))
    .sort((a, b) => a.placeOfSupply.localeCompare(b.placeOfSupply) || a.rate - b.rate);

  return { rows, excluded };
}
```

`ReportingService.generate` reads `listInvoices()`, rolls up, writes the rows to the `b2cs`
tab, and returns the CSV string for download.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/core/b2cs.test.ts test/services/reporting.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/b2cs.ts src/services/reporting.ts test/
git commit -m "feat: generate the monthly GSTR-1 B2CS rollup and CSV"
```

---

## Task 22: Routes — Shadowfax webhook, fulfillments, internal endpoints

**Files:**
- Create: `src/routes/shadowfax.ts`, `src/routes/internal.ts`
- Modify: `src/routes/shopify.ts`, `src/server.ts`
- Test: `test/routes/shadowfax.test.ts`, `test/routes/internal.test.ts`, `test/routes/shopify.test.ts`

**Interfaces:**
- Consumes: every service from Tasks 13–21
- Produces: `createShadowfaxRouter(deps)`, `createInternalRouter(deps)`

- [ ] **Step 1: Write the failing test**

```ts
// shadowfax.test.ts
it('rejects a request without the shared secret', async () => {
  const res = await request(app).post('/webhook/shadowfax').send({ awb_number: 'SF1', status: 'DELIVERED' });
  expect(res.status).toBe(401);
});

it('accepts a valid status and returns the result', async () => {
  const res = await request(app).post('/webhook/shadowfax')
    .set('X-Shadowfax-Token', 'secret').send({ awb_number: 'SF1', status: 'DELIVERED' });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ result: 'applied' });
});

it('answers 200 for an unmapped status so Shadowfax stops retrying', async () => {
  const res = await request(app).post('/webhook/shadowfax')
    .set('X-Shadowfax-Token', 'secret').send({ awb_number: 'SF1', status: 'TELEPORTED' });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ result: 'ignored_unknown_status' });
});

it('answers 400 for a payload with no AWB', async () => {
  const res = await request(app).post('/webhook/shadowfax')
    .set('X-Shadowfax-Token', 'secret').send({ status: 'DELIVERED' });
  expect(res.status).toBe(400);
});

// internal.test.ts
it('rejects an internal call without the task token', async () => {
  expect((await request(app).post('/internal/drain-effects')).status).toBe(401);
});

it('drains effects when authorised', async () => {
  const res = await request(app).post('/internal/drain-effects').set('Authorization', 'Bearer task-token');
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ done: expect.any(Number) });
});

// shopify.test.ts
it('records a fulfillment and its AWB', async () => {
  await postSignedWebhook('/webhook/shopify', fulfillmentPayload, { topic: 'fulfillments/create' });
  expect((await store.findShipmentByAwb('SF123'))?.orderNo).toBe('#1042');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/routes/`
Expected: FAIL — routers not found.

- [ ] **Step 3: Implement**

`createShadowfaxRouter` compares `X-Shadowfax-Token` against the configured secret using
`timingSafeEqual` (reuse the helper in `core/signatures.ts`), parses with
`parseShadowfaxWebhook`, returns **400** on a missing AWB and **200** with the
`SyncResult` otherwise. An unmapped status is a 200 — retrying will not make it mappable.

`createInternalRouter` guards every route on `Authorization: Bearer ${internalTaskToken}`
and exposes `POST /internal/sync-shipments`, `/rating-sweep`, `/drain-effects`,
and `GET /internal/b2cs?month=YYYY-MM` (returns the CSV as `text/csv`).

In `src/routes/shopify.ts`, branch on the `X-Shopify-Topic` header: `orders/create` goes to
the existing intake; `fulfillments/create` and `fulfillments/update` call
`shipmentSync.recordFulfillment(orderNo, trackingNumber, trackingCompany)`.

Wire both routers plus every new service into `src/server.ts`, registering the effect
handlers:

```ts
const effects = new EffectService({ store, handlers: {
  delivered: async (p) => delivery.onDelivered((p as { orderNo: string }).orderNo),
  rto_initiated: async (p) => rto.onRtoInitiated((p as { orderNo: string }).orderNo),
  rto_returned: async (p) => rto.onRtoReturned((p as { orderNo: string }).orderNo),
} });
```

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/ src/server.ts test/routes/
git commit -m "feat: add Shadowfax webhook, fulfillment intake and internal task endpoints"
```

---

## Task 23: Dashboard, templates, deploy

**Files:**
- Modify: `src/views/dashboard.ts`, `src/routes/dashboard.ts`, `src/routes/api.ts`
- Modify: `docs/templates.md`, `deploy.sh`, `README.md`
- Test: `test/routes/api.test.ts`

**Interfaces:**
- Consumes: every service
- Produces: `GET /api/delivery`, `/api/cancellations`, `/api/invoices`, `/api/health-flags`; `POST /api/cancellations/:orderNo/approve`

- [ ] **Step 1: Write the failing test**

```ts
it('lists orders awaiting cancel review', async () => {
  const res = await request(app).get('/api/cancellations').set('Authorization', 'Bearer dash-token');
  expect(res.status).toBe(200);
  expect(res.body.orders).toEqual([expect.objectContaining({ orderNo: '#1042' })]);
});

it('approves a cancellation through the API', async () => {
  const res = await request(app).post('/api/cancellations/%231042/approve').set('Authorization', 'Bearer dash-token');
  expect(res.status).toBe(200);
  expect(shopify.cancels).toHaveLength(1);
});

it('surfaces failed effects and unmapped statuses as health flags', async () => {
  const res = await request(app).get('/api/health-flags').set('Authorization', 'Bearer dash-token');
  expect(res.body).toMatchObject({ failedEffects: expect.any(Array), unmappedStatuses: expect.any(Array) });
});

it('refuses an unauthenticated request', async () => {
  expect((await request(app).get('/api/cancellations')).status).toBe(401);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/routes/api.test.ts`
Expected: FAIL — 404 on the new routes.

- [ ] **Step 3: Implement**

Add the API handlers behind the existing `DASHBOARD_TOKEN` check, then add these sections to
the server-rendered dashboard, following the existing template-literal pattern:
**Delivery** (shipped → OFD → delivered funnel, RTO list), **Cancellations** (review queue
with an Approve button), **Invoices** (register, GST discrepancy flags, voids),
**GST** (month picker + CSV download link), **Health** (failed effects, unmapped Shadowfax
statuses, ledger rows with a fallback HSN).

- [ ] **Step 4: Document the new templates**

Append to `docs/templates.md`, matching the existing format exactly (category, buttons,
body, variables, sample values):
- `order_delivered_invoice` — Utility, **document header**, `{{1}}` name, `{{2}}` order no
- `order_cancelled` — Utility, `{{1}}` name, `{{2}}` order no, `{{3}}` reason phrase
- `order_rating` — Utility, three quick replies `⭐ 1–2`, `⭐ 3`, `⭐ 4–5`

- [ ] **Step 5: Update `deploy.sh` and `README.md`**

Add `--max-instances=1` to the `gcloud run deploy` line with a comment explaining that
invoice numbering depends on it. Add the four `gcloud scheduler jobs create http` commands
(sync-shipments every 4h, rating-sweep daily, drain-effects every 5 min, and the campaign
tick left commented out until Plan 2). Print the Shadowfax webhook URL alongside the
existing ones.

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ docs/ deploy.sh README.md test/
git commit -m "feat: add Stage 1 dashboard sections, templates and deploy steps"
```

---

## Exit criteria

Run through these against the real store before calling Plan 1 done.

- [ ] `npm test && npm run typecheck && npm run build` all pass
- [ ] Real delivered COD order → marked paid in Shopify, invoice PDF arrives on WhatsApp
- [ ] GST split is correct for both an intra-state (CGST+SGST) and inter-state (IGST) buyer
- [ ] Invoice total matches the amount charged to the paisa
- [ ] Real RTO → cancelled with the note and `rto` tag, customer messaged, stock returns
      only once the parcel is physically back
- [ ] The same RTO status arriving by webhook *and* poll cancels exactly once
- [ ] Ledger row completes on delivery; filling `cogs` by hand updates EBITDA and PAT
      without the hub touching the row
- [ ] B2CS CSV for a month uploads to the GST portal without a format error
- [ ] Rating request arrives on day 3; all three buttons route correctly
- [ ] Replaying an old Shopify order webhook still sends no second message
