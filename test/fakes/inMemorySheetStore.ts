import type {
  EventSource,
  MessageRow,
  OrderRow,
  SheetStore,
} from '../../src/adapters/sheets.js';

export class InMemorySheetStore implements SheetStore {
  orders: OrderRow[] = [];
  messages: MessageRow[] = [];
  events = new Set<string>();

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

  async updateOrder(orderNo: string, patch: Partial<OrderRow>): Promise<void> {
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

  async hasEvent(source: EventSource, externalId: string): Promise<boolean> {
    return this.events.has(`${source}:${externalId}`);
  }

  async recordEvent(source: EventSource, externalId: string): Promise<void> {
    this.events.add(`${source}:${externalId}`);
  }
}
