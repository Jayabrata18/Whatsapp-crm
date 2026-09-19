import type { InvoiceRow, SheetStore } from '../adapters/sheets.js';
import { rollupB2cs, toB2csCsv, type B2csRow } from '../core/b2cs.js';

export interface ReportingDeps {
  store: SheetStore;
  sellerStateCode: string;
}

/** Builds the monthly GSTR-1 B2CS report from the invoice register. */
export class ReportingService {
  constructor(private readonly deps: ReportingDeps) {}

  async generate(
    month: string,
  ): Promise<{ rows: B2csRow[]; excluded: InvoiceRow[]; csv: string }> {
    const invoices = await this.deps.store.listInvoices();
    const { rows, excluded } = rollupB2cs(invoices, month, this.deps.sellerStateCode);
    const csv = toB2csCsv(rows);
    await this.deps.store.replaceB2csMonth(month, rows);
    return { rows, excluded, csv };
  }
}
