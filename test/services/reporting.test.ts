import { describe, it, expect } from 'vitest';
import { ReportingService } from '../../src/services/reporting.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { baseInvoice } from '../fixtures/stage1.js';
import type { InvoiceRow } from '../../src/adapters/sheets.js';

function inv(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return { ...baseInvoice, ...overrides };
}

const B2CS_HEADER = 'Type,Place Of Supply,Applicable % of Tax Rate,Rate,Taxable Value,Cess Amount,E-Commerce GSTIN';

describe('ReportingService.generate', () => {
  it('rolls up the month, returns the CSV, and persists the rows to the b2cs tab', async () => {
    const store = new InMemorySheetStore();
    await store.appendInvoiceLines([
      inv({
        invoiceNo: 'UM/26-27/0001', placeOfSupply: '19', gstRate: 5,
        taxableValue: 1000, invoiceDate: '2026-09-05T00:00:00.000Z',
      }),
      inv({
        invoiceNo: 'UM/26-27/0002', placeOfSupply: '27', gstRate: 18,
        taxableValue: 2000, invoiceDate: '2026-09-06T00:00:00.000Z',
      }),
      // Different month — must not leak into the September rollup.
      inv({
        invoiceNo: 'UM/26-27/0003', placeOfSupply: '19', gstRate: 5,
        taxableValue: 500, invoiceDate: '2026-08-20T00:00:00.000Z',
      }),
    ]);

    const service = new ReportingService({ store, sellerStateCode: '19' });
    const result = await service.generate('2026-09');

    expect(result.rows).toEqual([
      { placeOfSupply: '19', rate: 5, taxableValue: 1000, cess: 0, invoiceCount: 1 },
      { placeOfSupply: '27', rate: 18, taxableValue: 2000, cess: 0, invoiceCount: 1 },
    ]);
    expect(result.excluded).toEqual([]);
    expect(result.csv.split('\n')).toEqual([
      B2CS_HEADER,
      'OE,19,,5,1000,0,',
      'OE,27,,18,2000,0,',
    ]);
    expect(store.b2cs).toEqual([
      { month: '2026-09', placeOfSupply: '19', rate: 5, taxableValue: 1000, cess: 0, invoiceCount: 1 },
      { month: '2026-09', placeOfSupply: '27', rate: 18, taxableValue: 2000, cess: 0, invoiceCount: 1 },
    ]);
  });

  it('returns a header-only CSV and writes nothing for a month with no invoices', async () => {
    const store = new InMemorySheetStore();
    const service = new ReportingService({ store, sellerStateCode: '19' });

    const result = await service.generate('2026-09');

    expect(result.rows).toEqual([]);
    expect(result.excluded).toEqual([]);
    expect(result.csv).toBe(B2CS_HEADER);
    expect(store.b2cs).toEqual([]);
  });

  it('flags a B2CL invoice in `excluded` instead of silently filing it under B2CS', async () => {
    const store = new InMemorySheetStore();
    await store.appendInvoiceLines([
      inv({
        invoiceNo: 'UM/26-27/0009', placeOfSupply: '27', gstRate: 18,
        taxableValue: 300_000, invoiceTotal: 354_000, invoiceDate: '2026-09-05T00:00:00.000Z',
      }),
    ]);

    const service = new ReportingService({ store, sellerStateCode: '19' });
    const result = await service.generate('2026-09');

    expect(result.rows).toEqual([]);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]?.invoiceNo).toBe('UM/26-27/0009');
    expect(store.b2cs).toEqual([]);
  });

  /**
   * `generate` has no memory of prior runs, and the b2cs tab is append-only like
   * every other tab this store writes — so regenerating a month before filing
   * appends a second copy of that month's rows rather than replacing the first.
   * The CSV returned to the caller is always freshly computed from `listInvoices()`,
   * so it stays correct either way; this test documents (rather than silently
   * hides) the one place a second call has a visible effect.
   */
  it('appends again on a second call for the same month, rather than replacing', async () => {
    const store = new InMemorySheetStore();
    await store.appendInvoiceLines([inv({ invoiceDate: '2026-09-05T00:00:00.000Z' })]);
    const service = new ReportingService({ store, sellerStateCode: '19' });

    await service.generate('2026-09');
    const second = await service.generate('2026-09');

    expect(second.rows).toEqual([{ placeOfSupply: 'KA', rate: 5, taxableValue: 1000, cess: 0, invoiceCount: 1 }]);
    expect(store.b2cs).toHaveLength(2);
  });
});
