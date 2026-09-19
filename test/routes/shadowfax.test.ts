import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/server.js';
import { createShadowfaxRouter } from '../../src/routes/shadowfax.js';
import { ShipmentSyncService } from '../../src/services/shipmentSync.js';
import { EffectService } from '../../src/services/effects.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { StubShipmentTracker } from '../fakes/stubClients.js';
import type { ShipmentRow } from '../../src/adapters/sheets.js';

const SECRET = 'shadowfax-secret';

function shipment(overrides: Partial<ShipmentRow> = {}): ShipmentRow {
  return {
    orderNo: '#1042',
    awb: 'SF1',
    courier: 'Shadowfax',
    status: 'SHIPPED',
    shippedAt: '2026-09-01T10:00:00.000Z',
    ofdAt: '',
    deliveredAt: '',
    rtoInitiatedAt: '',
    rtoReturnedAt: '',
    lastSyncedAt: '2026-09-01T10:00:00.000Z',
    rawStatus: 'IN_TRANSIT',
    rtoRestockedAt: '',
    ...overrides,
  };
}

function build() {
  const store = new InMemorySheetStore();
  const effects = new EffectService({ store, handlers: {} });
  const shipmentSync = new ShipmentSyncService({ store, effects, tracker: new StubShipmentTracker() });
  const app = createApp({
    routers: [createShadowfaxRouter({ shipmentSync, webhookSecret: SECRET })],
  });
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  return { store, server, url: `http://127.0.0.1:${port}/webhook/shadowfax` };
}

describe('POST /webhook/shadowfax', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(async () => {
    ctx = build();
    await ctx.store.appendOrder({
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
      fulfillmentStatus: 'SHIPPED',
      awb: 'SF1',
      cancelStatus: 'NONE',
      cancelReason: '',
      invoiceNo: '',
      rating: '',
      gstDiscrepancy: 0,
      linesJson: '',
    });
    await ctx.store.upsertShipment(shipment());
  });
  afterEach(() => {
    ctx.server.close();
  });

  function post(body: unknown, token: string | null) {
    return fetch(ctx.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token !== null ? { 'X-Shadowfax-Token': token } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it('rejects a request without the shared secret', async () => {
    const res = await post({ awb_number: 'SF1', status: 'DELIVERED' }, null);
    expect(res.status).toBe(401);
    // Proves the request never reached applyShipmentStatus at all.
    expect((await ctx.store.findShipmentByAwb('SF1'))?.status).toBe('SHIPPED');
  });

  it('rejects a request with the wrong secret', async () => {
    const res = await post({ awb_number: 'SF1', status: 'DELIVERED' }, 'wrong-secret');
    expect(res.status).toBe(401);
  });

  it('accepts a valid status, applies it, and enqueues the delivered effect', async () => {
    const res = await post({ awb_number: 'SF1', status: 'DELIVERED' }, SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'applied' });

    const row = await ctx.store.findShipmentByAwb('SF1');
    expect(row?.status).toBe('DELIVERED');
    expect(row?.deliveredAt).not.toBe('');

    expect(ctx.store.effects).toHaveLength(1);
    expect(ctx.store.effects[0]?.kind).toBe('delivered');
  });

  it('answers 200 for an unmapped status, persists rawStatus, and enqueues nothing', async () => {
    const res = await post({ awb_number: 'SF1', status: 'TELEPORTED' }, SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'ignored_unknown_status' });

    const row = await ctx.store.findShipmentByAwb('SF1');
    expect(row?.status).toBe('SHIPPED'); // unchanged
    expect(row?.rawStatus).toBe('TELEPORTED');
    expect(ctx.store.effects).toHaveLength(0);
  });

  it('answers 400 for a payload with no AWB', async () => {
    const res = await post({ status: 'DELIVERED' }, SECRET);
    expect(res.status).toBe(400);
    expect(ctx.store.effects).toHaveLength(0);
  });

  it('answers 200 for an illegal transition and does not enqueue a second effect', async () => {
    await post({ awb_number: 'SF1', status: 'DELIVERED' }, SECRET);
    const res = await post({ awb_number: 'SF1', status: 'DELIVERED' }, SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'ignored_illegal' });
    expect(ctx.store.effects).toHaveLength(1); // still just the one from the first call
  });
});
