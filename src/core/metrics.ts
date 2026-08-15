import type { OrderRow } from '../adapters/sheets.js';

export interface Metrics {
  total: number;
  codOrders: number;
  pending: number;
  confirmed: number;
  cancelled: number;
  paidEarly: number;
  noResponse: number;
  /** Share of all orders that reached CONFIRMED or beyond, as a percentage. */
  confirmRate: number;
  /** Share of confirmed orders that were paid early, as a percentage. */
  earlyPayRate: number;
  revenueCollectedEarly: number;
}

function pct(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function computeMetrics(orders: OrderRow[]): Metrics {
  const count = (status: OrderRow['confirmStatus']) =>
    orders.filter((row) => row.confirmStatus === status).length;

  const paidEarly = count('PAID_EARLY');
  const confirmed = count('CONFIRMED');
  // A paid order was necessarily confirmed first.
  const reachedConfirmed = confirmed + paidEarly;

  return {
    total: orders.length,
    codOrders: orders.filter((row) => row.isCod).length,
    pending: count('PENDING'),
    confirmed,
    cancelled: count('CANCELLED'),
    paidEarly,
    noResponse: count('NO_RESPONSE'),
    confirmRate: pct(reachedConfirmed, orders.length),
    earlyPayRate: pct(paidEarly, reachedConfirmed),
    revenueCollectedEarly: orders
      .filter((row) => row.confirmStatus === 'PAID_EARLY')
      .reduce((sum, row) => sum + row.payable, 0),
  };
}
