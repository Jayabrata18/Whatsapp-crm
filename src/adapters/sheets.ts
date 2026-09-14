export type ConfirmStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'PAID_EARLY' | 'NO_RESPONSE';

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
}

/** Field → column letter. The single source of truth for where each field lives. */
export const ORDER_COLUMNS: Record<keyof OrderRow, string> = {
  orderNo: 'A', orderId: 'B', customerName: 'C', phone: 'D',
  amount: 'E', codFee: 'F', payable: 'G', isCod: 'H',
  confirmStatus: 'I', paymentLink: 'J', createdAt: 'K',
  confirmedAt: 'L', paidAt: 'M',
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
