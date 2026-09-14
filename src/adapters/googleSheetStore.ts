import { google } from 'googleapis';
import {
  ORDER_COLUMNS,
  type EventSource,
  type MessageRow,
  type OrderRow,
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

const ORDERS_RANGE = 'orders!A:M';
const MESSAGES_RANGE = 'messages!A:F';
const EVENTS_RANGE = 'events!A:C';

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
  };
}

function messageRowToValues(row: MessageRow): string[] {
  return [row.orderNo, row.template, row.wamid, row.direction, row.status, row.timestamp];
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

  async hasEvent(source: EventSource, externalId: string): Promise<boolean> {
    const values = await this.api.getValues(this.sheetId, EVENTS_RANGE);
    return values.slice(1).some((row) => str(row[0]) === source && str(row[1]) === externalId);
  }

  async recordEvent(source: EventSource, externalId: string): Promise<void> {
    await this.api.appendValues(this.sheetId, EVENTS_RANGE, [
      [source, externalId, new Date().toISOString()],
    ]);
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
