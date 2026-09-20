import { describe, it, expect } from 'vitest';
import { RatingService, TEMPLATE_RATING, type RatingDeps } from '../../src/services/rating.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { StubWhatsAppClient } from '../fakes/stubClients.js';
import { baseShipment } from '../fixtures/stage1.js';
import type { OrderRow } from '../../src/adapters/sheets.js';

const NOW = new Date('2026-09-15T10:00:00.000Z');
const RATING_DELAY_DAYS = 3;
const JUDGEME_URL = 'https://judge.me/reviews/new';

function order(orderNo: string, overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    orderNo,
    orderId: '99',
    customerName: 'Aarav',
    phone: '919876543210',
    amount: 1899,
    codFee: 0,
    payable: 1899,
    isCod: true,
    confirmStatus: 'CONFIRMED',
    paymentLink: '',
    createdAt: '2026-09-01T10:00:00.000Z',
    confirmedAt: '2026-09-01T10:05:00.000Z',
    paidAt: '2026-09-01T10:05:00.000Z',
    fulfillmentStatus: 'DELIVERED',
    awb: `AWB-${orderNo}`,
    cancelStatus: 'NONE',
    cancelReason: '',
    invoiceNo: '',
    rating: '',
    gstDiscrepancy: 0,
    linesJson: '',
    ...overrides,
  };
}

interface HarnessOpts {
  /** order_no -> deliveredAt ISO timestamp */
  delivered: Record<string, string>;
  phone?: string;
}

async function harness(opts: HarnessOpts) {
  const store = new InMemorySheetStore();
  const phone = opts.phone ?? '919876543210';

  for (const [orderNo, deliveredAt] of Object.entries(opts.delivered)) {
    const awb = `AWB-${orderNo}`;
    await store.appendOrder(order(orderNo, { phone, awb }));
    await store.upsertShipment({ ...baseShipment, orderNo, awb, status: 'DELIVERED', deliveredAt });
  }

  const whatsapp = new StubWhatsAppClient();
  const deps: RatingDeps = {
    store,
    whatsapp,
    templateLang: 'en',
    ratingDelayDays: RATING_DELAY_DAYS,
    judgemeReviewUrl: JUDGEME_URL,
    now: () => NOW,
  };
  const svc = new RatingService(deps);
  return { svc, store, whatsapp, deps };
}

describe('RatingService.sweep', () => {
  it('asks only orders delivered at least the configured number of days ago', async () => {
    const { svc, whatsapp } = await harness({
      delivered: {
        '#old': '2026-09-11T10:00:00.000Z', // 4 days — due
        '#edge': '2026-09-12T10:00:00.000Z', // exactly 3 days — due
        '#new': '2026-09-14T10:00:00.000Z', // 1 day — not due
      },
    });
    expect(await svc.sweep()).toEqual({ sent: 2 });
    expect(whatsapp.sent.map((t) => t.bodyParams[1])).toEqual(['#old', '#edge']);
  });

  it('never asks the same order twice', async () => {
    const { svc } = await harness({ delivered: { '#1042': '2026-09-11T10:00:00.000Z' } });
    await svc.sweep();
    expect(await svc.sweep()).toEqual({ sent: 0 });
  });

  it('consults persisted state, not the service instance, so a fresh process does not re-ask', async () => {
    // Guards against an implementation that tracks "already asked" in a Set on
    // `this` rather than reading it back from the message log — a cron sweep
    // runs as a fresh process invocation every time, so in-memory bookkeeping
    // on the instance would not survive between runs.
    const { store, whatsapp, deps } = await harness({ delivered: { '#1042': '2026-09-11T10:00:00.000Z' } });
    const first = new RatingService(deps);
    await first.sweep();

    const second = new RatingService(deps);
    expect(await second.sweep()).toEqual({ sent: 0 });
    expect(store.messages.filter((m) => m.template === TEMPLATE_RATING)).toHaveLength(1);
  });

  it('logs the sent template so the request can be traced', async () => {
    const { svc, store } = await harness({ delivered: { '#1042': '2026-09-11T10:00:00.000Z' } });
    await svc.sweep();
    expect(store.messages).toEqual([
      expect.objectContaining({ orderNo: '#1042', template: TEMPLATE_RATING, direction: 'out' }),
    ]);
  });

  it('skips a delivered order with no shipment record to read deliveredAt from', async () => {
    const store = new InMemorySheetStore();
    await store.appendOrder(order('#1042', { fulfillmentStatus: 'DELIVERED' }));
    // Deliberately no shipment row upserted.
    const whatsapp = new StubWhatsAppClient();
    const svc = new RatingService({
      store, whatsapp, templateLang: 'en', ratingDelayDays: RATING_DELAY_DAYS,
      judgemeReviewUrl: JUDGEME_URL, now: () => NOW,
    });
    expect(await svc.sweep()).toEqual({ sent: 0 });
    expect(whatsapp.sent).toEqual([]);
  });
});

describe('RatingService.handleRatingReply', () => {
  it('sends the Judge.me link on a 4-5 rating, inside the free service window', async () => {
    const { svc, store, whatsapp } = await harness({ delivered: { '#1042': '2026-09-11T10:00:00.000Z' } });
    await svc.sweep();

    expect(await svc.handleRatingReply('919876543210', '⭐ 4–5')).toBe('stored');
    expect((await store.findOrderByNo('#1042'))?.rating).toBe('4-5');
    expect(whatsapp.textsSent[0]!.body).toContain('https://judge.me/review');
  });

  it('apologises and does not send a review link on a 1-2 rating', async () => {
    const { svc, store, whatsapp } = await harness({ delivered: { '#1042': '2026-09-11T10:00:00.000Z' } });
    await svc.sweep();

    await svc.handleRatingReply('919876543210', '⭐ 1–2');
    expect((await store.findOrderByNo('#1042'))?.rating).toBe('1-2');
    expect(whatsapp.textsSent[0]!.body).not.toContain('judge.me');
    expect(whatsapp.textsSent[0]!.body).toMatch(/sorry/i);
  });

  it('acknowledges a neutral 3 rating without a review link or an apology', async () => {
    const { svc, store, whatsapp } = await harness({ delivered: { '#1042': '2026-09-11T10:00:00.000Z' } });
    await svc.sweep();

    await svc.handleRatingReply('919876543210', '⭐ 3');
    expect((await store.findOrderByNo('#1042'))?.rating).toBe('3');
    expect(whatsapp.textsSent[0]!.body).not.toContain('judge.me');
    expect(whatsapp.textsSent[0]!.body).not.toMatch(/sorry/i);
  });

  it('ignores a rating reply from an unknown phone', async () => {
    const { svc } = await harness({ delivered: {} });
    expect(await svc.handleRatingReply('910000000000', '⭐ 3')).toBe('no_match');
  });

  it('returns no_match for a button label with no recognisable rating digits, without throwing', async () => {
    const { svc } = await harness({ delivered: { '#1042': '2026-09-11T10:00:00.000Z' } });
    await expect(svc.handleRatingReply('919876543210', 'Track Order')).resolves.toBe('no_match');
  });

  it('matches the most recently delivered order when a phone has more than one', async () => {
    // If the lookup picked the first match rather than the latest, this would
    // stamp the wrong (older) order and leave the newer one untouched.
    const { svc, store } = await harness({
      delivered: {
        '#old': '2026-09-05T10:00:00.000Z',
        '#new': '2026-09-11T10:00:00.000Z',
      },
    });
    await svc.sweep();
    await svc.handleRatingReply('919876543210', '⭐ 4–5');
    expect((await store.findOrderByNo('#new'))?.rating).toBe('4-5');
    expect((await store.findOrderByNo('#old'))?.rating).toBe('');
  });

  it.each([
    ['1-2', '1-2'],
    ['⭐ 1–2', '1-2'],
    ['⭐1–2', '1-2'],
    ['3', '3'],
    ['⭐ 3', '3'],
    ['4-5', '4-5'],
    ['⭐ 4–5', '4-5'],
  ])('normalises button text %s to rating bucket %s', async (buttonText, expected) => {
    const { svc, store } = await harness({ delivered: { '#1042': '2026-09-11T10:00:00.000Z' } });
    await svc.sweep();
    expect(await svc.handleRatingReply('919876543210', buttonText)).toBe('stored');
    expect((await store.findOrderByNo('#1042'))?.rating).toBe(expected);
  });
});
