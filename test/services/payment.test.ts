import { describe, it, expect, beforeEach } from 'vitest';
import { PaymentService } from '../../src/services/payment.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { StubOrderTagger } from '../fakes/stubClients.js';
import type { OrderRow } from '../../src/adapters/sheets.js';

const NOW = new Date('2026-08-16T13:00:00.000Z');

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    orderNo: '#1042',
    orderId: '5544332211',
    customerName: 'Aarav',
    phone: '919876543210',
    amount: 1899,
    codFee: 50,
    payable: 1849,
    isCod: true,
    confirmStatus: 'CONFIRMED',
    paymentLink: 'https://cf.test/links/urbnmyth-1042',
    createdAt: '2026-08-16T10:00:00.000Z',
    confirmedAt: '2026-08-16T12:00:00.000Z',
    paidAt: '',
    fulfillmentStatus: 'NEW',
    awb: '',
    cancelStatus: 'NONE',
    cancelReason: '',
    invoiceNo: '',
    rating: '',
    gstDiscrepancy: 0,
    ...overrides,
  };
}

function successPayload(linkId = 'urbnmyth-1042', cfOrderId = 'cf-order-99') {
  return {
    type: 'PAYMENT_LINK_EVENT',
    data: {
      link_id: linkId,
      link_status: 'PAID',
      link_amount_paid: 1849,
      order: { order_id: cfOrderId },
    },
  };
}

function build() {
  const store = new InMemorySheetStore();
  const tagger = new StubOrderTagger();
  const service = new PaymentService({ store, tagger, now: () => NOW });
  return { store, tagger, service };
}

describe('PaymentService', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(async () => {
    ctx = build();
    await ctx.store.appendOrder(order());
  });

  it('marks the order PAID_EARLY and stamps paidAt', async () => {
    expect(await ctx.service.handle(successPayload())).toBe('paid');
    const row = await ctx.store.findOrderByNo('#1042');
    expect(row?.confirmStatus).toBe('PAID_EARLY');
    expect(row?.paidAt).toBe(NOW.toISOString());
  });

  it('tags the Shopify order paid-early', async () => {
    await ctx.service.handle(successPayload());
    expect(ctx.tagger.tagged).toEqual([{ orderId: '5544332211', tag: 'paid-early' }]);
  });

  it('still marks the order paid when Shopify tagging throws', async () => {
    ctx.tagger.failWith = new Error('Shopify 500');
    expect(await ctx.service.handle(successPayload())).toBe('paid');
    expect((await ctx.store.findOrderByNo('#1042'))?.confirmStatus).toBe('PAID_EARLY');
  });

  it('ignores a duplicate webhook for the same link', async () => {
    await ctx.service.handle(successPayload());
    expect(await ctx.service.handle(successPayload())).toBe('duplicate');
    expect(ctx.tagger.tagged).toHaveLength(1);
  });

  it('ignores a non-PAID link status', async () => {
    const pending = {
      ...successPayload(),
      data: { ...successPayload().data, link_status: 'PARTIALLY_PAID' },
    };
    expect(await ctx.service.handle(pending)).toBe('ignored');
    expect((await ctx.store.findOrderByNo('#1042'))?.confirmStatus).toBe('CONFIRMED');
  });

  it('ignores a payload with no link id', async () => {
    expect(await ctx.service.handle({ type: 'PAYMENT_LINK_EVENT', data: {} })).toBe('ignored');
  });

  it('returns no_match for a link id with no matching order', async () => {
    expect(await ctx.service.handle(successPayload('urbnmyth-9999'))).toBe('no_match');
  });

  it('does not downgrade an order that is already PAID_EARLY', async () => {
    await ctx.store.updateOrderFields('#1042', { confirmStatus: 'PAID_EARLY', paidAt: 'earlier' });
    // A different Cashfree order id, so this is not caught by the event ledger.
    const result = await ctx.service.handle(successPayload('urbnmyth-1042', 'cf-order-100'));
    expect(result).toBe('duplicate');
    expect((await ctx.store.findOrderByNo('#1042'))?.paidAt).toBe('earlier');
  });
});
