import { describe, it, expect } from 'vitest';
import { EffectService } from '../../src/services/effects.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { baseEffect } from '../fixtures/stage1.js';

describe('EffectService', () => {
  it('marks an effect DONE when its handler succeeds', async () => {
    const store = new InMemorySheetStore();
    const svc = new EffectService({
      store,
      handlers: { tag: async () => {} },
      now: () => new Date('2026-09-15T10:00:00Z'),
    });
    await svc.enqueue('#1042', 'tag', { tag: 'rto' });
    expect(await svc.drain()).toEqual({ done: 1, retried: 0, failed: 0 });
    expect(store.effects[0]!.state).toBe('DONE');
  });

  it('backs off exponentially on failure and keeps the error', async () => {
    const store = new InMemorySheetStore();
    const svc = new EffectService({
      store,
      handlers: {
        tag: async () => {
          throw new Error('shopify down');
        },
      },
      now: () => new Date('2026-09-15T10:00:00Z'),
    });
    await svc.enqueue('#1042', 'tag', {});
    expect(await svc.drain()).toEqual({ done: 0, retried: 1, failed: 0 });

    const row = store.effects[0]!;
    expect(row.state).toBe('PENDING');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('shopify down');
    expect(row.nextAttemptAt).toBe('2026-09-15T10:01:00.000Z'); // 60s * 2^0
  });

  it('gives up after maxAttempts and marks FAILED', async () => {
    const store = new InMemorySheetStore();
    await store.appendEffect({
      ...baseEffect,
      kind: 'tag',
      attempts: 4,
      nextAttemptAt: '2026-01-01T00:00:00.000Z',
    });
    const svc = new EffectService({
      store,
      handlers: {
        tag: async () => {
          throw new Error('nope');
        },
      },
      maxAttempts: 5,
      now: () => new Date('2026-09-15T10:00:00Z'),
    });
    expect(await svc.drain()).toEqual({ done: 0, retried: 0, failed: 1 });
    expect(store.effects[0]!.state).toBe('FAILED');
  });

  it('fails an effect whose kind has no handler rather than retrying forever', async () => {
    const store = new InMemorySheetStore();
    const svc = new EffectService({
      store,
      handlers: {},
      now: () => new Date('2026-09-15T10:00:00Z'),
    });
    await svc.enqueue('#1042', 'mystery', {});
    expect(await svc.drain()).toEqual({ done: 0, retried: 0, failed: 1 });
  });

  it('keeps draining after one effect throws', async () => {
    const store = new InMemorySheetStore();
    const svc = new EffectService({
      store,
      handlers: {
        bad: async () => {
          throw new Error('x');
        },
        good: async () => {},
      },
      now: () => new Date('2026-09-15T10:00:00Z'),
    });
    await svc.enqueue('#1', 'bad', {});
    await svc.enqueue('#2', 'good', {});
    expect(await svc.drain()).toEqual({ done: 1, retried: 1, failed: 0 });
  });
});
