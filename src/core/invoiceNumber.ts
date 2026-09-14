const IST_OFFSET_MINUTES = 330;

/** Indian financial year (April–March) for a moment in time, as `YY-YY`. */
export function financialYear(date: Date): string {
  const ist = new Date(date.getTime() + IST_OFFSET_MINUTES * 60_000);
  const year = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? year : year - 1;
  const pad = (y: number) => String(y % 100).padStart(2, '0');
  return `${pad(start)}-${pad(start + 1)}`;
}

export function formatInvoiceNumber(prefix: string, fy: string, seq: number): string {
  return `${prefix}/${fy}/${String(seq).padStart(4, '0')}`;
}

export function parseSequence(invoiceNo: string): number {
  const tail = invoiceNo.split('/').at(-1) ?? '';
  const parsed = Number.parseInt(tail, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
