import { google } from 'googleapis';
import { isTerminal } from '../core/shipmentState.js';
import { parseSequence } from '../core/invoiceNumber.js';
import {
  LEDGER_HEADERS,
  LEDGER_HUB_CEILING,
  ledgerFormulas,
  ledgerOrderValues,
  ledgerOutcomeValues,
  type LedgerOrderFields,
  type LedgerOutcomeFields,
} from '../core/ledgerRow.js';
import {
  EFFECT_COLUMNS,
  INVOICE_COLUMNS,
  ORDER_COLUMNS,
  SHIPMENT_COLUMNS,
  type EffectRow,
  type EventSource,
  type InvoiceRow,
  type MessageRow,
  type OrderRow,
  type ShipmentRow,
  type SheetStore,
} from './sheets.js';

/**
 * The narrow slice of the Sheets API this adapter needs. Hand-rolled rather
 * than the full `googleapis` type so the adapter is testable with a plain
 * object and the Google SDK stays out of the test suite entirely.
 */
export interface SheetsApi {
  getValues(sheetId: string, range: string): Promise<unknown[][]>;
  appendValues(sheetId: string, range: string, values: unknown[][]): Promise<{ updatedRange: string }>;
  updateValues(sheetId: string, range: string, values: unknown[][]): Promise<void>;
  batchUpdateValues(
    sheetId: string,
    data: Array<{ range: string; values: unknown[][]; raw?: boolean }>,
  ): Promise<void>;
}

const ORDERS_RANGE = 'orders!A:U';
const MESSAGES_RANGE = 'messages!A:F';
const EVENTS_RANGE = 'events!A:C';
const SHIPMENTS_RANGE = 'shipments!A:L';
const INVOICES_RANGE = 'invoices!A:N';
const EFFECTS_RANGE = 'effects!A:I';
const LEDGER_APPEND_RANGE = 'ledger!A:J';
const LEDGER_LOOKUP_RANGE = 'ledger!A:A';

export function orderRowToValues(row: OrderRow): (string | number | boolean)[] {
  return [
    row.orderNo,
    row.orderId,
    row.customerName,
    row.phone,
    row.amount,
    row.codFee,
    row.payable,
    row.isCod ? 'TRUE' : 'FALSE',
    row.confirmStatus,
    row.paymentLink,
    row.createdAt,
    row.confirmedAt,
    row.paidAt,
    row.fulfillmentStatus,
    row.awb,
    row.cancelStatus,
    row.cancelReason,
    row.invoiceNo,
    row.rating,
    row.gstDiscrepancy,
    row.linesJson,
  ];
}

function str(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function valuesToOrderRow(values: unknown[]): OrderRow {
  return {
    orderNo: str(values[0]),
    orderId: str(values[1]),
    customerName: str(values[2]),
    phone: str(values[3]),
    amount: num(values[4]),
    codFee: num(values[5]),
    payable: num(values[6]),
    isCod: str(values[7]).toUpperCase() === 'TRUE',
    confirmStatus: (str(values[8]) || 'PENDING') as OrderRow['confirmStatus'],
    paymentLink: str(values[9]),
    createdAt: str(values[10]),
    confirmedAt: str(values[11]),
    paidAt: str(values[12]),
    fulfillmentStatus: (str(values[13]) || 'NEW') as OrderRow['fulfillmentStatus'],
    awb: str(values[14]),
    cancelStatus: (str(values[15]) || 'NONE') as OrderRow['cancelStatus'],
    cancelReason: str(values[16]),
    invoiceNo: str(values[17]),
    rating: str(values[18]),
    gstDiscrepancy: num(values[19]),
    linesJson: str(values[20]),
  };
}

function messageRowToValues(row: MessageRow): string[] {
  return [row.orderNo, row.template, row.wamid, row.direction, row.status, row.timestamp];
}

function valuesToMessageRow(values: unknown[]): MessageRow {
  return {
    orderNo: str(values[0]),
    template: str(values[1]),
    wamid: str(values[2]),
    direction: (str(values[3]) || 'out') as MessageRow['direction'],
    status: str(values[4]),
    timestamp: str(values[5]),
  };
}

export function shipmentRowToValues(row: ShipmentRow): (string | number)[] {
  return [
    row.orderNo,
    row.awb,
    row.courier,
    row.status,
    row.shippedAt,
    row.ofdAt,
    row.deliveredAt,
    row.rtoInitiatedAt,
    row.rtoReturnedAt,
    row.lastSyncedAt,
    row.rawStatus,
    row.rtoRestockedAt,
  ];
}

export function valuesToShipmentRow(values: unknown[]): ShipmentRow {
  return {
    orderNo: str(values[0]),
    awb: str(values[1]),
    courier: str(values[2]),
    status: (str(values[3]) || 'NEW') as ShipmentRow['status'],
    shippedAt: str(values[4]),
    ofdAt: str(values[5]),
    deliveredAt: str(values[6]),
    rtoInitiatedAt: str(values[7]),
    rtoReturnedAt: str(values[8]),
    lastSyncedAt: str(values[9]),
    rawStatus: str(values[10]),
    rtoRestockedAt: str(values[11]),
  };
}

export function invoiceRowToValues(row: InvoiceRow): (string | number)[] {
  return [
    row.invoiceNo,
    row.orderNo,
    row.invoiceDate,
    row.placeOfSupply,
    row.hsn,
    row.gstRate,
    row.taxableValue,
    row.cgst,
    row.sgst,
    row.igst,
    row.roundOff,
    row.invoiceTotal,
    row.mediaId,
    row.status,
  ];
}

export function valuesToInvoiceRow(values: unknown[]): InvoiceRow {
  return {
    invoiceNo: str(values[0]),
    orderNo: str(values[1]),
    invoiceDate: str(values[2]),
    placeOfSupply: str(values[3]),
    hsn: str(values[4]),
    gstRate: num(values[5]),
    taxableValue: num(values[6]),
    cgst: num(values[7]),
    sgst: num(values[8]),
    igst: num(values[9]),
    roundOff: num(values[10]),
    invoiceTotal: num(values[11]),
    mediaId: str(values[12]),
    status: (str(values[13]) || 'ISSUED') as InvoiceRow['status'],
  };
}

export function effectRowToValues(row: EffectRow): (string | number)[] {
  return [
    row.effectId,
    row.orderNo,
    row.kind,
    row.payloadJson,
    row.attempts,
    row.state,
    row.lastError,
    row.createdAt,
    row.nextAttemptAt,
  ];
}

export function valuesToEffectRow(values: unknown[]): EffectRow {
  return {
    effectId: str(values[0]),
    orderNo: str(values[1]),
    kind: str(values[2]),
    payloadJson: str(values[3]),
    attempts: num(values[4]),
    state: (str(values[5]) || 'PENDING') as EffectRow['state'],
    lastError: str(values[6]),
    createdAt: str(values[7]),
    nextAttemptAt: str(values[8]),
  };
}

/** FY segment of `PREFIX/FY/SEQ`, e.g. `26-27` out of `UM/26-27/0007`. */
function invoiceFy(invoiceNo: string): string {
  return invoiceNo.split('/')[1] ?? '';
}

export class GoogleSheetStore implements SheetStore {
  constructor(
    private readonly api: SheetsApi,
    private readonly sheetId: string,
  ) {}

  /** Rows below the header, paired with their 1-indexed sheet row number. */
  private async orderRowsWithIndex(): Promise<Array<{ row: OrderRow; sheetRow: number }>> {
    const values = await this.api.getValues(this.sheetId, ORDERS_RANGE);
    return values
      .slice(1)
      .map((rowValues, index) => ({ row: valuesToOrderRow(rowValues), sheetRow: index + 2 }))
      .filter((entry) => entry.row.orderNo !== '');
  }

  async appendOrder(row: OrderRow): Promise<void> {
    await this.api.appendValues(this.sheetId, ORDERS_RANGE, [orderRowToValues(row)]);
  }

  async listOrders(): Promise<OrderRow[]> {
    return (await this.orderRowsWithIndex()).map((entry) => entry.row);
  }

  async findOrderByNo(orderNo: string): Promise<OrderRow | null> {
    const found = (await this.orderRowsWithIndex()).find((entry) => entry.row.orderNo === orderNo);
    return found?.row ?? null;
  }

  async findLatestPendingByPhone(phone: string): Promise<OrderRow | null> {
    const matches = (await this.orderRowsWithIndex())
      .map((entry) => entry.row)
      .filter((row) => row.phone === phone && row.confirmStatus === 'PENDING')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return matches.at(-1) ?? null;
  }

  async updateOrderFields(orderNo: string, patch: Partial<OrderRow>): Promise<void> {
    const entry = (await this.orderRowsWithIndex()).find((e) => e.row.orderNo === orderNo);
    if (!entry) return;

    const data = (Object.keys(patch) as Array<keyof OrderRow>)
      .filter((field) => patch[field] !== undefined)
      .map((field) => {
        const col = ORDER_COLUMNS[field];
        const raw = patch[field];
        const value = typeof raw === 'boolean' ? (raw ? 'TRUE' : 'FALSE') : raw;
        return {
          range: `orders!${col}${entry.sheetRow}:${col}${entry.sheetRow}`,
          values: [[value as string | number]],
        };
      });

    if (data.length > 0) await this.batchWrite(data);
  }

  private async batchWrite(data: Array<{ range: string; values: unknown[][]; raw?: boolean }>) {
    await this.api.batchUpdateValues(this.sheetId, data);
  }

  async appendMessage(row: MessageRow): Promise<void> {
    await this.api.appendValues(this.sheetId, MESSAGES_RANGE, [messageRowToValues(row)]);
  }

  async updateMessageStatus(wamid: string, status: string): Promise<void> {
    const values = await this.api.getValues(this.sheetId, MESSAGES_RANGE);
    // Row 1 is the header, so array index i maps to sheet row i + 1.
    const index = values.findIndex((row, i) => i > 0 && str(row[2]) === wamid);
    if (index === -1) return;
    const sheetRow = index + 1;
    await this.api.updateValues(this.sheetId, `messages!E${sheetRow}:E${sheetRow}`, [[status]]);
  }

  async listMessages(): Promise<MessageRow[]> {
    const values = await this.api.getValues(this.sheetId, MESSAGES_RANGE);
    return values.slice(1).filter((row) => str(row[0]) !== '').map(valuesToMessageRow);
  }

  async hasEvent(source: EventSource, externalId: string): Promise<boolean> {
    const values = await this.api.getValues(this.sheetId, EVENTS_RANGE);
    return values.slice(1).some((row) => str(row[0]) === source && str(row[1]) === externalId);
  }

  async recordEvent(source: EventSource, externalId: string): Promise<void> {
    await this.api.appendValues(this.sheetId, EVENTS_RANGE, [
      [source, externalId, new Date().toISOString()],
    ]);
  }

  /** Rows below the header, paired with their 1-indexed sheet row number. */
  private async shipmentRowsWithIndex(): Promise<Array<{ row: ShipmentRow; sheetRow: number }>> {
    const values = await this.api.getValues(this.sheetId, SHIPMENTS_RANGE);
    return values
      .slice(1)
      .map((rowValues, index) => ({ row: valuesToShipmentRow(rowValues), sheetRow: index + 2 }))
      .filter((entry) => entry.row.awb !== '');
  }

  async upsertShipment(row: ShipmentRow): Promise<void> {
    const entry = (await this.shipmentRowsWithIndex()).find((e) => e.row.awb === row.awb);
    if (!entry) {
      await this.api.appendValues(this.sheetId, SHIPMENTS_RANGE, [shipmentRowToValues(row)]);
      return;
    }

    const data = (Object.keys(row) as Array<keyof ShipmentRow>)
      .filter((field) => row[field] !== entry.row[field])
      .map((field) => {
        const col = SHIPMENT_COLUMNS[field];
        return {
          range: `shipments!${col}${entry.sheetRow}:${col}${entry.sheetRow}`,
          values: [[row[field] as string | number]],
        };
      });

    if (data.length > 0) await this.batchWrite(data);
  }

  async findShipmentByAwb(awb: string): Promise<ShipmentRow | null> {
    const found = (await this.shipmentRowsWithIndex()).find((entry) => entry.row.awb === awb);
    return found?.row ?? null;
  }

  async listOpenShipments(): Promise<ShipmentRow[]> {
    return (await this.shipmentRowsWithIndex())
      .map((entry) => entry.row)
      .filter((row) => !isTerminal(row.status));
  }

  /** Rows below the header, paired with their 1-indexed sheet row number. */
  private async invoiceRowsWithIndex(): Promise<Array<{ row: InvoiceRow; sheetRow: number }>> {
    const values = await this.api.getValues(this.sheetId, INVOICES_RANGE);
    return values
      .slice(1)
      .map((rowValues, index) => ({ row: valuesToInvoiceRow(rowValues), sheetRow: index + 2 }))
      .filter((entry) => entry.row.invoiceNo !== '');
  }

  async appendInvoiceLines(rows: InvoiceRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.api.appendValues(this.sheetId, INVOICES_RANGE, rows.map(invoiceRowToValues));
  }

  async listInvoices(): Promise<InvoiceRow[]> {
    return (await this.invoiceRowsWithIndex()).map((entry) => entry.row);
  }

  async lastInvoiceSequence(fy: string): Promise<number> {
    const sequences = (await this.invoiceRowsWithIndex())
      .map((entry) => entry.row.invoiceNo)
      .filter((invoiceNo) => invoiceFy(invoiceNo) === fy)
      .map(parseSequence);
    return sequences.length > 0 ? Math.max(...sequences) : 0;
  }

  async voidInvoice(invoiceNo: string): Promise<void> {
    const entries = (await this.invoiceRowsWithIndex()).filter(
      (entry) => entry.row.invoiceNo === invoiceNo,
    );
    const col = INVOICE_COLUMNS.status;
    const data = entries.map((entry) => ({
      range: `invoices!${col}${entry.sheetRow}:${col}${entry.sheetRow}`,
      values: [['VOID']],
    }));
    if (data.length > 0) await this.batchWrite(data);
  }

  /** Rows below the header, paired with their 1-indexed sheet row number. */
  private async effectRowsWithIndex(): Promise<Array<{ row: EffectRow; sheetRow: number }>> {
    const values = await this.api.getValues(this.sheetId, EFFECTS_RANGE);
    return values
      .slice(1)
      .map((rowValues, index) => ({ row: valuesToEffectRow(rowValues), sheetRow: index + 2 }))
      .filter((entry) => entry.row.effectId !== '');
  }

  async appendEffect(row: EffectRow): Promise<void> {
    await this.api.appendValues(this.sheetId, EFFECTS_RANGE, [effectRowToValues(row)]);
  }

  async listDueEffects(nowIso: string): Promise<EffectRow[]> {
    return (await this.effectRowsWithIndex())
      .map((entry) => entry.row)
      .filter((row) => row.state === 'PENDING' && row.nextAttemptAt <= nowIso);
  }

  async updateEffect(effectId: string, patch: Partial<EffectRow>): Promise<void> {
    const entry = (await this.effectRowsWithIndex()).find((e) => e.row.effectId === effectId);
    if (!entry) return;

    const data = (Object.keys(patch) as Array<keyof EffectRow>)
      .filter((field) => patch[field] !== undefined)
      .map((field) => {
        const col = EFFECT_COLUMNS[field];
        return {
          range: `effects!${col}${entry.sheetRow}:${col}${entry.sheetRow}`,
          values: [[patch[field] as string | number]],
        };
      });

    if (data.length > 0) await this.batchWrite(data);
  }

  /** 1-indexed sheet row whose column A equals `orderNo`, or null if there is none. */
  private async ledgerRowFor(orderNo: string): Promise<number | null> {
    const values = await this.api.getValues(this.sheetId, LEDGER_LOOKUP_RANGE);
    const index = values.findIndex((row, i) => i > 0 && str(row[0]) === orderNo);
    return index === -1 ? null : index + 1;
  }

  /**
   * Writes A–J, then reads the sheet row the append landed on to write the W–Y
   * formulas. A hardcoded `A:J` — not a computed range — is what keeps this call
   * structurally incapable of reaching the operator's R–V columns.
   */
  async appendLedgerOrder(fields: LedgerOrderFields, corporateTaxPct: number): Promise<void> {
    const { updatedRange } = await this.api.appendValues(
      this.sheetId, LEDGER_APPEND_RANGE, [ledgerOrderValues(fields)],
    );
    const sheetRow = Number.parseInt(updatedRange.match(/!\D+(\d+)/)?.[1] ?? '0', 10);
    if (sheetRow === 0) return;
    await this.api.batchUpdateValues(this.sheetId, [
      {
        range: `ledger!W${sheetRow}:Y${sheetRow}`,
        values: [ledgerFormulas(sheetRow, corporateTaxPct)],
        raw: false,
      },
    ]);
  }

  /** K–Q only. The ceiling is why this is a hardcoded range, not a computed one. */
  async updateLedgerOutcome(orderNo: string, fields: LedgerOutcomeFields): Promise<void> {
    const sheetRow = await this.ledgerRowFor(orderNo);
    if (sheetRow === null) return;
    await this.api.batchUpdateValues(this.sheetId, [
      {
        range: `ledger!K${sheetRow}:${LEDGER_HUB_CEILING}${sheetRow}`,
        values: [ledgerOutcomeValues(fields)],
      },
    ]);
  }

  async listLedger(): Promise<Record<string, unknown>[]> {
    const values = await this.api.getValues(this.sheetId, 'ledger!A:Y');
    return values
      .slice(1)
      .filter((row) => str(row[0]) !== '')
      .map((row) => Object.fromEntries(LEDGER_HEADERS.map((header, i) => [header, row[i] ?? ''])));
  }
}

/**
 * Real Sheets client, authenticated via Application Default Credentials —
 * on Cloud Run that is the attached service account, with no key file anywhere.
 *
 * `GoogleAuth` comes from `googleapis` rather than a direct `google-auth-library`
 * dependency: `googleapis` bundles its own copy, and two copies produce
 * structurally identical but nominally incompatible types.
 */
export async function createSheetsApi(): Promise<SheetsApi> {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  return {
    async getValues(sheetId, range) {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
      return res.data.values ?? [];
    },
    async appendValues(sheetId, range, values) {
      const res = await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: values as unknown[][] },
      });
      return { updatedRange: res.data.updates?.updatedRange ?? '' };
    },
    async updateValues(sheetId, range, values) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range,
        valueInputOption: 'RAW',
        requestBody: { values: values as unknown[][] },
      });
    },
    async batchUpdateValues(sheetId, data) {
      // Split by valueInputOption: formulas must be USER_ENTERED, everything else RAW.
      // `raw: false` means "this is a formula". It reads oddly, but inverting it would
      // make RAW the opt-in and every existing caller would have to change.
      const groups: Array<['RAW' | 'USER_ENTERED', typeof data]> = [
        ['RAW', data.filter((d) => d.raw !== false)],
        ['USER_ENTERED', data.filter((d) => d.raw === false)],
      ];
      for (const [valueInputOption, group] of groups) {
        if (group.length === 0) continue;
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetId,
          requestBody: {
            valueInputOption,
            data: group.map((d) => ({ range: d.range, values: d.values as unknown[][] })),
          },
        });
      }
    },
  };
}
