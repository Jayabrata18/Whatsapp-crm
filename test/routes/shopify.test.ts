import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/server.js';
import { OrderIntakeService } from '../../src/services/orderIntake.js';
import { ShipmentSyncService } from '../../src/services/shipmentSync.js';
import { EffectService } from '../../src/services/effects.js';
import { createShopifyRouter } from '../../src/routes/shopify.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { StubWhatsAppClient, StubShipmentTracker } from '../fakes/stubClients.js';
import { shopifyOrderPayload } from '../fixtures/shopifyOrder.js';

const SECRET = 'shop-secret';

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(Buffer.from(body)).digest('base64');
}

function fulfillmentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 900000001,
    order_id: 5544332211,
    status: 'success',
    tracking_company: 'Shadowfax',
    tracking_number: 'SF123',
    name: '#1042.1',
    ...overrides,
  };
}

function build() {
  const store = new InMemorySheetStore();
  const whatsapp = new StubWhatsAppClient();
  const intake = new OrderIntakeService({
    store,
    whatsapp,
    codFeeInr: 50,
    codGatewayNames: ['cash on delivery', 'cod'],
    templateLang: 'en',
    rates: { thresholdInr: 2500, low: 5, high: 18 },
    corporateTaxPct: 25,
  });
  const shipmentSync = new ShipmentSyncService({
    store,
    effects: new EffectService({ store, handlers: {} }),
    tracker: new StubShipmentTracker(),
  });
  const app = createApp({
    routers: [createShopifyRouter({ intake, shipmentSync, store, webhookSecret: SECRET })],
  });
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  return { store, whatsapp, server, url: `http://127.0.0.1:${port}/webhook/shopify` };
}

describe('POST /webhook/shopify', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => {
    ctx = build();
  });
  afterEach(() => {
    ctx.server.close();
  });

  async function post(body: string, signature: string | null, topic?: string) {
    return fetch(ctx.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signature ? { 'X-Shopify-Hmac-Sha256': signature } : {}),
        ...(topic ? { 'X-Shopify-Topic': topic } : {}),
      },
      body,
    });
  }

  it('accepts a correctly signed order and sends a message', async () => {
    const body = JSON.stringify(shopifyOrderPayload());
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
    expect(ctx.whatsapp.sent).toHaveLength(1);
  });

  it('rejects a bad signature with 401 and sends nothing', async () => {
    const body = JSON.stringify(shopifyOrderPayload());
    const res = await post(body, 'not-a-signature');
    expect(res.status).toBe(401);
    expect(ctx.whatsapp.sent).toHaveLength(0);
  });

  it('rejects a missing signature with 401', async () => {
    const body = JSON.stringify(shopifyOrderPayload());
    expect((await post(body, null)).status).toBe(401);
  });

  it('rejects a signature computed over different bytes', async () => {
    const body = JSON.stringify(shopifyOrderPayload());
    const res = await post(body, sign(JSON.stringify(shopifyOrderPayload({ total_price: '1.00' }))));
    expect(res.status).toBe(401);
  });

  it('returns 200 and sends once when the same webhook is delivered twice', async () => {
    const body = JSON.stringify(shopifyOrderPayload());
    await post(body, sign(body));
    const second = await post(body, sign(body));
    expect(second.status).toBe(200);
    expect(ctx.whatsapp.sent).toHaveLength(1);
  });

  it('returns 500 when the send fails, so Shopify retries', async () => {
    ctx.whatsapp.failWith = new Error('Meta down');
    const body = JSON.stringify(shopifyOrderPayload());
    expect((await post(body, sign(body))).status).toBe(500);
  });

  it('returns 200 for an order with no usable phone', async () => {
    const body = JSON.stringify(
      shopifyOrderPayload({
        shipping_address: { phone: null },
        customer: { first_name: 'A', phone: null },
        billing_address: { phone: null },
      }),
    );
    expect((await post(body, sign(body))).status).toBe(200);
  });

  describe('fulfillment webhooks', () => {
    beforeEach(async () => {
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
        fulfillmentStatus: 'NEW',
        awb: '',
        cancelStatus: 'NONE',
        cancelReason: '',
        invoiceNo: '',
        rating: '',
        gstDiscrepancy: 0,
        linesJson: '',
      });
    });

    it('records a fulfillment and its AWB', async () => {
      const body = JSON.stringify(fulfillmentPayload());
      const res = await post(body, sign(body), 'fulfillments/create');
      expect(res.status).toBe(200);

      const shipment = await ctx.store.findShipmentByAwb('SF123');
      expect(shipment?.orderNo).toBe('#1042');
      expect(shipment?.status).toBe('SHIPPED');
      // Proves the order row itself moved too, not just the shipments tab.
      expect((await ctx.store.findOrderByNo('#1042'))?.fulfillmentStatus).toBe('SHIPPED');
    });

    it('also records via fulfillments/update', async () => {
      const body = JSON.stringify(fulfillmentPayload({ tracking_number: 'SF456' }));
      const res = await post(body, sign(body), 'fulfillments/update');
      expect(res.status).toBe(200);
      expect((await ctx.store.findShipmentByAwb('SF456'))?.orderNo).toBe('#1042');
    });

    it('rejects a badly signed fulfillment webhook with 401 and records nothing', async () => {
      const body = JSON.stringify(fulfillmentPayload());
      const res = await post(body, 'not-a-signature', 'fulfillments/create');
      expect(res.status).toBe(401);
      expect(await ctx.store.findShipmentByAwb('SF123')).toBeNull();
    });

    it('returns 200 and records nothing when no tracking number is present yet', async () => {
      const body = JSON.stringify(fulfillmentPayload({ tracking_number: null }));
      const res = await post(body, sign(body), 'fulfillments/create');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ result: 'no_tracking_number' });
      expect(await ctx.store.findShipmentByAwb('SF123')).toBeNull();
    });

    it('returns 500 for a fulfillment referencing an unknown order, so Shopify retries', async () => {
      const body = JSON.stringify(fulfillmentPayload({ order_id: 999999999 }));
      const res = await post(body, sign(body), 'fulfillments/create');
      expect(res.status).toBe(500);
      expect(await ctx.store.findShipmentByAwb('SF123')).toBeNull();
    });
  });
});
