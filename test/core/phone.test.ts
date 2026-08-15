import { describe, it, expect } from 'vitest';
import { normalizeIndianPhone } from '../../src/core/phone.js';

describe('normalizeIndianPhone', () => {
  it.each([
    ['+91 98765 43210', '919876543210'],
    ['+919876543210', '919876543210'],
    ['09876543210', '919876543210'],
    ['9876543210', '919876543210'],
    ['919876543210', '919876543210'],
    ['91 98765-43210', '919876543210'],
    ['0091 9876543210', '919876543210'],
    ['  9876543210  ', '919876543210'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeIndianPhone(input)).toBe(expected);
  });

  it.each([
    ['', 'empty string'],
    ['   ', 'whitespace only'],
    ['12345', 'too short'],
    ['5876543210', 'does not start with 6-9'],
    ['98765432101234', 'too long'],
    ['not-a-phone', 'non-numeric'],
    ['+1 415 555 0123', 'non-Indian country code'],
  ])('rejects %s (%s)', (input) => {
    expect(normalizeIndianPhone(input)).toBeNull();
  });

  it('rejects null and undefined', () => {
    expect(normalizeIndianPhone(null)).toBeNull();
    expect(normalizeIndianPhone(undefined)).toBeNull();
  });
});
