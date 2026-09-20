import type { FulfillmentStatus } from '../core/shipmentState.js';
import type { LedgerOrderFields, LedgerOutcomeFields } from '../core/ledgerRow.js';
import type { B2csRow } from '../core/b2cs.js';

export type ConfirmStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'PAID_EARLY' | 'NO_RESPONSE';

export type CancelStatus = 'NONE' | 'REVIEW_PENDING' | 'CANCELLED';

export interface OrderRow {
  orderNo: string;
  orderId: string;
  customerName: string;
  phone: string;
  amount: number;
  codFee: number;
  payable: number;
  isCod: boolean;
  confirmStatus: ConfirmStatus;
  paymentLink: string;
  createdAt: string;
  confirmedAt: string;
  paidAt: string;
  fulfillmentStatus: FulfillmentStatus;
  awb: string;
  cancelStatus: CancelStatus;
  cancelReason: string;
  invoiceNo: string;
  rating: string;
  gstDiscrepancy: number;
  /**
   * The Shopify per-line `{inclUnitPrice, quantity}` array captured at intake, JSON-encoded.
   * A tax invoice must reflect what the customer was actually charged at order time, not a
   * later re-read — and delivery can happen days after intake — so this freezes the exact
   * rate-determining data `computeGst` needs, rather than re-deriving it from an aggregate.
   * Blank for orders placed before this column existed.
   */
  linesJson: string;
}

export interface MessageRow {
  orderNo: string;
  template: string;
  wamid: string;
  direction: 'out' | 'in';
  status: string;
  timestamp: string;
}

export type EventSource = 'shopify' | 'meta' | 'cashfree';

export interface ShipmentRow {
  orderNo: string;
  awb: string;
  courier: string;
  status: FulfillmentStatus;
  shippedAt: string;
  ofdAt: string;
  deliveredAt: string;
  rtoInitiatedAt: string;
  rtoReturnedAt: string;
  lastSyncedAt: string;
  rawStatus: string;
  /**
   * Stamped once `RtoService.onRtoReturned` has successfully restocked this shipment.
   * Blocks a retry of the same effect from re-submitting `adjustInventory` — appended
   * as the last column rather than inserted earlier, so it doesn't shift any existing
   * `shipments` column letter.
   */
  rtoRestockedAt: string;
}

/**
 * One row per (invoice, GST rate). A mixed-rate order produces two rows sharing an
 * invoice number — collapsing them into a single `gstRate` would roll the whole
 * invoice up at one rate in B2CS, which is exactly the number the GST portal checks.
 * Shipping tax is folded into the row for the rate it was apportioned to.
 * `invoiceTotal` and `roundOff` are invoice-level and repeat across a shared number.
 */
export interface InvoiceRow {
  invoiceNo: string;
  orderNo: string;
  invoiceDate: string;
  placeOfSupply: string;
  hsn: string;
  gstRate: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  roundOff: number;
  invoiceTotal: number;
  mediaId: string;
  status: 'ISSUED' | 'VOID';
}

export interface EffectRow {
  effectId: string;
  orderNo: string;
  kind: string;
  payloadJson: string;
  attempts: number;
  state: 'PENDING' | 'DONE' | 'FAILED';
  lastError: string;
  createdAt: string;
  nextAttemptAt: string;
}

export interface SheetStore {
  appendOrder(row: OrderRow): Promise<void>;
  listOrders(): Promise<OrderRow[]>;
  findOrderByNo(orderNo: string): Promise<OrderRow | null>;
  /** Most recently created order for this phone in PENDING status, or null. */
  findLatestPendingByPhone(phone: string): Promise<OrderRow | null>;
  /** Writes ONLY the columns named in `patch`. There is deliberately no whole-row write. */
  updateOrderFields(orderNo: string, patch: Partial<OrderRow>): Promise<void>;
  appendMessage(row: MessageRow): Promise<void>;
  updateMessageStatus(wamid: string, status: string): Promise<void>;
  listMessages(): Promise<MessageRow[]>;
  /** True when this exact event was already processed. */
  hasEvent(source: EventSource, externalId: string): Promise<boolean>;
  recordEvent(source: EventSource, externalId: string): Promise<void>;
  /** Upserted by AWB, not appended — a status change replaces the existing row. */
  upsertShipment(row: ShipmentRow): Promise<void>;
  findShipmentByAwb(awb: string): Promise<ShipmentRow | null>;
  /** Non-terminal shipments only. */
  listOpenShipments(): Promise<ShipmentRow[]>;
  /** All rows share one invoice number — one row per (invoice, GST rate). */
  appendInvoiceLines(rows: InvoiceRow[]): Promise<void>;
  listInvoices(): Promise<InvoiceRow[]>;
  lastInvoiceSequence(fy: string): Promise<number>;
  /** Marks every row of that invoice number VOID. */
  voidInvoice(invoiceNo: string): Promise<void>;
  appendEffect(row: EffectRow): Promise<void>;
  /** PENDING effects whose next attempt is at or before `nowIso`. */
  listDueEffects(nowIso: string): Promise<EffectRow[]>;
  updateEffect(effectId: string, patch: Partial<EffectRow>): Promise<void>;
  /**
   * Writes A–J only, then the W–Y formulas. There is deliberately no method
   * on this interface that can address the operator-owned R–V columns.
   */
  appendLedgerOrder(fields: LedgerOrderFields, corporateTaxPct: number): Promise<void>;
  /** Writes K–Q only — the ceiling is why this exists as its own method. */
  updateLedgerOutcome(orderNo: string, fields: LedgerOutcomeFields): Promise<void>;
  listLedger(): Promise<Record<string, unknown>[]>;
  /** Every persisted B2CS row, across every month a report has ever been generated for. */
  listB2cs(): Promise<Array<{ month: string } & B2csRow>>;
  /**
   * Replaces every row tagged with `month` with `rows` — the same replace-by-key
   * convention `upsertShipment` uses, applied here with `month` as the key instead
   * of `awb`. This tab is meant for direct operator/accountant inspection like every
   * other tab in this store, so a re-run of `ReportingService.generate` for a month
   * (a double-click, an HTTP retry-on-timeout) must not leave two overlapping sets
   * of rows for a human to accidentally sum together.
   */
  replaceB2csMonth(month: string, rows: B2csRow[]): Promise<void>;
}

/** Field → column letter. The single source of truth for where each field lives. */
export const ORDER_COLUMNS: Record<keyof OrderRow, string> = {
  orderNo: 'A', orderId: 'B', customerName: 'C', phone: 'D',
  amount: 'E', codFee: 'F', payable: 'G', isCod: 'H',
  confirmStatus: 'I', paymentLink: 'J', createdAt: 'K',
  confirmedAt: 'L', paidAt: 'M',
  fulfillmentStatus: 'N', awb: 'O', cancelStatus: 'P', cancelReason: 'Q',
  invoiceNo: 'R', rating: 'S', gstDiscrepancy: 'T', linesJson: 'U',
};

export const ORDER_HEADERS = [
  'order_no',
  'order_id',
  'customer_name',
  'phone',
  'amount',
  'cod_fee',
  'payable',
  'is_cod',
  'confirm_status',
  'payment_link',
  'created_at',
  'confirmed_at',
  'paid_at',
  'fulfillment_status',
  'awb',
  'cancel_status',
  'cancel_reason',
  'invoice_no',
  'rating',
  'gst_discrepancy',
  'lines_json',
] as const;

export const MESSAGE_HEADERS = [
  'order_no',
  'template',
  'wamid',
  'direction',
  'status',
  'timestamp',
] as const;

export const EVENT_HEADERS = ['source', 'external_id', 'received_at'] as const;

export const SHIPMENT_COLUMNS: Record<keyof ShipmentRow, string> = {
  orderNo: 'A', awb: 'B', courier: 'C', status: 'D',
  shippedAt: 'E', ofdAt: 'F', deliveredAt: 'G',
  rtoInitiatedAt: 'H', rtoReturnedAt: 'I', lastSyncedAt: 'J', rawStatus: 'K',
  rtoRestockedAt: 'L',
};

export const SHIPMENT_HEADERS = [
  'order_no',
  'awb',
  'courier',
  'status',
  'shipped_at',
  'ofd_at',
  'delivered_at',
  'rto_initiated_at',
  'rto_returned_at',
  'last_synced_at',
  'raw_status',
  'rto_restocked_at',
] as const;

export const INVOICE_COLUMNS: Record<keyof InvoiceRow, string> = {
  invoiceNo: 'A', orderNo: 'B', invoiceDate: 'C', placeOfSupply: 'D', hsn: 'E',
  gstRate: 'F', taxableValue: 'G', cgst: 'H', sgst: 'I', igst: 'J',
  roundOff: 'K', invoiceTotal: 'L', mediaId: 'M', status: 'N',
};

export const INVOICE_HEADERS = [
  'invoice_no',
  'order_no',
  'invoice_date',
  'place_of_supply',
  'hsn',
  'gst_rate',
  'taxable_value',
  'cgst',
  'sgst',
  'igst',
  'round_off',
  'invoice_total',
  'media_id',
  'status',
] as const;

export const EFFECT_COLUMNS: Record<keyof EffectRow, string> = {
  effectId: 'A', orderNo: 'B', kind: 'C', payloadJson: 'D', attempts: 'E',
  state: 'F', lastError: 'G', createdAt: 'H', nextAttemptAt: 'I',
};

export const EFFECT_HEADERS = [
  'effect_id',
  'order_no',
  'kind',
  'payload_json',
  'attempts',
  'state',
  'last_error',
  'created_at',
  'next_attempt_at',
] as const;

/** `month` isn't part of `B2csRow` — it's the sheet's own key for grouping runs, supplied by the caller. */
export const B2CS_COLUMNS: Record<'month' | keyof B2csRow, string> = {
  month: 'A', placeOfSupply: 'B', rate: 'C', taxableValue: 'D', cess: 'E', invoiceCount: 'F',
};

export const B2CS_HEADERS = [
  'month',
  'place_of_supply',
  'rate',
  'taxable_value',
  'cess',
  'invoice_count',
] as const;
