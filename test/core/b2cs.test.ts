import { describe, it, expect } from 'vitest';
import { rollupB2cs, toB2csCsv } from '../../src/core/b2cs.js';
import type { InvoiceRow } from '../../src/adapters/sheets.js';

/**
 * Shape fully determined by `InvoiceRow` (Task 8). `invoiceNo` defaults to a fresh
 * value on every call — several tests below rely on that to get genuinely distinct
 * invoices without spelling out a number each time; tests that need two rows to
 * share one invoice pass `invoiceNo` explicitly.
 */
let seq = 0;
function inv(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  seq += 1;
  return {
    invoiceNo: `UM/26-27/${String(seq).padStart(4, '0')}`,
    orderNo: `#${1000 + seq}`,
    invoiceDate: '2026-09-10T00:00:00.000Z',
    placeOfSupply: '19',
    hsn: '6109',
    gstRate: 5,
    taxableValue: 1000,
    cgst: 25,
    sgst: 25,
    igst: 0,
    roundOff: 0,
    invoiceTotal: 1050,
    mediaId: 'media-1',
    status: 'ISSUED',
    ...overrides,
  };
}

describe('rollupB2cs', () => {
  it('groups by place of supply and rate', () => {
    const { rows } = rollupB2cs([
      inv({ placeOfSupply: '19', gstRate: 5, taxableValue: 1000 }),
      inv({ placeOfSupply: '19', gstRate: 5, taxableValue: 500 }),
      inv({ placeOfSupply: '27', gstRate: 18, taxableValue: 2000 }),
    ], '2026-09', '19');

    expect(rows).toEqual([
      { placeOfSupply: '19', rate: 5, taxableValue: 1500, cess: 0, invoiceCount: 2 },
      { placeOfSupply: '27', rate: 18, taxableValue: 2000, cess: 0, invoiceCount: 1 },
    ]);
  });

  it('counts an invoice once even when it contributes rows at two rates', () => {
    const { rows } = rollupB2cs([
      inv({ invoiceNo: 'UM/26-27/0005', placeOfSupply: '19', gstRate: 5, taxableValue: 952.38 }),
      inv({ invoiceNo: 'UM/26-27/0005', placeOfSupply: '19', gstRate: 18, taxableValue: 2542.37 }),
    ], '2026-09', '19');

    expect(rows).toEqual([
      { placeOfSupply: '19', rate: 5, taxableValue: 952.38, cess: 0, invoiceCount: 1 },
      { placeOfSupply: '19', rate: 18, taxableValue: 2542.37, cess: 0, invoiceCount: 1 },
    ]);
  });

  /**
   * Every other fixture in this file gives one bucket at most one row per invoice,
   * so `invoiceCount` and `rows.length` are numerically identical throughout — a
   * `rollupB2cs` that counted rows instead of distinct invoice numbers would still
   * pass every test above. Here two rows sharing one invoiceNo land in the SAME
   * bucket (same place of supply, same rate), which only a `Set<invoiceNo>` count
   * gets right: taxableValue sums both rows, but invoiceCount stays 1.
   */
  it('counts an invoice once even when two of its rows land in the very same bucket', () => {
    const { rows } = rollupB2cs([
      inv({ invoiceNo: 'UM/26-27/0006', placeOfSupply: '19', gstRate: 5, taxableValue: 600 }),
      inv({ invoiceNo: 'UM/26-27/0006', placeOfSupply: '19', gstRate: 5, taxableValue: 400 }),
    ], '2026-09', '19');

    expect(rows).toEqual([
      { placeOfSupply: '19', rate: 5, taxableValue: 1000, cess: 0, invoiceCount: 1 },
    ]);
  });

  it('excludes an inter-state invoice above the B2CL threshold and reports it', () => {
    const big = inv({ placeOfSupply: '27', gstRate: 18, taxableValue: 300_000, invoiceTotal: 354_000 });
    const { rows, excluded } = rollupB2cs(
      [big, inv({ placeOfSupply: '27', gstRate: 18, taxableValue: 1000 })], '2026-09', '19',
    );
    expect(excluded).toEqual([big]);
    expect(rows).toEqual([{ placeOfSupply: '27', rate: 18, taxableValue: 1000, cess: 0, invoiceCount: 1 }]);
  });

  it('excludes every rate row of a B2CL invoice, not just the one that tripped it', () => {
    const lines = [
      inv({ invoiceNo: 'UM/26-27/0009', placeOfSupply: '27', gstRate: 5, taxableValue: 500, invoiceTotal: 354_000 }),
      inv({ invoiceNo: 'UM/26-27/0009', placeOfSupply: '27', gstRate: 18, taxableValue: 299_500, invoiceTotal: 354_000 }),
    ];
    const { rows, excluded } = rollupB2cs(lines, '2026-09', '19');
    expect(rows).toEqual([]);
    expect(excluded).toHaveLength(2);
  });

  it('keeps a large INTRA-state invoice in B2CS — the threshold is inter-state only', () => {
    const big = inv({ placeOfSupply: '19', gstRate: 18, taxableValue: 300_000, invoiceTotal: 354_000 });
    const { rows, excluded } = rollupB2cs([big], '2026-09', '19');
    expect(excluded).toEqual([]);
    expect(rows[0]!.taxableValue).toBe(300_000);
  });

  it('ignores VOID invoices and invoices from other months', () => {
    const { rows } = rollupB2cs([
      inv({ status: 'VOID', taxableValue: 999 }),
      inv({ invoiceDate: '2026-08-04T00:00:00.000Z', taxableValue: 888 }),
      inv({ taxableValue: 100 }),
    ], '2026-09', '19');
    expect(rows).toEqual([{ placeOfSupply: '19', rate: 5, taxableValue: 100, cess: 0, invoiceCount: 1 }]);
  });

  it('returns no rows for a month with no invoices', () => {
    expect(rollupB2cs([], '2026-09', '19').rows).toEqual([]);
  });
});

describe('toB2csCsv', () => {
  it('emits the GST offline tool column order', () => {
    expect(toB2csCsv([{ placeOfSupply: '27', rate: 18, taxableValue: 2000, cess: 0, invoiceCount: 1 }]).split('\n')).toEqual([
      'Type,Place Of Supply,Applicable % of Tax Rate,Rate,Taxable Value,Cess Amount,E-Commerce GSTIN',
      'OE,27,,18,2000,0,',
    ]);
  });

  it('emits only the header row for an empty rollup', () => {
    expect(toB2csCsv([])).toBe(
      'Type,Place Of Supply,Applicable % of Tax Rate,Rate,Taxable Value,Cess Amount,E-Commerce GSTIN',
    );
  });
});
