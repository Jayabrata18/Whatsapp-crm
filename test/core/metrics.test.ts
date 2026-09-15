import { describe, it, expect } from 'vitest';
import { computeMetrics } from '../../src/core/metrics.js';
import type { OrderRow } from '../../src/adapters/sheets.js';

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    orderNo: '#1',
    orderId: '1',
    customerName: 'A',
    phone: '919876543210',
    amount: 1000,
    codFee: 50,
    payable: 950,
    isCod: true,
    confirmStatus: 'PENDING',
    paymentLink: '',
    createdAt: '2026-08-16T10:00:00.000Z',
    confirmedAt: '',
    paidAt: '',
    fulfillmentStatus: 'NEW',
    awb: '',
    cancelStatus: 'NONE',
    cancelReason: '',
    invoiceNo: '',
    rating: '',
    gstDiscrepancy: 0,
    linesJson: '',
    ...overrides,
  };
}

describe('computeMetrics', () => {
  it('returns zeroes for an empty list without dividing by zero', () => {
    expect(computeMetrics([])).toEqual({
      total: 0,
      codOrders: 0,
      pending: 0,
      confirmed: 0,
      cancelled: 0,
      paidEarly: 0,
      noResponse: 0,
      confirmRate: 0,
      earlyPayRate: 0,
      revenueCollectedEarly: 0,
    });
  });

  it('counts each status', () => {
    const metrics = computeMetrics([
      order({ orderNo: '#1', confirmStatus: 'PENDING' }),
      order({ orderNo: '#2', confirmStatus: 'CONFIRMED' }),
      order({ orderNo: '#3', confirmStatus: 'PAID_EARLY' }),
      order({ orderNo: '#4', confirmStatus: 'CANCELLED' }),
      order({ orderNo: '#5', confirmStatus: 'NO_RESPONSE' }),
    ]);
    expect(metrics).toMatchObject({
      total: 5,
      pending: 1,
      confirmed: 1,
      paidEarly: 1,
      cancelled: 1,
      noResponse: 1,
    });
  });

  it('treats PAID_EARLY as also confirmed when computing confirm rate', () => {
    const metrics = computeMetrics([
      order({ orderNo: '#1', confirmStatus: 'CONFIRMED' }),
      order({ orderNo: '#2', confirmStatus: 'PAID_EARLY' }),
      order({ orderNo: '#3', confirmStatus: 'PENDING' }),
      order({ orderNo: '#4', confirmStatus: 'PENDING' }),
    ]);
    expect(metrics.confirmRate).toBe(50);
  });

  it('computes early-pay rate against confirmed orders, not all orders', () => {
    const metrics = computeMetrics([
      order({ orderNo: '#1', confirmStatus: 'CONFIRMED' }),
      order({ orderNo: '#2', confirmStatus: 'PAID_EARLY' }),
      order({ orderNo: '#3', confirmStatus: 'PENDING' }),
    ]);
    // 1 paid out of 2 confirmed
    expect(metrics.earlyPayRate).toBe(50);
  });

  it('sums payable across paid-early orders only', () => {
    const metrics = computeMetrics([
      order({ orderNo: '#1', confirmStatus: 'PAID_EARLY', payable: 950 }),
      order({ orderNo: '#2', confirmStatus: 'PAID_EARLY', payable: 1500 }),
      order({ orderNo: '#3', confirmStatus: 'CONFIRMED', payable: 800 }),
    ]);
    expect(metrics.revenueCollectedEarly).toBe(2450);
  });

  it('counts COD orders separately from prepaid', () => {
    const metrics = computeMetrics([
      order({ orderNo: '#1', isCod: true }),
      order({ orderNo: '#2', isCod: false }),
      order({ orderNo: '#3', isCod: true }),
    ]);
    expect(metrics.codOrders).toBe(2);
  });

  it('rounds rates to one decimal place', () => {
    const metrics = computeMetrics([
      order({ orderNo: '#1', confirmStatus: 'CONFIRMED' }),
      order({ orderNo: '#2', confirmStatus: 'PENDING' }),
      order({ orderNo: '#3', confirmStatus: 'PENDING' }),
    ]);
    expect(metrics.confirmRate).toBe(33.3);
  });
});
