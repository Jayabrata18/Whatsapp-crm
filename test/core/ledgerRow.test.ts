import { describe, it, expect } from 'vitest';
import { ledgerOrderValues, ledgerFormulas } from '../../src/core/ledgerRow.js';

describe('ledgerOrderValues', () => {
  it('builds the A–J order block in column order', () => {
    expect(ledgerOrderValues({
      orderNo: '#1042', orderDate: '2026-09-15', pincode: '700001', state: 'West Bengal',
      posCode: '19', skus: 'TEE-BLK-L x2', itemAmount: 1800, shippingCharged: 99,
      grossAmount: 1899, isCod: true,
    })).toEqual(['#1042', '2026-09-15', '700001', 'West Bengal', '19', 'TEE-BLK-L x2', 1800, 99, 1899, 'TRUE']);
  });
});

describe('ledgerFormulas', () => {
  it('builds W–Y formulas against the given sheet row', () => {
    expect(ledgerFormulas(5, 25)).toEqual([
      '=P5-M5-N5-R5-U5',
      '=W5-T5-S5-Q5',
      '=X5*(1-0.25)',
    ]);
  });

  it('never emits a formula referencing a column past Y', () => {
    const refs = ledgerFormulas(2, 25).join(' ').match(/[A-Z]+(?=\d)/g) ?? [];
    for (const ref of refs) expect(ref <= 'Y').toBe(true);
  });
});
