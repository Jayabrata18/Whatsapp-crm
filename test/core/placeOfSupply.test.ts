import { describe, it, expect } from 'vitest';
import { stateCodeFor, isInterState, STATE_CODES } from '../../src/core/placeOfSupply.js';

describe('stateCodeFor', () => {
  it('maps West Bengal to 19', () => expect(stateCodeFor('WB')).toBe('19'));
  it('maps Maharashtra to 27', () => expect(stateCodeFor('MH')).toBe('27'));
  it('maps Delhi to 07', () => expect(stateCodeFor('DL')).toBe('07'));
  it('is case-insensitive', () => expect(stateCodeFor('wb')).toBe('19'));
  it('returns null for an unknown code', () => expect(stateCodeFor('XX')).toBeNull());
  it('returns null for missing input', () => {
    expect(stateCodeFor(null)).toBeNull();
    expect(stateCodeFor(undefined)).toBeNull();
    expect(stateCodeFor('')).toBeNull();
  });
  it('covers all 36 states and union territories', () => {
    // 40 keys, not 36: Uttarakhand, Odisha, Chhattisgarh and Telangana each carry both
    // their ISO 3166-2:IN code and the alternate spelling Shopify may send (UT/UK,
    // OR/OD, CT/CG, TG/TS). The 36 distinct *values* are what "full coverage" means —
    // the key count was only ever a proxy for it.
    expect(Object.keys(STATE_CODES)).toHaveLength(40);
    expect(new Set(Object.values(STATE_CODES)).size).toBe(36);
  });
});

describe('isInterState', () => {
  it('is false within the seller state', () => expect(isInterState('19', '19')).toBe(false));
  it('is true outside it', () => expect(isInterState('27', '19')).toBe(true));
});
