import type { InvoiceRow, SheetStore } from '../adapters/sheets.js';
import { rollupB2cs, toB2csCsv, type B2csRow } from '../core/b2cs.js';
import { Mutex } from '../core/mutex.js';

export interface ReportingDeps {
  store: SheetStore;
  sellerStateCode: string;
}

/** Builds the monthly GSTR-1 B2CS report from the invoice register. */
export class ReportingService {
  private readonly mutex = new Mutex();

  constructor(private readonly deps: ReportingDeps) {}

  /**
   * `replaceB2csMonth` on the real adapter is a read-then-write over the whole
   * b2cs range: it reads every row, drops the target month's, and writes the kept
   * rows plus the fresh ones back. Two concurrent `generate()` calls for
   * *different* months — a double-click, or the HTTP retry Task 22/23 will expose
   * this behind — could each read before either writes; whichever write lands
   * second would then overwrite using a snapshot that never saw the other
   * month's rows, silently erasing them. The whole read-rollup-write sequence
   * runs inside a `Mutex` (the same tool `InvoicingService` and
   * `CancellationService.approve()` use) so no second call's read can start
   * until the first call's write has landed; a mutex created per call would
   * lock nothing; a field-level one, shared across calls, actually serialises
   * them, and is sufficient because this service deploys with
   * `--max-instances=1`.
   */
  async generate(
    month: string,
  ): Promise<{ rows: B2csRow[]; excluded: InvoiceRow[]; csv: string }> {
    return this.mutex.run(async () => {
      const invoices = await this.deps.store.listInvoices();
      const { rows, excluded } = rollupB2cs(invoices, month, this.deps.sellerStateCode);
      const csv = toB2csCsv(rows);
      await this.deps.store.replaceB2csMonth(month, rows);
      return { rows, excluded, csv };
    });
  }
}
