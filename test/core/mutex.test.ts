import { describe, it, expect } from 'vitest';
import { Mutex } from '../../src/core/mutex.js';

describe('Mutex', () => {
  it('serialises overlapping runs', async () => {
    const mutex = new Mutex();
    const order: string[] = [];
    const slow = mutex.run(async () => { order.push('a-start'); await new Promise((r) => setTimeout(r, 20)); order.push('a-end'); });
    const fast = mutex.run(async () => { order.push('b-start'); order.push('b-end'); });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('releases the lock when the body throws', async () => {
    const mutex = new Mutex();
    await expect(mutex.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(mutex.run(async () => 'ok')).resolves.toBe('ok');
  });
});
