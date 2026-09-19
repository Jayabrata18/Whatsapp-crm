import { describe, it, expect } from 'vitest';
import { ReportingService } from '../../src/services/reporting.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { baseInvoice } from '../fixtures/stage1.js';
import type { InvoiceRow } from '../../src/adapters/sheets.js';
import type { B2csRow } from '../../src/core/b2cs.js';

function inv(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return { ...baseInvoice, ...overrides };
}

/**
 * `InMemorySheetStore.replaceB2csMonth` reads and writes `this.b2cs` in one
 * synchronous statement with no `await` in between, so it can never be caught
 * mid-update by a concurrent call — unlike `GoogleSheetStore.replaceB2csMonth`,
 * which reads the whole range over the network, computes, and only then writes
 * it back, leaving a real gap where another call's write can land in between.
 * This fake reproduces that same read...gap...write shape so the concurrency
 * test below can actually exercise the hazard `ReportingService`'s mutex
 * guards against, rather than relying on an implementation that happens not
 * to have it.
 */
class SlowB2csStore extends InMemorySheetStore {
  override async replaceB2csMonth(month: string, rows: B2csRow[]): Promise<void> {
    const before = this.b2cs; // the "getValues()" read
    await Promise.resolve(); // stands in for the network round trip
    this.b2cs = [...before.filter((row) => row.month !== month), ...rows.map((row) => ({ month, ...row }))];
  }
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
   * The b2cs tab is for direct operator/accountant inspection like every other tab
   * in this store, and `generate` has no memory of prior runs — a double-click or an
   * HTTP retry (Tasks 22/23 expose this over HTTP) makes a repeat call for the same
   * month a realistic event, not a hypothetical one. `replaceB2csMonth` must leave
   * exactly one set of rows for that month behind, not two overlapping sets a human
   * could accidentally sum together.
   */
  it('replaces rather than duplicates on a second call for the same month', async () => {
    const store = new InMemorySheetStore();
    await store.appendInvoiceLines([inv({ invoiceDate: '2026-09-05T00:00:00.000Z' })]);
    const service = new ReportingService({ store, sellerStateCode: '19' });

    await service.generate('2026-09');
    const second = await service.generate('2026-09');

    expect(second.rows).toEqual([{ placeOfSupply: 'KA', rate: 5, taxableValue: 1000, cess: 0, invoiceCount: 1 }]);
    expect(store.b2cs).toEqual([
      { month: '2026-09', placeOfSupply: 'KA', rate: 5, taxableValue: 1000, cess: 0, invoiceCount: 1 },
    ]);
  });

  it('regenerating one month leaves a different month\'s persisted rows untouched', async () => {
    const store = new InMemorySheetStore();
    await store.appendInvoiceLines([
      inv({ invoiceNo: 'UM/26-27/0001', invoiceDate: '2026-08-05T00:00:00.000Z', taxableValue: 700 }),
    ]);
    const service = new ReportingService({ store, sellerStateCode: '19' });
    await service.generate('2026-08');

    await store.appendInvoiceLines([
      inv({ invoiceNo: 'UM/26-27/0002', invoiceDate: '2026-09-05T00:00:00.000Z', taxableValue: 1000 }),
    ]);
    await service.generate('2026-09');
    await service.generate('2026-09'); // a re-run of September must not disturb August

    expect(store.b2cs).toEqual([
      { month: '2026-08', placeOfSupply: 'KA', rate: 5, taxableValue: 700, cess: 0, invoiceCount: 1 },
      { month: '2026-09', placeOfSupply: 'KA', rate: 5, taxableValue: 1000, cess: 0, invoiceCount: 1 },
    ]);
  });

  it('leaves no leftover rows when a regeneration produces fewer buckets than before', async () => {
    const store = new InMemorySheetStore();
    // First run: two states, two buckets.
    await store.appendInvoiceLines([
      inv({ invoiceNo: 'UM/26-27/0001', placeOfSupply: '19', invoiceDate: '2026-09-05T00:00:00.000Z', taxableValue: 500 }),
      inv({ invoiceNo: 'UM/26-27/0002', placeOfSupply: '27', invoiceDate: '2026-09-06T00:00:00.000Z', taxableValue: 2000 }),
    ]);
    const service = new ReportingService({ store, sellerStateCode: '19' });
    await service.generate('2026-09');
    expect(store.b2cs).toHaveLength(2);

    // Second run: one of those invoices is voided, collapsing the report to one bucket.
    await store.voidInvoice('UM/26-27/0002');
    await service.generate('2026-09');

    expect(store.b2cs).toEqual([
      { month: '2026-09', placeOfSupply: '19', rate: 5, taxableValue: 500, cess: 0, invoiceCount: 1 },
    ]);
  });

  /**
   * Neither call is awaited before the other starts — two dashboard tabs calling
   * the report endpoint for different months, or a client retrying one call while
   * the first is still in flight. `replaceB2csMonth` on the real adapter is a
   * read-then-write over the WHOLE b2cs range: without a lock spanning the read
   * and the write, call A's write can land using a snapshot taken before call B's
   * write happened, silently erasing B's month when A's write lands second.
   */
  it('does not lose either month on two genuinely concurrent generate() calls for different months', async () => {
    const store = new SlowB2csStore();
    await store.appendInvoiceLines([
      inv({ invoiceNo: 'UM/26-27/0001', invoiceDate: '2026-08-05T00:00:00.000Z', taxableValue: 700 }),
      inv({ invoiceNo: 'UM/26-27/0002', invoiceDate: '2026-09-05T00:00:00.000Z', taxableValue: 1000 }),
    ]);
    const service = new ReportingService({ store, sellerStateCode: '19' });

    await Promise.all([service.generate('2026-08'), service.generate('2026-09')]);

    expect(store.b2cs.map((row) => row.month).sort()).toEqual(['2026-08', '2026-09']);
  });
});
