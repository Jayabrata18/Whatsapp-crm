import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/server.js';
import { OrderIntakeService } from '../../src/services/orderIntake.js';
import { createShopifyRouter } from '../../src/routes/shopify.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { StubWhatsAppClient } from '../fakes/stubClients.js';
import { shopifyOrderPayload } from '../fixtures/shopifyOrder.js';

const SECRET = 'shop-secret';

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(Buffer.from(body)).digest('base64');
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
  });
  const app = createApp({ routers: [createShopifyRouter({ intake, webhookSecret: SECRET })] });
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

  async function post(body: string, signature: string | null) {
    return fetch(ctx.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signature ? { 'X-Shopify-Hmac-Sha256': signature } : {}),
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
});
