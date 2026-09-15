import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/server.js';
import { createCashfreeRouter } from '../../src/routes/cashfree.js';
import { PaymentService } from '../../src/services/payment.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { StubOrderTagger } from '../fakes/stubClients.js';

const SECRET = 'cf-secret';
const TIMESTAMP = '1755300000';

function sign(body: string): string {
  return createHmac('sha256', SECRET)
    .update(TIMESTAMP + body)
    .digest('base64');
}

function build() {
  const store = new InMemorySheetStore();
  const tagger = new StubOrderTagger();
  const payment = new PaymentService({ store, tagger });
  const app = createApp({ routers: [createCashfreeRouter({ payment, secretKey: SECRET })] });
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  return { store, tagger, server, url: `http://127.0.0.1:${port}/webhook/cashfree` };
}

const payload = JSON.stringify({
  type: 'PAYMENT_LINK_EVENT',
  data: { link_id: 'urbnmyth-1042', link_status: 'PAID', order: { order_id: 'cf-99' } },
});

describe('POST /webhook/cashfree', () => {
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
      paymentLink: 'https://cf.test/links/urbnmyth-1042',
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
  afterEach(() => {
    ctx.server.close();
  });

  async function post(
    body: string,
    signature: string | null,
    timestamp: string | null = TIMESTAMP,
  ) {
    return fetch(ctx.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signature ? { 'x-webhook-signature': signature } : {}),
        ...(timestamp ? { 'x-webhook-timestamp': timestamp } : {}),
      },
      body,
    });
  }

  it('marks the order paid on a correctly signed webhook', async () => {
    expect((await post(payload, sign(payload))).status).toBe(200);
    expect((await ctx.store.findOrderByNo('#1042'))?.confirmStatus).toBe('PAID_EARLY');
  });

  it('rejects a bad signature with 401 and changes nothing', async () => {
    expect((await post(payload, 'bogus')).status).toBe(401);
    expect((await ctx.store.findOrderByNo('#1042'))?.confirmStatus).toBe('CONFIRMED');
  });

  it('rejects a missing timestamp with 401', async () => {
    expect((await post(payload, sign(payload), null)).status).toBe(401);
  });

  it('returns 200 for a duplicate delivery', async () => {
    await post(payload, sign(payload));
    expect((await post(payload, sign(payload))).status).toBe(200);
    expect(ctx.tagger.tagged).toHaveLength(1);
  });

  it('returns 200 for an unrelated Cashfree event', async () => {
    const other = JSON.stringify({
      type: 'PAYMENT_LINK_EVENT',
      data: { link_id: 'x', link_status: 'EXPIRED' },
    });
    expect((await post(other, sign(other))).status).toBe(200);
  });
});
