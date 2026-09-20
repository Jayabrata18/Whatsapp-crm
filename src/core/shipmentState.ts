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
