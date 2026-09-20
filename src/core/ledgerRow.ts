export interface LedgerOrderFields {
  orderNo: string; orderDate: string; pincode: string; state: string; posCode: string;
  skus: string; itemAmount: number; shippingCharged: number; grossAmount: number; isCod: boolean;
}

export interface LedgerOutcomeFields {
  taxableValue: number; gstRate: number; gstOnGoods: number; gstOnShipping: number;
  outcome: 'DELIVERED' | 'RTO' | 'CANCELLED'; collectedAmount: number; platformFee: number;
}

/**
 * Ledger columns. A–Q are the hub's. R–V belong to the operator and the hub has no
 * method that can address them. W–Y are formulas so that filling COGS by hand on
 * day three updates EBITDA and PAT without the hub ever revisiting the row.
 */
export const LEDGER_HEADERS = [
  'order_no', 'order_date', 'pincode', 'state', 'pos_code', 'skus',
  'item_amount', 'shipping_charged', 'gross_amount', 'is_cod',        // A–J
  'taxable_value', 'gst_rate', 'gst_on_goods', 'gst_on_shipping',
  'outcome', 'collected_amount', 'platform_fee_5pct',                 // K–Q
  'cod_charges', 'shipping_cost', 'cogs', 'rto_loss', 'notes',        // R–V — OPERATOR
  'net_revenue', 'ebitda', 'pat',                                     // W–Y — formulas
] as const;

/** The hub must never write past this column. */
export const LEDGER_HUB_CEILING = 'Q';

export function ledgerOrderValues(f: LedgerOrderFields): (string | number)[] {
  return [
    f.orderNo, f.orderDate, f.pincode, f.state, f.posCode, f.skus,
    f.itemAmount, f.shippingCharged, f.grossAmount, f.isCod ? 'TRUE' : 'FALSE',
  ];
}

export function ledgerOutcomeValues(f: LedgerOutcomeFields): (string | number)[] {
  return [
    f.taxableValue, f.gstRate, f.gstOnGoods, f.gstOnShipping,
    f.outcome, f.collectedAmount, f.platformFee,
  ];
}

/**
 * Reads one field off a `listLedger()` row. Those rows are loosely typed because they
 * mirror a spreadsheet — every consumer keys off the snake_case column names in
 * `LEDGER_HEADERS`, and every one of them needs the same two coercions.
 */
export function ledgerString(row: Record<string, unknown> | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

export function ledgerNumber(row: Record<string, unknown> | undefined, key: string): number {
  const value = Number(row?.[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function ledgerFormulas(sheetRow: number, corporateTaxPct: number): string[] {
  const r = sheetRow;
  return [
    `=P${r}-M${r}-N${r}-R${r}-U${r}`,        // net_revenue
    `=W${r}-T${r}-S${r}-Q${r}`,              // ebitda
    `=X${r}*(1-${corporateTaxPct / 100})`,   // pat
  ];
}
