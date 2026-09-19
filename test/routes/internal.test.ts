import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/server.js';
import { createInternalRouter } from '../../src/routes/internal.js';
import { ShipmentSyncService } from '../../src/services/shipmentSync.js';
import { EffectService } from '../../src/services/effects.js';
import { RatingService } from '../../src/services/rating.js';
import { ReportingService } from '../../src/services/reporting.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { StubShipmentTracker, StubWhatsAppClient } from '../fakes/stubClients.js';
import { baseEffect, baseInvoice, baseShipment } from '../fixtures/stage1.js';
import type { OrderRow } from '../../src/adapters/sheets.js';

const TOKEN = 'task-token';

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
    confirmStatus: 'CONFIRMED',
    paymentLink: '',
    createdAt: '2026-08-16T10:00:00.000Z',
    confirmedAt: '2026-08-16T12:00:00.000Z',
    paidAt: '',
    fulfillmentStatus: 'DELIVERED',
    awb: 'SF000000001',
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
  const tracker = new StubShipmentTracker();
  const whatsapp = new StubWhatsAppClient();
  const shipmentSync = new ShipmentSyncService({
    store,
    effects: new EffectService({ store, handlers: {} }),
    tracker,
  });
  const effects = new EffectService({ store, handlers: { noop: async () => {} } });
  const rating = new RatingService({
    store,
    whatsapp,
    templateLang: 'en',
    ratingDelayDays: 3,
    judgemeReviewUrl: 'https://judge.me/review',
  });
  const reporting = new ReportingService({ store, sellerStateCode: '19' });

  const app = createApp({
    routers: [createInternalRouter({ shipmentSync, effects, rating, reporting, taskToken: TOKEN })],
  });
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  return { store, tracker, whatsapp, server, base: `http://127.0.0.1:${port}` };
}

describe('internal task routes', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => {
    ctx = build();
  });
  afterEach(() => {
    ctx.server.close();
  });

  function post(path: string, token: string | null) {
    return fetch(`${ctx.base}${path}`, {
      method: 'POST',
      headers: token !== null ? { Authorization: `Bearer ${token}` } : {},
    });
  }

  it('rejects an internal call without the task token', async () => {
    expect((await post('/internal/drain-effects', null)).status).toBe(401);
  });

  it('rejects an internal call with the wrong task token', async () => {
    expect((await post('/internal/drain-effects', 'wrong')).status).toBe(401);
  });

  it('drains effects when authorised', async () => {
    await ctx.store.appendEffect({ ...baseEffect, kind: 'noop', state: 'PENDING' });
    const res = await post('/internal/drain-effects', TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ done: 1 });
    // Proves the effect was actually processed, not just that the count says so.
    expect((await ctx.store.listDueEffects('2099-01-01T00:00:00.000Z'))).toHaveLength(0);
  });

  it('syncs open shipments when authorised', async () => {
    await ctx.store.upsertShipment(baseShipment);
    ctx.tracker.responses = [
      { awb: baseShipment.awb, status: 'OFD', rawStatus: 'OUT_FOR_DELIVERY', at: '2026-09-11T00:00:00.000Z' },
    ];
    const res = await post('/internal/sync-shipments', TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ checked: 1, applied: 1 });
    expect((await ctx.store.findShipmentByAwb(baseShipment.awb))?.status).toBe('OFD');
  });

  it('runs the rating sweep when authorised', async () => {
    await ctx.store.appendOrder(order());
    await ctx.store.upsertShipment({
      ...baseShipment,
      awb: 'SF000000001',
      status: 'DELIVERED',
      deliveredAt: '2020-01-01T00:00:00.000Z', // long past the delay window
    });
    const res = await post('/internal/rating-sweep', TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: 1 });
    expect(ctx.whatsapp.sent).toHaveLength(1);
  });

  it('returns the B2CS CSV for a month as text/csv when authorised', async () => {
    await ctx.store.appendInvoiceLines([{ ...baseInvoice, invoiceDate: '2026-09-10' }]);
    const res = await fetch(`${ctx.base}/internal/b2cs?month=2026-09`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const body = await res.text();
    expect(body).toContain('KA,,5,1000');
  });

  it('rejects a b2cs call without the task token', async () => {
    const res = await fetch(`${ctx.base}/internal/b2cs?month=2026-09`);
    expect(res.status).toBe(401);
  });

  it('rejects a b2cs call missing the month query param', async () => {
    const res = await fetch(`${ctx.base}/internal/b2cs`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
  });
});
