import { describe, it, expect } from 'vitest';
import {
  GoogleSheetStore,
  orderRowToValues,
  valuesToOrderRow,
} from '../../src/adapters/googleSheetStore.js';
import type { SheetsApi } from '../../src/adapters/googleSheetStore.js';
import { ORDER_HEADERS, type OrderRow } from '../../src/adapters/sheets.js';

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

class FakeSheetsApi implements SheetsApi {
  tabs: Record<string, unknown[][]> = { orders: [], messages: [], events: [] };
  appended: Array<{ range: string; values: unknown[][] }> = [];
  updated: Array<{ range: string; values: unknown[][] }> = [];
  batchUpdated: Array<{ range: string; values: unknown[][]; raw?: boolean }> = [];

  async getValues(_sheetId: string, range: string): Promise<unknown[][]> {
    const tab = range.split('!')[0]!;
    return this.tabs[tab] ?? [];
  }

  async appendValues(
    _sheetId: string,
    range: string,
    values: unknown[][],
  ): Promise<{ updatedRange: string }> {
    const tab = range.split('!')[0]!;
    this.tabs[tab] = [...(this.tabs[tab] ?? []), ...values];
    this.appended.push({ range, values });
    return { updatedRange: range };
  }

  async updateValues(_sheetId: string, range: string, values: unknown[][]): Promise<void> {
    this.updated.push({ range, values });
  }

  async batchUpdateValues(
    _sheetId: string,
    data: Array<{ range: string; values: unknown[][]; raw?: boolean }>,
  ): Promise<void> {
    this.batchUpdated.push(...data);
  }
}

describe('row serialization', () => {
  it('round-trips an order row', () => {
    const original = order({ paymentLink: 'https://cf.link/abc', confirmedAt: 'x' });
    expect(valuesToOrderRow(orderRowToValues(original))).toEqual(original);
  });

  it('coerces sheet string values back to the right types', () => {
    const values = [
      '#1042',
      '5544332211',
      'Aarav',
      '919876543210',
      '1899',
      '50',
      '1849',
      'TRUE',
      'PENDING',
      '',
      '2026-08-16T10:00:00.000Z',
      '',
      '',
    ];
    const row = valuesToOrderRow(values);
    expect(row.amount).toBe(1899);
    expect(row.payable).toBe(1849);
    expect(row.isCod).toBe(true);
  });

  it('treats a short row from the sheet as empty trailing fields', () => {
    const row = valuesToOrderRow([
      '#1042',
      '5544332211',
      'Aarav',
      '919876543210',
      '1899',
      '50',
      '1849',
      'FALSE',
      'PENDING',
    ]);
    expect(row.paymentLink).toBe('');
    expect(row.paidAt).toBe('');
    expect(row.isCod).toBe(false);
  });
});

describe('GoogleSheetStore', () => {
  it('appends an order below the header row', async () => {
    const api = new FakeSheetsApi();
    const store = new GoogleSheetStore(api, 'sheet123');
    await store.appendOrder(order());
    expect(api.appended[0]?.range).toBe('orders!A:M');
    expect(api.appended[0]?.values[0]?.[0]).toBe('#1042');
  });

  it('lists orders and skips the header row', async () => {
    const api = new FakeSheetsApi();
    api.tabs.orders = [
      [
        'order_no',
        'order_id',
        'customer_name',
        'phone',
        'amount',
        'cod_fee',
        'payable',
        'is_cod',
        'confirm_status',
        'payment_link',
        'created_at',
        'confirmed_at',
        'paid_at',
      ],
      orderRowToValues(order()),
    ];
    const store = new GoogleSheetStore(api, 'sheet123');
    const orders = await store.listOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]?.orderNo).toBe('#1042');
  });

  it('returns an empty list when the tab holds only a header', async () => {
    const api = new FakeSheetsApi();
    api.tabs.orders = [['order_no']];
    expect(await new GoogleSheetStore(api, 'sheet123').listOrders()).toEqual([]);
  });

  it('updates the correct 1-indexed row, accounting for the header', async () => {
    const api = new FakeSheetsApi();
    api.tabs.orders = [
      ['header'],
      orderRowToValues(order({ orderNo: '#1001' })),
      orderRowToValues(order()),
    ];
    const store = new GoogleSheetStore(api, 'sheet123');
    await store.updateOrderFields('#1042', { confirmStatus: 'CONFIRMED' });
    // header is row 1, #1001 is row 2, #1042 is row 3
    expect(api.batchUpdated).toEqual([{ range: 'orders!I3:I3', values: [['CONFIRMED']] }]);
  });

  it('does nothing when updating an unknown order', async () => {
    const api = new FakeSheetsApi();
    api.tabs.orders = [['header']];
    await new GoogleSheetStore(api, 'sheet123').updateOrderFields('#9999', {
      confirmStatus: 'CONFIRMED',
    });
    expect(api.batchUpdated).toHaveLength(0);
  });

  it('records and detects events', async () => {
    const api = new FakeSheetsApi();
    api.tabs.events = [['source', 'external_id', 'received_at']];
    const store = new GoogleSheetStore(api, 'sheet123');
    expect(await store.hasEvent('shopify', '55443')).toBe(false);
    await store.recordEvent('shopify', '55443');
    expect(await store.hasEvent('shopify', '55443')).toBe(true);
    expect(await store.hasEvent('meta', '55443')).toBe(false);
  });

  it('finds the latest PENDING order for a phone', async () => {
    const api = new FakeSheetsApi();
    api.tabs.orders = [
      ['header'],
      orderRowToValues(order({ orderNo: '#1001', createdAt: '2026-08-14T10:00:00.000Z' })),
      orderRowToValues(order({ orderNo: '#1042', createdAt: '2026-08-16T10:00:00.000Z' })),
      orderRowToValues(
        order({
          orderNo: '#1050',
          confirmStatus: 'PAID_EARLY',
          createdAt: '2026-08-17T10:00:00.000Z',
        }),
      ),
    ];
    const store = new GoogleSheetStore(api, 'sheet123');
    expect((await store.findLatestPendingByPhone('919876543210'))?.orderNo).toBe('#1042');
  });

  it('updates a message status at the right row', async () => {
    const api = new FakeSheetsApi();
    api.tabs.messages = [
      ['order_no', 'template', 'wamid', 'direction', 'status', 'timestamp'],
      ['#1042', 'order_confirm_cod', 'wamid.AAA', 'out', 'sent', '2026-08-16T10:00:00.000Z'],
    ];
    const store = new GoogleSheetStore(api, 'sheet123');
    await store.updateMessageStatus('wamid.AAA', 'delivered');
    expect(api.updated[0]?.range).toBe('messages!E2:E2');
    expect(api.updated[0]?.values).toEqual([['delivered']]);
  });

  it('ignores a status update for an unknown wamid', async () => {
    const api = new FakeSheetsApi();
    api.tabs.messages = [['header']];
    await new GoogleSheetStore(api, 'sheet123').updateMessageStatus('wamid.NOPE', 'read');
    expect(api.updated).toHaveLength(0);
  });

  it('writes only the columns named in the patch', async () => {
    const writes: Array<{ range: string; values: unknown[][] }> = [];
    const api: SheetsApi = {
      async getValues() {
        return [
          [...ORDER_HEADERS],
          ['#1042', '99', 'Aarav', '919876543210', 1899, 50, 1849,
           'TRUE', 'PENDING', '', '2026-09-01T00:00:00.000Z', '', ''],
        ];
      },
      async appendValues() { return { updatedRange: 'orders!A2:S2' }; },
      async updateValues() { throw new Error('updateValues must not be used'); },
      async batchUpdateValues(_id, data) { writes.push(...data.map((d) => ({ range: d.range, values: d.values }))); },
    };
    const store = new GoogleSheetStore(api, 'sheet-1');

    await store.updateOrderFields('#1042', { confirmStatus: 'CONFIRMED', confirmedAt: '2026-09-02T00:00:00.000Z' });

    expect(writes).toEqual([
      { range: 'orders!I2:I2', values: [['CONFIRMED']] },
      { range: 'orders!L2:L2', values: [['2026-09-02T00:00:00.000Z']] },
    ]);
  });

  it('has no method capable of writing a whole order row', () => {
    expect(
      (GoogleSheetStore.prototype as unknown as Record<string, unknown>).updateOrder,
    ).toBeUndefined();
  });
});
