import { isTerminal } from '../../src/core/shipmentState.js';
import { parseSequence } from '../../src/core/invoiceNumber.js';
import {
  LEDGER_HEADERS,
  ledgerOrderValues,
  ledgerOutcomeValues,
  type LedgerOrderFields,
  type LedgerOutcomeFields,
} from '../../src/core/ledgerRow.js';
import type {
  EffectRow,
  EventSource,
  InvoiceRow,
  MessageRow,
  OrderRow,
  ShipmentRow,
  SheetStore,
} from '../../src/adapters/sheets.js';
import type { B2csRow } from '../../src/core/b2cs.js';

/** What the fake actually stores: the hub-owned order fields, plus outcome fields once filled in. */
type LedgerRecord = LedgerOrderFields & Partial<LedgerOutcomeFields>;

/** FY segment of `PREFIX/FY/SEQ`, e.g. `26-27` out of `UM/26-27/0007`. */
function invoiceFy(invoiceNo: string): string {
  return invoiceNo.split('/')[1] ?? '';
}

export class InMemorySheetStore implements SheetStore {
  orders: OrderRow[] = [];
  messages: MessageRow[] = [];
  events = new Set<string>();
  shipments: ShipmentRow[] = [];
  invoices: InvoiceRow[] = [];
  effects: EffectRow[] = [];
  ledger: LedgerRecord[] = [];
  b2cs: Array<{ month: string } & B2csRow> = [];

  async appendOrder(row: OrderRow): Promise<void> {
    this.orders.push({ ...row });
  }

  async listOrders(): Promise<OrderRow[]> {
    return this.orders.map((row) => ({ ...row }));
  }

  async findOrderByNo(orderNo: string): Promise<OrderRow | null> {
    const found = this.orders.find((row) => row.orderNo === orderNo);
    return found ? { ...found } : null;
  }

  async findLatestPendingByPhone(phone: string): Promise<OrderRow | null> {
    const matches = this.orders
      .filter((row) => row.phone === phone && row.confirmStatus === 'PENDING')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const latest = matches.at(-1);
    return latest ? { ...latest } : null;
  }

  async updateOrderFields(orderNo: string, patch: Partial<OrderRow>): Promise<void> {
    const index = this.orders.findIndex((row) => row.orderNo === orderNo);
    if (index === -1) return;
    this.orders[index] = { ...this.orders[index]!, ...patch };
  }

  async appendMessage(row: MessageRow): Promise<void> {
    this.messages.push({ ...row });
  }

  async updateMessageStatus(wamid: string, status: string): Promise<void> {
    const index = this.messages.findIndex((row) => row.wamid === wamid);
    if (index === -1) return;
    this.messages[index] = { ...this.messages[index]!, status };
  }

  async listMessages(): Promise<MessageRow[]> {
    return this.messages.map((row) => ({ ...row }));
  }

  async hasEvent(source: EventSource, externalId: string): Promise<boolean> {
    return this.events.has(`${source}:${externalId}`);
  }

  async recordEvent(source: EventSource, externalId: string): Promise<void> {
    this.events.add(`${source}:${externalId}`);
  }

  async upsertShipment(row: ShipmentRow): Promise<void> {
    const index = this.shipments.findIndex((s) => s.awb === row.awb);
    if (index === -1) {
      this.shipments.push({ ...row });
    } else {
      this.shipments[index] = { ...row };
    }
  }

  async findShipmentByAwb(awb: string): Promise<ShipmentRow | null> {
    const found = this.shipments.find((s) => s.awb === awb);
    return found ? { ...found } : null;
  }

  async listOpenShipments(): Promise<ShipmentRow[]> {
    return this.shipments.filter((s) => !isTerminal(s.status)).map((s) => ({ ...s }));
  }

  async appendInvoiceLines(rows: InvoiceRow[]): Promise<void> {
    this.invoices.push(...rows.map((row) => ({ ...row })));
  }

  async listInvoices(): Promise<InvoiceRow[]> {
    return this.invoices.map((row) => ({ ...row }));
  }

  async lastInvoiceSequence(fy: string): Promise<number> {
    const sequences = this.invoices
      .map((row) => row.invoiceNo)
      .filter((invoiceNo) => invoiceFy(invoiceNo) === fy)
      .map(parseSequence);
    return sequences.length > 0 ? Math.max(...sequences) : 0;
  }

  async voidInvoice(invoiceNo: string): Promise<void> {
    this.invoices = this.invoices.map((row) =>
      row.invoiceNo === invoiceNo ? { ...row, status: 'VOID' as const } : row,
    );
  }

  async appendEffect(row: EffectRow): Promise<void> {
    this.effects.push({ ...row });
  }

  async listDueEffects(nowIso: string): Promise<EffectRow[]> {
    return this.effects
      .filter((e) => e.state === 'PENDING' && e.nextAttemptAt <= nowIso)
      .map((e) => ({ ...e }));
  }

  async listFailedEffects(): Promise<EffectRow[]> {
    return this.effects.filter((e) => e.state === 'FAILED').map((e) => ({ ...e }));
  }

  async updateEffect(effectId: string, patch: Partial<EffectRow>): Promise<void> {
    const index = this.effects.findIndex((e) => e.effectId === effectId);
    if (index === -1) return;
    this.effects[index] = { ...this.effects[index]!, ...patch };
  }

  // There is deliberately no method here that can touch the operator-owned R–V
  // block: LedgerRecord is built only from LedgerOrderFields and LedgerOutcomeFields.
  async appendLedgerOrder(fields: LedgerOrderFields, _corporateTaxPct: number): Promise<void> {
    this.ledger.push({ ...fields });
  }

  async updateLedgerOutcome(orderNo: string, fields: LedgerOutcomeFields): Promise<void> {
    const index = this.ledger.findIndex((row) => row.orderNo === orderNo);
    if (index === -1) return;
    this.ledger[index] = { ...this.ledger[index]!, ...fields };
  }

  /**
   * Zips against `LEDGER_HEADERS` exactly like `GoogleSheetStore.listLedger()` does against
   * `ledger!A:Y` — a consumer keying off snake_case column names (the only contract the real
   * adapter offers) must see the same shape here, not the fake's internal camelCase storage.
   */
  async listLedger(): Promise<Record<string, unknown>[]> {
    return this.ledger.map((row) => {
      const orderValues = ledgerOrderValues(row);
      const outcomeValues =
        row.outcome !== undefined ? ledgerOutcomeValues(row as LedgerOutcomeFields) : ['', '', '', '', '', '', ''];
      const formulaValues = ['', '', '']; // W–Y are live sheet formulas; not evaluated in-memory.
      const values = [...orderValues, ...outcomeValues, ...formulaValues];
      return Object.fromEntries(LEDGER_HEADERS.map((header, i) => [header, values[i] ?? '']));
    });
  }

  async listB2cs(): Promise<Array<{ month: string } & B2csRow>> {
    return this.b2cs.map((row) => ({ ...row }));
  }

  /** Replaces `month`'s rows rather than appending a duplicate set — see `upsertShipment`. */
  async replaceB2csMonth(month: string, rows: B2csRow[]): Promise<void> {
    this.b2cs = [
      ...this.b2cs.filter((row) => row.month !== month),
      ...rows.map((row) => ({ month, ...row })),
    ];
  }
}
