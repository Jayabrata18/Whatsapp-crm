import { describe, it, expect } from 'vitest';
import {
  GoogleSheetStore,
  effectRowToValues,
  invoiceRowToValues,
  orderRowToValues,
  shipmentRowToValues,
  valuesToOrderRow,
} from '../../src/adapters/googleSheetStore.js';
import type { SheetsApi } from '../../src/adapters/googleSheetStore.js';
import { ORDER_COLUMNS, ORDER_HEADERS, type OrderRow } from '../../src/adapters/sheets.js';
import { ledgerOrderValues, type LedgerOrderFields } from '../../src/core/ledgerRow.js';
import { baseEffect, baseInvoice, baseShipment } from '../fixtures/stage1.js';

function ledgerOrder(overrides: Partial<LedgerOrderFields> = {}): LedgerOrderFields {
  return {
    orderNo: '#1042', orderDate: '2026-09-15', pincode: '700001', state: 'West Bengal',
    posCode: '19', skus: 'TEE-BLK-L x2', itemAmount: 1800, shippingCharged: 99,
    grossAmount: 1899, isCod: true,
    ...overrides,
  };
}

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

class FakeSheetsApi implements SheetsApi {
  tabs: Record<string, unknown[][]> = {
    orders: [],
    messages: [],
    events: [],
    shipments: [],
    invoices: [],
    effects: [],
  };
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
    const [tab, colsPart] = range.split('!');
    const existing = this.tabs[tab!] ?? [];
    // Mirrors real Sheets behaviour: rows land after whatever is already there,
    // and the response range names the actual rows written, not the request range.
    const startRow = existing.length + 1;
    const endRow = startRow + values.length - 1;
    this.tabs[tab!] = [...existing, ...values];
    this.appended.push({ range, values });
    const [startCol, endCol] = (colsPart ?? 'A:A').split(':');
    return { updatedRange: `${tab}!${startCol}${startRow}:${endCol ?? startCol}${endRow}` };
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

  it('round-trips the Stage 1 order columns', () => {
    const row: OrderRow = {
      ...order(),
      fulfillmentStatus: 'SHIPPED',
      awb: 'SF123',
      cancelStatus: 'REVIEW_PENDING',
      cancelReason: 'CUSTOMER_REQUEST',
      invoiceNo: 'UM/26-27/0007',
      rating: '4-5',
      gstDiscrepancy: 0,
    };
    expect(valuesToOrderRow(orderRowToValues(row))).toEqual(row);
  });

  it('maps every OrderRow field to a distinct column', () => {
    const cols = Object.values(ORDER_COLUMNS);
    expect(new Set(cols).size).toBe(cols.length);
    expect(cols.length).toBe(ORDER_HEADERS.length);
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
    expect(api.appended[0]?.range).toBe('orders!A:U');
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

describe('GoogleSheetStore shipments', () => {
  it('appends a new AWB below the header', async () => {
    const api = new FakeSheetsApi();
    api.tabs.shipments = [['header']];
    const store = new GoogleSheetStore(api, 'sheet123');
    await store.upsertShipment(baseShipment);
    expect(api.appended[0]?.range).toBe('shipments!A:L');
    expect(api.appended[0]?.values[0]?.[1]).toBe(baseShipment.awb);
  });

  it('writes only the changed column when the AWB already exists', async () => {
    const api = new FakeSheetsApi();
    api.tabs.shipments = [['header'], shipmentRowToValues(baseShipment)];
    const store = new GoogleSheetStore(api, 'sheet123');
    await store.upsertShipment({ ...baseShipment, status: 'OFD', ofdAt: '2026-09-11T00:00:00.000Z' });
    expect(api.batchUpdated).toEqual([
      { range: 'shipments!D2:D2', values: [['OFD']] },
      { range: 'shipments!F2:F2', values: [['2026-09-11T00:00:00.000Z']] },
    ]);
    expect(api.appended).toHaveLength(0);
  });

  it('finds a shipment by AWB and returns null otherwise', async () => {
    const api = new FakeSheetsApi();
    api.tabs.shipments = [['header'], shipmentRowToValues(baseShipment)];
    const store = new GoogleSheetStore(api, 'sheet123');
    expect((await store.findShipmentByAwb(baseShipment.awb))?.courier).toBe(baseShipment.courier);
    expect(await store.findShipmentByAwb('NOPE')).toBeNull();
  });

  it('lists only non-terminal shipments as open', async () => {
    const api = new FakeSheetsApi();
    api.tabs.shipments = [
      ['header'],
      shipmentRowToValues({ ...baseShipment, awb: 'A', status: 'SHIPPED' }),
      shipmentRowToValues({ ...baseShipment, awb: 'B', status: 'DELIVERED' }),
    ];
    const store = new GoogleSheetStore(api, 'sheet123');
    expect((await store.listOpenShipments()).map((s) => s.awb)).toEqual(['A']);
  });
});

describe('GoogleSheetStore invoices', () => {
  it('appends every line of a mixed-rate invoice in one call', async () => {
    const api = new FakeSheetsApi();
    api.tabs.invoices = [['header']];
    const store = new GoogleSheetStore(api, 'sheet123');
    await store.appendInvoiceLines([
      { ...baseInvoice, invoiceNo: 'UM/26-27/0005', gstRate: 5 },
      { ...baseInvoice, invoiceNo: 'UM/26-27/0005', gstRate: 18 },
    ]);
    expect(api.appended).toHaveLength(1);
    expect(api.appended[0]?.values).toHaveLength(2);
    expect(api.appended[0]?.range).toBe('invoices!A:N');
  });

  it('computes the last sequence for a financial year, counting VOID rows', async () => {
    const api = new FakeSheetsApi();
    api.tabs.invoices = [
      ['header'],
      invoiceRowToValues({ ...baseInvoice, invoiceNo: 'UM/25-26/0009' }),
      invoiceRowToValues({ ...baseInvoice, invoiceNo: 'UM/26-27/0003', status: 'VOID' }),
    ];
    const store = new GoogleSheetStore(api, 'sheet123');
    expect(await store.lastInvoiceSequence('26-27')).toBe(3);
    expect(await store.lastInvoiceSequence('27-28')).toBe(0);
  });

  it('voids every row sharing an invoice number, at their own sheet rows', async () => {
    const api = new FakeSheetsApi();
    api.tabs.invoices = [
      ['header'],
      invoiceRowToValues({ ...baseInvoice, invoiceNo: 'UM/26-27/0006', gstRate: 5 }),
      invoiceRowToValues({ ...baseInvoice, invoiceNo: 'UM/26-27/0007', gstRate: 5 }),
      invoiceRowToValues({ ...baseInvoice, invoiceNo: 'UM/26-27/0006', gstRate: 18 }),
    ];
    const store = new GoogleSheetStore(api, 'sheet123');
    await store.voidInvoice('UM/26-27/0006');
    expect(api.batchUpdated).toEqual([
      { range: 'invoices!N2:N2', values: [['VOID']] },
      { range: 'invoices!N4:N4', values: [['VOID']] },
    ]);
  });
});

describe('GoogleSheetStore effects', () => {
  it('appends an effect below the header', async () => {
    const api = new FakeSheetsApi();
    api.tabs.effects = [['header']];
    const store = new GoogleSheetStore(api, 'sheet123');
    await store.appendEffect(baseEffect);
    expect(api.appended[0]?.range).toBe('effects!A:I');
  });

  it('lists only due PENDING effects', async () => {
    const api = new FakeSheetsApi();
    api.tabs.effects = [
      ['header'],
      effectRowToValues({ ...baseEffect, effectId: 'e1', nextAttemptAt: '2026-09-15T10:00:00.000Z' }),
      effectRowToValues({ ...baseEffect, effectId: 'e2', nextAttemptAt: '2026-09-15T12:00:00.000Z' }),
      effectRowToValues({ ...baseEffect, effectId: 'e3', state: 'DONE', nextAttemptAt: '2026-09-15T10:00:00.000Z' }),
    ];
    const store = new GoogleSheetStore(api, 'sheet123');
    const due = await store.listDueEffects('2026-09-15T11:00:00.000Z');
    expect(due.map((e) => e.effectId)).toEqual(['e1']);
  });

  it('writes only the columns named in the patch', async () => {
    const api = new FakeSheetsApi();
    api.tabs.effects = [['header'], effectRowToValues({ ...baseEffect, effectId: 'e1' })];
    const store = new GoogleSheetStore(api, 'sheet123');
    await store.updateEffect('e1', { state: 'FAILED', attempts: 1, lastError: 'timeout' });
    expect(api.batchUpdated).toEqual([
      { range: 'effects!F2:F2', values: [['FAILED']] },
      { range: 'effects!E2:E2', values: [[1]] },
      { range: 'effects!G2:G2', values: [['timeout']] },
    ]);
  });

  it('does nothing when updating an unknown effect', async () => {
    const api = new FakeSheetsApi();
    api.tabs.effects = [['header']];
    await new GoogleSheetStore(api, 'sheet123').updateEffect('nope', { state: 'DONE' });
    expect(api.batchUpdated).toHaveLength(0);
  });
});

describe('GoogleSheetStore ledger — the operator block (R–V) must be unreachable', () => {
  it('appends A–J, never touching a column past J on the append call', async () => {
    const api = new FakeSheetsApi();
    api.tabs.ledger = [['header']];
    const store = new GoogleSheetStore(api, 'sheet123');
    await store.appendLedgerOrder(ledgerOrder(), 25);
    expect(api.appended).toHaveLength(1);
    expect(api.appended[0]?.range).toBe('ledger!A:J');
    expect(api.appended[0]?.values).toEqual([ledgerOrderValues(ledgerOrder())]);
  });

  it('writes the W–Y formulas at the row the append landed on, as USER_ENTERED', async () => {
    const api = new FakeSheetsApi();
    api.tabs.ledger = [['header']];
    const store = new GoogleSheetStore(api, 'sheet123');
    await store.appendLedgerOrder(ledgerOrder(), 25);
    expect(api.batchUpdated).toEqual([
      {
        range: 'ledger!W2:Y2',
        values: [['=P2-M2-N2-R2-U2', '=W2-T2-S2-Q2', '=X2*(1-0.25)']],
        raw: false,
      },
    ]);
  });

  it('writes the outcome to K–Q only — never R–V, never the whole row', async () => {
    const api = new FakeSheetsApi();
    api.tabs.ledger = [['header'], ledgerOrderValues(ledgerOrder())];
    const store = new GoogleSheetStore(api, 'sheet123');
    await store.updateLedgerOutcome('#1042', {
      taxableValue: 1808.57, gstRate: 5, gstOnGoods: 90.43, gstOnShipping: 0,
      outcome: 'DELIVERED', collectedAmount: 1899, platformFee: 94.95,
    });
    expect(api.batchUpdated).toHaveLength(1);
    const write = api.batchUpdated[0]!;
    expect(write.range).toBe('ledger!K2:Q2');
    // No range this method could ever produce reaches past Q — R (cod_charges)
    // through V (notes) and W–Y (the formulas) stay exclusively hub-unreachable here.
    const [, endCol] = write.range.split(':').map((half) => half.replace(/[!\d]/g, ''));
    expect(endCol).toBe('Q');
  });

  it('does nothing when the order has no ledger row yet', async () => {
    const api = new FakeSheetsApi();
    api.tabs.ledger = [['header']];
    const store = new GoogleSheetStore(api, 'sheet123');
    await store.updateLedgerOutcome('#9999', {
      taxableValue: 0, gstRate: 0, gstOnGoods: 0, gstOnShipping: 0,
      outcome: 'CANCELLED', collectedAmount: 0, platformFee: 0,
    });
    expect(api.batchUpdated).toHaveLength(0);
  });

  it('has no method capable of writing a whole ledger row', () => {
    expect(
      (GoogleSheetStore.prototype as unknown as Record<string, unknown>).updateLedgerRow,
    ).toBeUndefined();
    expect(
      (GoogleSheetStore.prototype as unknown as Record<string, unknown>).updateLedger,
    ).toBeUndefined();
  });

  it('lists ledger rows keyed by header name', async () => {
    const api = new FakeSheetsApi();
    api.tabs.ledger = [['header'], ledgerOrderValues(ledgerOrder())];
    const store = new GoogleSheetStore(api, 'sheet123');
    const rows = await store.listLedger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ order_no: '#1042', pos_code: '19' });
  });
});
