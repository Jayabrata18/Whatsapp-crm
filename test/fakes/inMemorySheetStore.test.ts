import { describe, it, expect } from 'vitest';
import { InMemorySheetStore } from './inMemorySheetStore.js';
import type { OrderRow } from '../../src/adapters/sheets.js';
import { baseEffect, baseInvoice, baseShipment } from '../fixtures/stage1.js';

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
    fulfillmentStatus: 'NEW',
    awb: '',
    cancelStatus: 'NONE',
    cancelReason: '',
    invoiceNo: '',
    rating: '',
    gstDiscrepancy: 0,
    linesJson: '',
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
    await store.updateOrderFields('#1042', { confirmStatus: 'CONFIRMED', confirmedAt: 'now' });
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

  it('upserts a shipment by AWB rather than appending a duplicate', async () => {
    const store = new InMemorySheetStore();
    await store.upsertShipment({ ...baseShipment, awb: 'SF1', status: 'SHIPPED' });
    await store.upsertShipment({ ...baseShipment, awb: 'SF1', status: 'OFD' });
    expect(store.shipments).toHaveLength(1);
    expect((await store.findShipmentByAwb('SF1'))?.status).toBe('OFD');
  });

  it('lists only non-terminal shipments as open', async () => {
    const store = new InMemorySheetStore();
    await store.upsertShipment({ ...baseShipment, awb: 'A', status: 'SHIPPED' });
    await store.upsertShipment({ ...baseShipment, awb: 'B', status: 'DELIVERED' });
    await store.upsertShipment({ ...baseShipment, awb: 'C', status: 'RTO_RETURNED' });
    expect((await store.listOpenShipments()).map((s) => s.awb)).toEqual(['A']);
  });

  it('returns null for an unknown AWB', async () => {
    const store = new InMemorySheetStore();
    expect(await store.findShipmentByAwb('NOPE')).toBeNull();
  });

  it('returns the last invoice sequence for a financial year, ignoring other years', async () => {
    const store = new InMemorySheetStore();
    await store.appendInvoiceLines([{ ...baseInvoice, invoiceNo: 'UM/25-26/0009' }]);
    await store.appendInvoiceLines([{ ...baseInvoice, invoiceNo: 'UM/26-27/0003' }]);
    expect(await store.lastInvoiceSequence('26-27')).toBe(3);
    expect(await store.lastInvoiceSequence('27-28')).toBe(0);
  });

  it('counts a VOID invoice as consuming its sequence', async () => {
    const store = new InMemorySheetStore();
    await store.appendInvoiceLines([{ ...baseInvoice, invoiceNo: 'UM/26-27/0004', status: 'VOID' }]);
    expect(await store.lastInvoiceSequence('26-27')).toBe(4);
  });

  it('stores one row per rate for a mixed-rate invoice, not one per invoice', async () => {
    const store = new InMemorySheetStore();
    await store.appendInvoiceLines([
      { ...baseInvoice, invoiceNo: 'UM/26-27/0005', gstRate: 5, taxableValue: 952.38 },
      { ...baseInvoice, invoiceNo: 'UM/26-27/0005', gstRate: 18, taxableValue: 2542.37 },
    ]);
    expect(await store.listInvoices()).toHaveLength(2);
    expect(await store.lastInvoiceSequence('26-27')).toBe(5); // one number, not two
  });

  it('voids every row sharing an invoice number', async () => {
    const store = new InMemorySheetStore();
    await store.appendInvoiceLines([
      { ...baseInvoice, invoiceNo: 'UM/26-27/0006', gstRate: 5 },
      { ...baseInvoice, invoiceNo: 'UM/26-27/0006', gstRate: 18 },
      { ...baseInvoice, invoiceNo: 'UM/26-27/0007', gstRate: 5 },
    ]);
    await store.voidInvoice('UM/26-27/0006');
    const invoices = await store.listInvoices();
    expect(invoices.filter((i) => i.invoiceNo === 'UM/26-27/0006').every((i) => i.status === 'VOID')).toBe(true);
    expect(invoices.find((i) => i.invoiceNo === 'UM/26-27/0007')?.status).toBe('ISSUED');
  });

  it('returns only effects whose next attempt is due', async () => {
    const store = new InMemorySheetStore();
    await store.appendEffect({ ...baseEffect, effectId: 'e1', nextAttemptAt: '2026-09-15T10:00:00.000Z' });
    await store.appendEffect({ ...baseEffect, effectId: 'e2', nextAttemptAt: '2026-09-15T12:00:00.000Z' });
    await store.appendEffect({ ...baseEffect, effectId: 'e3', state: 'DONE', nextAttemptAt: '2026-09-15T10:00:00.000Z' });
    expect((await store.listDueEffects('2026-09-15T11:00:00.000Z')).map((e) => e.effectId)).toEqual(['e1']);
  });

  it('patches an effect without disturbing other fields', async () => {
    const store = new InMemorySheetStore();
    await store.appendEffect({ ...baseEffect, effectId: 'e1' });
    await store.updateEffect('e1', { state: 'FAILED', attempts: 1, lastError: 'timeout' });
    const [effect] = await store.listDueEffects('2100-01-01T00:00:00.000Z');
    expect(effect).toBeUndefined(); // FAILED is not due
    expect(store.effects[0]).toMatchObject({ state: 'FAILED', attempts: 1, lastError: 'timeout', orderNo: baseEffect.orderNo });
  });

  it('does nothing when updating an unknown effect', async () => {
    const store = new InMemorySheetStore();
    await expect(store.updateEffect('nope', { state: 'DONE' })).resolves.toBeUndefined();
  });

  it('replaces a month\'s b2cs rows rather than appending a duplicate set', async () => {
    const store = new InMemorySheetStore();
    await store.replaceB2csMonth('2026-09', [
      { placeOfSupply: '19', rate: 5, taxableValue: 1000, cess: 0, invoiceCount: 1 },
    ]);
    await store.replaceB2csMonth('2026-09', [
      { placeOfSupply: '27', rate: 18, taxableValue: 2000, cess: 0, invoiceCount: 1 },
    ]);
    expect(await store.listB2cs()).toEqual([
      { month: '2026-09', placeOfSupply: '27', rate: 18, taxableValue: 2000, cess: 0, invoiceCount: 1 },
    ]);
  });

  it('leaves a different month\'s b2cs rows alone', async () => {
    const store = new InMemorySheetStore();
    await store.replaceB2csMonth('2026-08', [
      { placeOfSupply: '19', rate: 5, taxableValue: 500, cess: 0, invoiceCount: 1 },
    ]);
    await store.replaceB2csMonth('2026-09', [
      { placeOfSupply: '27', rate: 18, taxableValue: 2000, cess: 0, invoiceCount: 1 },
    ]);
    expect((await store.listB2cs()).map((row) => row.month).sort()).toEqual(['2026-08', '2026-09']);
  });
});
