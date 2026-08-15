import { describe, it, expect } from 'vitest';
import { computePricing } from '../../src/core/incentive.js';

describe('computePricing', () => {
  it('waives the COD fee on a COD order', () => {
    expect(computePricing(1899, true, 50)).toEqual({ payable: 1849, codFee: 50 });
  });

  it('charges a prepaid order the full amount with no fee', () => {
    expect(computePricing(1899, false, 50)).toEqual({ payable: 1899, codFee: 0 });
  });

  it('does not waive when the order total equals the fee', () => {
    expect(computePricing(50, true, 50)).toEqual({ payable: 50, codFee: 0 });
  });

  it('does not waive when the order total is below the fee', () => {
    expect(computePricing(30, true, 50)).toEqual({ payable: 30, codFee: 0 });
  });

  it('never produces a zero or negative payable', () => {
    for (const amount of [0, 1, 25, 49, 50, 51]) {
      const { payable } = computePricing(amount, true, 50);
      expect(payable).toBeGreaterThanOrEqual(amount > 0 ? 1 : 0);
      expect(payable).toBeLessThanOrEqual(amount);
    }
  });

  it('honours a configured fee other than 50', () => {
    expect(computePricing(2000, true, 75)).toEqual({ payable: 1925, codFee: 75 });
  });

  it('applies no waiver when the fee is configured to zero', () => {
    expect(computePricing(1899, true, 0)).toEqual({ payable: 1899, codFee: 0 });
  });
});
