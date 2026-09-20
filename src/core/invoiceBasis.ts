import { computeGst, round2, type GstBreakdown, type GstLine, type GstRates } from './gst.js';
import { apportion } from './discount.js';
import type { ConfirmStatus } from '../adapters/sheets.js';

/**
 * Everything a tax invoice's arithmetic depends on, resolved in one place and
 * refusing rather than guessing when an input is missing.
 *
 * Spec §5.3 is explicit that unresolved data "flags the order on the dashboard
 * rather than guessing", and three call sites were guessing instead: invoicing
 * substituted the seller's own state code for a missing place of supply (turning a
 * Maharashtra buyer's IGST into CGST+SGST and filing it under POS 19), and both
 * invoicing and delivery fell back to a single blended line built from the ledger's
 * aggregate item amount (turning two ₹1,400 tees, each a 5% supply, into an 18%
 * invoice). A wrong legal document is worse than a missing one, so every one of
 * these now blocks, and the block surfaces on /api/health-flags for the operator.
 *
 * Pure: no clock, no config reads, no I/O. Callers supply the rates and the row.
 */

/** Beyond this, the round-off line is not per-line paise drift any more. */
export const ROUND_OFF_TOLERANCE_INR = 1;

export type InvoiceBlockReason =
  | 'unresolved_place_of_supply'
  | 'line_items_unavailable'
  | 'round_off_out_of_tolerance';

export interface InvoiceBlock {
  reason: InvoiceBlockReason;
  detail: string;
}

export interface InvoiceBasisInput {
  /** The GST state code resolved at intake; blank when the province didn't resolve. */
  posCode: string;
  /** The per-line `{inclUnitPrice, quantity}` array frozen at intake, JSON-encoded. */
  linesJson: string;
  shippingCharged: number;
  amountCharged: number;
  /**
   * A discount the hub itself granted and can therefore account for — today only the
   * early-payment COD-fee waiver. Deliberately NOT "whatever gap exists between the
   * lines and the amount charged": netting an unexplained gap away would defeat the
   * round-off guard below, which exists to catch exactly the gaps nobody can explain
   * (a gift card, a partial refund, a price edit after the order was frozen).
   */
  discount?: number;
}

export interface InvoiceBasis {
  placeOfSupply: string;
  lines: GstLine[];
  breakdown: GstBreakdown;
}

export type InvoiceBasisResult =
  | { ok: true; basis: InvoiceBasis }
  | { ok: false; blocks: InvoiceBlock[] };

/** Raised when an invoice cannot be issued from the data on hand. */
export class InvoiceBlockedError extends Error {
  constructor(
    readonly orderNo: string,
    readonly blocks: InvoiceBlock[],
  ) {
    super(
      `invoice blocked for ${orderNo}: ${blocks
        .map((block) => `${block.reason} — ${block.detail}`)
        .join('; ')}`,
    );
    this.name = 'InvoiceBlockedError';
  }
}

/**
 * The per-line data frozen at intake, or null when there is none usable. An entry
 * that can't be read as a priced quantity is skipped rather than poisoning the whole
 * order; only an order with no usable line at all is unresolvable.
 */
export function parseGstLines(linesJson: string): GstLine[] | null {
  if (!linesJson) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(linesJson);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const lines: GstLine[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { inclUnitPrice, quantity } = entry as Record<string, unknown>;
    const price = Number(inclUnitPrice);
    const count = Number(quantity);
    if (!Number.isFinite(price) || price < 0) continue;
    if (!Number.isFinite(count) || count <= 0) continue;
    lines.push({ inclUnitPrice: price, quantity: count });
  }
  return lines.length > 0 ? lines : null;
}

/** Spreads a known order-level discount back onto the lines, pro rata by line value. */
function netDiscount(lines: GstLine[], discount: number): GstLine[] {
  if (!(discount > 0)) return lines;
  const gross = lines.map((line) => line.inclUnitPrice * line.quantity);
  const shares = apportion(gross, discount);
  return lines.map((line, index) => ({
    quantity: line.quantity,
    inclUnitPrice: round2(
      Math.max(0, (gross[index] ?? 0) - (shares[index] ?? 0)) / line.quantity,
    ),
  }));
}

export function resolveInvoiceBasis(
  input: InvoiceBasisInput,
  rates: GstRates,
): InvoiceBasisResult {
  const blocks: InvoiceBlock[] = [];

  const placeOfSupply = input.posCode.trim();
  if (!placeOfSupply) {
    blocks.push({
      reason: 'unresolved_place_of_supply',
      detail:
        "the ledger's pos_code is blank — the buyer's province did not resolve to a GST " +
        'state code at intake, and guessing it would file the supply under the wrong state',
    });
  }

  const parsed = parseGstLines(input.linesJson);
  if (!parsed) {
    // Without the frozen per-line data there is no way to know which pieces sat in
    // which slab; the ledger only ever kept one blended item amount.
    blocks.push({
      reason: 'line_items_unavailable',
      detail:
        "the order's lines_json is blank or unusable — the per-piece GST slab cannot be " +
        'decided from the aggregate item amount',
    });
    return { ok: false, blocks };
  }

  const lines = netDiscount(parsed, input.discount ?? 0);
  const breakdown = computeGst(lines, input.shippingCharged, input.amountCharged, rates);

  // The round-off line absorbs a few paise of per-line drift. Anything beyond a rupee
  // is by definition a reconciliation failure — an unmodelled discount, a gift card, a
  // partial refund, a price edit — and issuing an invoice that buries it in Round Off
  // would put a number on a legal document that nothing backs.
  if (Math.abs(breakdown.roundOff) > ROUND_OFF_TOLERANCE_INR) {
    blocks.push({
      reason: 'round_off_out_of_tolerance',
      detail:
        `round off ${breakdown.roundOff} exceeds ±${ROUND_OFF_TOLERANCE_INR} — the line ` +
        `total does not reconcile with the ${input.amountCharged} actually charged`,
    });
  }

  if (blocks.length > 0) return { ok: false, blocks };
  return { ok: true, basis: { placeOfSupply, lines, breakdown } };
}

/** The order fields that decide what money actually changed hands. */
export interface ChargeFields {
  confirmStatus: ConfirmStatus;
  amount: number;
  payable: number;
}

/**
 * `payable` is `amount - codFee`, the discounted figure for paying early online. A COD
 * customer hands over the full `amount` at the door, so the invoice totals `amount` for
 * every order except the one where the customer genuinely paid the discounted sum.
 */
export function amountChargedFor(order: ChargeFields): number {
  return order.confirmStatus === 'PAID_EARLY' ? order.payable : order.amount;
}

/**
 * The COD-fee waiver the hub itself granted, which is a real discount on the supply and
 * must be netted into the line prices — otherwise it would show up as an unexplained
 * round-off and (correctly, but unhelpfully) block the invoice.
 */
export function earlyPayDiscount(order: ChargeFields): number {
  if (order.confirmStatus !== 'PAID_EARLY') return 0;
  const discount = round2(order.amount - order.payable);
  return discount > 0 ? discount : 0;
}
