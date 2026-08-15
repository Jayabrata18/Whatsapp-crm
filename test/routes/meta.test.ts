import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/server.js';
import { createMetaRouter } from '../../src/routes/meta.js';
import { ConfirmationService } from '../../src/services/confirmation.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { StubWhatsAppClient, StubPaymentLinkClient } from '../fakes/stubClients.js';

const APP_SECRET = 'meta-app-secret';
const VERIFY_TOKEN = 'my-verify-token';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(Buffer.from(body)).digest('hex')}`;
}

function build() {
  const store = new InMemorySheetStore();
  const whatsapp = new StubWhatsAppClient();
  const payments = new StubPaymentLinkClient();
  const confirmation = new ConfirmationService({
    store,
    whatsapp,
    payments,
    templateLang: 'en',
    linkExpiryHours: 24,
  });
  const app = createApp({
    routers: [createMetaRouter({ confirmation, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN })],
  });
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  return { store, whatsapp, payments, server, base: `http://127.0.0.1:${port}/webhook/meta` };
}

function buttonPayload(from = '919876543210', messageId = 'wamid.IN1') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'w1',
        changes: [
          {
            field: 'messages',
            value: {
              messages: [{ id: messageId, from, type: 'button', button: { text: 'I Confirm' } }],
            },
          },
        ],
      },
    ],
  };
}

describe('GET /webhook/meta', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => {
    ctx = build();
  });
  afterEach(() => {
    ctx.server.close();
  });

  it('echoes hub.challenge when the verify token matches', async () => {
    const res = await fetch(
      `${ctx.base}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('12345');
  });

  it('returns 403 for a wrong verify token', async () => {
    const res = await fetch(
      `${ctx.base}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`,
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 when hub.mode is not subscribe', async () => {
    const res = await fetch(
      `${ctx.base}?hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`,
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /webhook/meta', () => {
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
      confirmStatus: 'PENDING',
      paymentLink: '',
      createdAt: '2026-08-16T10:00:00.000Z',
      confirmedAt: '',
      paidAt: '',
    });
  });
  afterEach(() => {
    ctx.server.close();
  });

  async function post(body: string, signature: string | null) {
    return fetch(ctx.base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signature ? { 'X-Hub-Signature-256': signature } : {}),
      },
      body,
    });
  }

  it('processes a signed button reply', async () => {
    const body = JSON.stringify(buttonPayload());
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
    expect((await ctx.store.findOrderByNo('#1042'))?.confirmStatus).toBe('CONFIRMED');
    expect(ctx.payments.created).toHaveLength(1);
  });

  it('rejects a bad signature with 401 and changes nothing', async () => {
    const body = JSON.stringify(buttonPayload());
    expect((await post(body, 'sha256=deadbeef')).status).toBe(401);
    expect((await ctx.store.findOrderByNo('#1042'))?.confirmStatus).toBe('PENDING');
  });

  it('rejects a missing signature with 401', async () => {
    const body = JSON.stringify(buttonPayload());
    expect((await post(body, null)).status).toBe(401);
  });

  it('returns 200 for a payload with no recognisable events', async () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    expect((await post(body, sign(body))).status).toBe(200);
  });

  it('returns 200 and acts once when the same event is delivered twice', async () => {
    const body = JSON.stringify(buttonPayload());
    await post(body, sign(body));
    expect((await post(body, sign(body))).status).toBe(200);
    expect(ctx.payments.created).toHaveLength(1);
  });

  it('returns 500 when link creation fails, so Meta retries', async () => {
    ctx.payments.failWith = new Error('Cashfree down');
    const body = JSON.stringify(buttonPayload());
    expect((await post(body, sign(body))).status).toBe(500);
  });

  it('processes every event in a multi-event payload', async () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'w1',
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    id: 'wamid.IN1',
                    from: '919876543210',
                    type: 'button',
                    button: { text: 'I Confirm' },
                  },
                ],
                statuses: [{ id: 'wamid.OUT1', status: 'delivered' }],
              },
            },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);
    expect((await post(body, sign(body))).status).toBe(200);
    expect((await ctx.store.findOrderByNo('#1042'))?.confirmStatus).toBe('CONFIRMED');
  });
});
