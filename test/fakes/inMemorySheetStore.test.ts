import { describe, it, expect } from 'vitest';
import { InMemorySheetStore } from './inMemorySheetStore.js';
import type { OrderRow } from '../../src/adapters/sheets.js';

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
    confirmStatus: 'PENDING',
    paymentLink: '',
    createdAt: '2026-08-16T10:00:00.000Z',
    confirmedAt: '',
    paidAt: '',
    ...overrides,
  };
}

describe('InMemorySheetStore', () => {
  it('appends and lists orders', async () => {
    const store = new InMemorySheetStore();
    await store.appendOrder(order());
    expect(await store.listOrders()).toHaveLength(1);
  });

  it('finds an order by number and returns null for an unknown one', async () => {
    const store = new InMemorySheetStore();
    await store.appendOrder(order());
    expect((await store.findOrderByNo('#1042'))?.orderId).toBe('5544332211');
    expect(await store.findOrderByNo('#9999')).toBeNull();
  });

  it('patches an order without disturbing other fields', async () => {
    const store = new InMemorySheetStore();
    await store.appendOrder(order());
    await store.updateOrder('#1042', { confirmStatus: 'CONFIRMED', confirmedAt: 'now' });
    const updated = await store.findOrderByNo('#1042');
    expect(updated?.confirmStatus).toBe('CONFIRMED');
    expect(updated?.confirmedAt).toBe('now');
    expect(updated?.amount).toBe(1899);
  });

  it('returns the most recent PENDING order for a phone', async () => {
    const store = new InMemorySheetStore();
    await store.appendOrder(order({ orderNo: '#1001', createdAt: '2026-08-14T10:00:00.000Z' }));
    await store.appendOrder(order({ orderNo: '#1042', createdAt: '2026-08-16T10:00:00.000Z' }));
    expect((await store.findLatestPendingByPhone('919876543210'))?.orderNo).toBe('#1042');
  });

  it('ignores non-PENDING orders when matching by phone', async () => {
    const store = new InMemorySheetStore();
    await store.appendOrder(order({ orderNo: '#1042', confirmStatus: 'PAID_EARLY' }));
    expect(await store.findLatestPendingByPhone('919876543210')).toBeNull();
  });

  it('does not match a different phone', async () => {
    const store = new InMemorySheetStore();
    await store.appendOrder(order());
    expect(await store.findLatestPendingByPhone('919000000000')).toBeNull();
  });

  it('records and detects events per source', async () => {
    const store = new InMemorySheetStore();
    expect(await store.hasEvent('shopify', '5544332211')).toBe(false);
    await store.recordEvent('shopify', '5544332211');
    expect(await store.hasEvent('shopify', '5544332211')).toBe(true);
    expect(await store.hasEvent('meta', '5544332211')).toBe(false);
  });

  it('updates a message status by wamid', async () => {
    const store = new InMemorySheetStore();
    await store.appendMessage({
      orderNo: '#1042',
      template: 'order_confirm_cod',
      wamid: 'wamid.AAA',
      direction: 'out',
      status: 'sent',
      timestamp: '2026-08-16T10:00:00.000Z',
    });
    await store.updateMessageStatus('wamid.AAA', 'delivered');
    expect(store.messages[0]?.status).toBe('delivered');
  });

  it('ignores a status update for an unknown wamid', async () => {
    const store = new InMemorySheetStore();
    await expect(store.updateMessageStatus('wamid.NOPE', 'read')).resolves.toBeUndefined();
  });
});
