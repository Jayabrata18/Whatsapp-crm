import { describe, it, expect } from 'vitest';
import { rupeesInWords } from '../../src/core/amountInWords.js';

describe('rupeesInWords', () => {
  it('writes lakhs and crores, not millions', () => {
    expect(rupeesInWords(125000)).toBe('One Lakh Twenty Five Thousand Rupees Only');
    expect(rupeesInWords(10000000)).toBe('One Crore Rupees Only');
  });

  it('includes paise when present', () => {
    expect(rupeesInWords(1899.5)).toBe('One Thousand Eight Hundred Ninety Nine Rupees and Fifty Paise Only');
  });

  it('handles zero', () => expect(rupeesInWords(0)).toBe('Zero Rupees Only'));
});
