import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/server.js';
import { createApiRouter } from '../../src/routes/api.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import type { OrderRow } from '../../src/adapters/sheets.js';
import type { Metrics } from '../../src/core/metrics.js';

interface ApiResponse {
  orders: OrderRow[];
  metrics: Metrics;
}

const TOKEN = 'dash-token';

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    orderNo: '#1042',
    orderId: '5544332211',
    customerName: 'Aarav',
    phone: '919876543210',
    amount: 1899,
    codFee: 50,
    payable: 1849,
    isCod: true,
    confirmStatus: 'PENDING',
    paymentLink: '',
    createdAt: '2026-08-16T10:00:00.000Z',
    confirmedAt: '',
    paidAt: '',
    fulfillmentStatus: 'NEW',
    awb: '',
    cancelStatus: 'NONE',
    cancelReason: '',
    invoiceNo: '',
    rating: '',
    gstDiscrepancy: 0,
    linesJson: '',
    ...overrides,
  };
}

function build() {
  const store = new InMemorySheetStore();
  const app = createApp({ routers: [createApiRouter({ store, dashboardToken: TOKEN })] });
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  return { store, server, url: `http://127.0.0.1:${port}/api/orders` };
}

describe('GET /api/orders', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(async () => {
    ctx = build();
    await ctx.store.appendOrder(order());
    await ctx.store.appendOrder(
      order({
        orderNo: '#1043',
        confirmStatus: 'PAID_EARLY',
        createdAt: '2026-08-16T11:00:00.000Z',
      }),
    );
  });
  afterEach(() => {
    ctx.server.close();
  });

  it('returns orders and metrics with a valid bearer token', async () => {
    const res = await fetch(ctx.url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse;
    expect(body.orders).toHaveLength(2);
    expect(body.metrics.total).toBe(2);
    expect(body.metrics.paidEarly).toBe(1);
  });

  it('returns the newest order first', async () => {
    const res = await fetch(ctx.url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = (await res.json()) as ApiResponse;
    expect(body.orders[0]?.orderNo).toBe('#1043');
  });

  it('accepts the token as a query parameter', async () => {
    expect((await fetch(`${ctx.url}?token=${TOKEN}`)).status).toBe(200);
  });

  it('rejects a missing token with 401', async () => {
    expect((await fetch(ctx.url)).status).toBe(401);
  });

  it('rejects a wrong token with 401', async () => {
    expect((await fetch(ctx.url, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
  });

  it('rejects a token of a different length without throwing', async () => {
    expect(
      (await fetch(ctx.url, { headers: { Authorization: 'Bearer much-longer-token-value' } }))
        .status,
    ).toBe(401);
  });

  it('never exposes the customer phone in full', async () => {
    const res = await fetch(ctx.url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = (await res.json()) as ApiResponse;
    expect(body.orders[0]?.phone).toBe('9198****3210');
  });
});
