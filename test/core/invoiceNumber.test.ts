import { describe, it, expect } from 'vitest';
import { financialYear, formatInvoiceNumber, parseSequence } from '../../src/core/invoiceNumber.js';

// boundaries are in IST; India has no DST.
describe('financialYear', () => {
  it('is 26-27 in September 2026', () => expect(financialYear(new Date('2026-09-15T12:00:00Z'))).toBe('26-27'));
  it('is 25-26 on 31 March 2026 IST', () => expect(financialYear(new Date('2026-03-31T18:00:00Z'))).toBe('25-26'));
  it('is 26-27 on 1 April 2026 IST', () => expect(financialYear(new Date('2026-03-31T18:31:00Z'))).toBe('26-27'));
});

describe('formatInvoiceNumber', () => {
  it('zero-pads to four digits', () => expect(formatInvoiceNumber('UM', '26-27', 7)).toBe('UM/26-27/0007'));
  it('does not truncate past four digits', () => expect(formatInvoiceNumber('UM', '26-27', 12345)).toBe('UM/26-27/12345'));
});

describe('parseSequence', () => {
  it('reads the sequence back', () => expect(parseSequence('UM/26-27/0007')).toBe(7));
  it('returns 0 for a malformed number', () => expect(parseSequence('garbage')).toBe(0));
});
