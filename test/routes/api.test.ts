import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/server.js';
import { createApiRouter } from '../../src/routes/api.js';
import { CancellationService } from '../../src/services/cancellation.js';
import { ReportingService } from '../../src/services/reporting.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { StubShopifyWriter, StubWhatsAppClient } from '../fakes/stubClients.js';
import { baseEffect, baseShipment } from '../fixtures/stage1.js';
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
  const shopify = new StubShopifyWriter();
  const whatsapp = new StubWhatsAppClient();
  const cancellation = new CancellationService({
    store,
    shopify,
    whatsapp,
    templateLang: 'en',
  });
  const reporting = new ReportingService({ store, sellerStateCode: '19' });
  const app = createApp({
    routers: [
      createApiRouter({ store, dashboardToken: TOKEN, cancellation, reporting }),
    ],
  });
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  return { store, shopify, whatsapp, server, base, url: `${base}/api/orders` };
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

describe('GET /api/delivery', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(async () => {
    ctx = build();
    await ctx.store.appendOrder(order({ orderNo: '#1042', fulfillmentStatus: 'SHIPPED' }));
    await ctx.store.appendOrder(order({ orderNo: '#1043', fulfillmentStatus: 'OFD' }));
    await ctx.store.appendOrder(order({ orderNo: '#1044', fulfillmentStatus: 'DELIVERED' }));
    await ctx.store.upsertShipment({
      ...baseShipment,
      orderNo: '#1045',
      awb: 'SF000000099',
      status: 'RTO_INITIATED',
    });
  });
  afterEach(() => {
    ctx.server.close();
  });

  it('reports the shipped/OFD/delivered funnel and the in-transit RTO list', async () => {
    const res = await fetch(`${ctx.base}/api/delivery`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      funnel: { shipped: 1, ofd: 1, delivered: 1 },
      rto: [expect.objectContaining({ awb: 'SF000000099' })],
    });
  });

  it('refuses an unauthenticated request', async () => {
    expect((await fetch(`${ctx.base}/api/delivery`)).status).toBe(401);
  });
});

describe('GET/POST /api/cancellations', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(async () => {
    ctx = build();
    await ctx.store.appendOrder(
      order({
        orderNo: '#1042',
        confirmStatus: 'CANCELLED',
        cancelStatus: 'REVIEW_PENDING',
        cancelReason: 'CUSTOMER_REQUEST',
      }),
    );
  });
  afterEach(() => {
    ctx.server.close();
  });

  it('lists orders awaiting cancel review', async () => {
    const res = await fetch(`${ctx.base}/api/cancellations`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      orders: [expect.objectContaining({ orderNo: '#1042' })],
    });
  });

  it('approves a cancellation through the API', async () => {
    const res = await fetch(`${ctx.base}/api/cancellations/${encodeURIComponent('#1042')}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(ctx.shopify.cancels).toHaveLength(1);
  });

  it('refuses an unauthenticated request', async () => {
    expect((await fetch(`${ctx.base}/api/cancellations`)).status).toBe(401);
  });
});

describe('GET /api/invoices', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(async () => {
    ctx = build();
    await ctx.store.appendOrder(order({ orderNo: '#1042', gstDiscrepancy: 12.5 }));
    await ctx.store.appendInvoiceLines([
      {
        invoiceNo: 'UM/26-27/0001',
        orderNo: '#1042',
        invoiceDate: '2026-09-10',
        placeOfSupply: '19',
        hsn: '6109',
        gstRate: 5,
        taxableValue: 1000,
        cgst: 25,
        sgst: 25,
        igst: 0,
        roundOff: 0,
        invoiceTotal: 1050,
        mediaId: 'media-abc',
        status: 'ISSUED',
      },
    ]);
  });
  afterEach(() => {
    ctx.server.close();
  });

  it('returns the invoice register and GST discrepancy flags', async () => {
    const res = await fetch(`${ctx.base}/api/invoices`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      invoices: [expect.objectContaining({ invoiceNo: 'UM/26-27/0001' })],
      discrepancies: [expect.objectContaining({ orderNo: '#1042' })],
    });
  });

  it('refuses an unauthenticated request', async () => {
    expect((await fetch(`${ctx.base}/api/invoices`)).status).toBe(401);
  });
});

describe('GET /api/health-flags', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(async () => {
    ctx = build();
    await ctx.store.appendEffect({ ...baseEffect, effectId: 'e1', state: 'FAILED' });
    await ctx.store.appendEffect({ ...baseEffect, effectId: 'e2', state: 'PENDING' });
    await ctx.store.upsertShipment({
      ...baseShipment,
      orderNo: '#1042',
      awb: 'SF000000042',
      status: 'SHIPPED',
      rawStatus: 'SOME_NEW_STATUS_SHADOWFAX_INVENTED',
    });
  });
  afterEach(() => {
    ctx.server.close();
  });

  it('surfaces failed effects and unmapped statuses as health flags', async () => {
    const res = await fetch(`${ctx.base}/api/health-flags`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      failedEffects: [expect.objectContaining({ effectId: 'e1' })],
      unmappedStatuses: [expect.objectContaining({ awb: 'SF000000042' })],
    });
  });

  it('refuses an unauthenticated request', async () => {
    expect((await fetch(`${ctx.base}/api/health-flags`)).status).toBe(401);
  });
});

describe('GET /api/b2cs', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(async () => {
    ctx = build();
    await ctx.store.appendInvoiceLines([
      {
        invoiceNo: 'UM/26-27/0001',
        orderNo: '#1042',
        invoiceDate: '2026-09-10',
        placeOfSupply: '19',
        hsn: '6109',
        gstRate: 5,
        taxableValue: 1000,
        cgst: 25,
        sgst: 25,
        igst: 0,
        roundOff: 0,
        invoiceTotal: 1050,
        mediaId: 'media-abc',
        status: 'ISSUED',
      },
    ]);
  });
  afterEach(() => {
    ctx.server.close();
  });

  it('downloads the month\'s B2CS CSV using the query-token fallback', async () => {
    const res = await fetch(`${ctx.base}/api/b2cs?month=2026-09&token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const csv = await res.text();
    expect(csv).toContain('1000');
  });

  it('refuses an unauthenticated request', async () => {
    expect((await fetch(`${ctx.base}/api/b2cs?month=2026-09`)).status).toBe(401);
  });
});
