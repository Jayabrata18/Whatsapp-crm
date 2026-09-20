import type { InvoiceRow } from '../adapters/sheets.js';
import { round2 } from './gst.js';
import { isInterState } from './placeOfSupply.js';

/**
 * One row per (place of supply, GST rate) bucket for GSTR-1's B2CS table —
 * unregistered B2C sales rolled up statewise and rate-wise, exactly the shape
 * the GST portal's offline tool expects to import.
 */
export interface B2csRow {
  placeOfSupply: string;
  rate: number;
  taxableValue: number;
  cess: number;
  invoiceCount: number;
}

/**
 * Above this, an inter-state B2C invoice belongs in GSTR-1's B2CL table instead of
 * B2CS. The owner's largest order is roughly ₹5,000, so this line is effectively
 * never crossed today — it's a guard against a future change, not a path this
 * business exercises, which is why the handling below stays this simple.
 */
export const B2CL_THRESHOLD_INR = 250_000;

/**
 * Rolls up a month's ISSUED invoice-lines into GSTR-1 B2CS buckets.
 *
 * `InvoiceRow` is one row per (invoice, GST rate) — a mixed-rate order shares one
 * invoice number across two rows — so this groups by (place of supply, rate)
 * without ever collapsing a mixed-rate order onto a single rate.
 *
 * B2CL is decided per INVOICE, not per rate row: an inter-state invoice over the
 * ₹2.5L threshold has every one of its rows excluded, or half of it would be filed
 * in the wrong GSTR-1 table. Excluded rows are returned to the caller rather than
 * silently dropped, since dropping them would understate the return.
 */
export function rollupB2cs(
  invoices: InvoiceRow[],
  month: string,
  sellerStateCode: string,
): { rows: B2csRow[]; excluded: InvoiceRow[] } {
  const inMonth = invoices.filter(
    (row) => row.status !== 'VOID' && row.invoiceDate.startsWith(month),
  );

  const b2clNumbers = new Set(
    inMonth
      .filter(
        (row) => isInterState(row.placeOfSupply, sellerStateCode) && row.invoiceTotal > B2CL_THRESHOLD_INR,
      )
      .map((row) => row.invoiceNo),
  );

  const excluded = inMonth.filter((row) => b2clNumbers.has(row.invoiceNo));
  const buckets = new Map<string, B2csRow & { numbers: Set<string> }>();

  for (const row of inMonth) {
    if (b2clNumbers.has(row.invoiceNo)) continue;

    const key = `${row.placeOfSupply}:${row.gstRate}`;
    const bucket = buckets.get(key) ?? {
      placeOfSupply: row.placeOfSupply,
      rate: row.gstRate,
      taxableValue: 0,
      cess: 0,
      invoiceCount: 0,
      numbers: new Set<string>(),
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

/**
 * Emits the exact column order the GST Returns Offline Tool expects for its B2CS
 * import. `Type` is always `OE` ("Other than E-Commerce" — this business sells
 * direct, not through a marketplace operator), and "Applicable % of Tax Rate" and
 * "E-Commerce GSTIN" are left blank: both are marketplace-only fields.
 */
export function toB2csCsv(rows: B2csRow[]): string {
  const header = 'Type,Place Of Supply,Applicable % of Tax Rate,Rate,Taxable Value,Cess Amount,E-Commerce GSTIN';
  const lines = rows.map((row) => `OE,${row.placeOfSupply},,${row.rate},${row.taxableValue},${row.cess},`);
  return [header, ...lines].join('\n');
}
