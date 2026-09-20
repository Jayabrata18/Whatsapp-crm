import { describe, it, expect } from 'vitest';
import { canTransition, isTerminal, ALL_STATUSES, type FulfillmentStatus } from '../../src/core/shipmentState.js';

const LEGAL: Array<[FulfillmentStatus, FulfillmentStatus]> = [
  ['NEW', 'SHIPPED'], ['SHIPPED', 'OFD'], ['SHIPPED', 'DELIVERED'],
  ['SHIPPED', 'RTO_INITIATED'], ['OFD', 'DELIVERED'], ['OFD', 'RTO_INITIATED'],
  ['RTO_INITIATED', 'RTO_RETURNED'],
];

it('allows every legal transition', () => {
  for (const [from, to] of LEGAL) expect(canTransition(from, to)).toBe(true);
});

it('rejects every transition that is not legal', () => {
  const legal = new Set(LEGAL.map(([f, t]) => `${f}->${t}`));
  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      if (legal.has(`${from}->${to}`)) continue;
      expect(canTransition(from, to)).toBe(false);
    }
  }
});

it('never allows a terminal status to advance', () => {
  for (const to of ALL_STATUSES) {
    expect(canTransition('DELIVERED', to)).toBe(false);
    expect(canTransition('RTO_RETURNED', to)).toBe(false);
  }
});

it('rejects a repeat of the current status', () => {
  expect(canTransition('SHIPPED', 'SHIPPED')).toBe(false);
});

it('marks only DELIVERED and RTO_RETURNED terminal', () => {
  expect(ALL_STATUSES.filter(isTerminal)).toEqual(['DELIVERED', 'RTO_RETURNED']);
});
