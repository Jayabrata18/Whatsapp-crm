import { describe, it, expect } from 'vitest';
import { round2, rateFor, computeGst, splitTax } from '../../src/core/gst.js';

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
    // Both unit prices (333 and 777) are 5% goods — 777 <= 2500 too — so this
    // is a single-bucket order, not a mixed-rate one. Pin the actual breakdown
    // so a wrong-bucket bug can't hide behind the round-off residual, which is
    // true by construction for any internally-consistent split.
    expect(b.goods).toEqual([{ rate: 5, taxable: 1691.43, tax: 84.57 }]);
    expect(b.shipping).toEqual([{ rate: 5, taxable: 46.67, tax: 2.33 }]);
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
