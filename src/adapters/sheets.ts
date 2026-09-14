import type { FulfillmentStatus } from '../core/shipmentState.js';

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
}

/** Field → column letter. The single source of truth for where each field lives. */
export const ORDER_COLUMNS: Record<keyof OrderRow, string> = {
  orderNo: 'A', orderId: 'B', customerName: 'C', phone: 'D',
  amount: 'E', codFee: 'F', payable: 'G', isCod: 'H',
  confirmStatus: 'I', paymentLink: 'J', createdAt: 'K',
  confirmedAt: 'L', paidAt: 'M',
  fulfillmentStatus: 'N', awb: 'O', cancelStatus: 'P', cancelReason: 'Q',
  invoiceNo: 'R', rating: 'S', gstDiscrepancy: 'T',
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
