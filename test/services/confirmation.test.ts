import { describe, it, expect, beforeEach } from 'vitest';
import { ConfirmationService } from '../../src/services/confirmation.js';
import { CancellationService } from '../../src/services/cancellation.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { StubWhatsAppClient, StubPaymentLinkClient, StubShopifyWriter } from '../fakes/stubClients.js';
import type { OrderRow } from '../../src/adapters/sheets.js';
import type { MetaEvent } from '../../src/core/metaWebhook.js';

const NOW = new Date('2026-08-16T12:00:00.000Z');

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

function build(overrides: { payEarlyEnabled?: boolean } = {}) {
  const store = new InMemorySheetStore();
  const whatsapp = new StubWhatsAppClient();
  const payments = new StubPaymentLinkClient();
  const shopify = new StubShopifyWriter();
  const cancellation = new CancellationService({
    store,
    shopify,
    whatsapp,
    templateLang: 'en',
    now: () => NOW,
  });
  const service = new ConfirmationService({
    store,
    whatsapp,
    payments,
    cancellation,
    templateLang: 'en',
    linkExpiryHours: 24,
    payEarlyEnabled: overrides.payEarlyEnabled ?? true,
    now: () => NOW,
  });
  return { store, whatsapp, payments, shopify, cancellation, service };
}

const confirmEvent: MetaEvent = {
  kind: 'button',
  messageId: 'wamid.IN1',
  from: '919876543210',
  buttonText: 'I Confirm',
};

describe('ConfirmationService', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(async () => {
    ctx = build();
    await ctx.store.appendOrder(order());
  });

  it('flips the order to CONFIRMED and stamps confirmedAt', async () => {
    expect(await ctx.service.handleEvent(confirmEvent)).toBe('confirmed');
    const row = await ctx.store.findOrderByNo('#1042');
    expect(row?.confirmStatus).toBe('CONFIRMED');
    expect(row?.confirmedAt).toBe(NOW.toISOString());
  });

  it('creates a payment link for the stored payable, not a recomputed amount', async () => {
    await ctx.service.handleEvent(confirmEvent);
    expect(ctx.payments.created[0]).toMatchObject({
      amount: 1849,
      customerName: 'Aarav',
      customerPhone: '919876543210',
      purpose: 'Order #1042',
      expiryHours: 24,
    });
  });

  it('uses a deterministic link id derived from the order number', async () => {
    await ctx.service.handleEvent(confirmEvent);
    expect(ctx.payments.created[0]?.linkId).toBe('urbnmyth-1042');
  });

  it('stores the payment link on the order row', async () => {
    await ctx.service.handleEvent(confirmEvent);
    const row = await ctx.store.findOrderByNo('#1042');
    expect(row?.paymentLink).toBe('https://cf.test/links/urbnmyth-1042');
  });

  it('sends pay_early_link with amount and savings, and the link id as button suffix', async () => {
    await ctx.service.handleEvent(confirmEvent);
    expect(ctx.whatsapp.sent[0]).toMatchObject({
      to: '919876543210',
      template: 'pay_early_link',
      languageCode: 'en',
      bodyParams: ['Aarav', '1849', '50'],
      urlButtonSuffix: 'urbnmyth-1042',
    });
  });

  it('logs the inbound tap and the outbound link to the messages tab', async () => {
    await ctx.service.handleEvent(confirmEvent);
    expect(ctx.store.messages).toEqual([
      {
        orderNo: '#1042',
        template: 'button:I Confirm',
        wamid: 'wamid.IN1',
        direction: 'in',
        status: 'received',
        timestamp: NOW.toISOString(),
      },
      {
        orderNo: '#1042',
        template: 'pay_early_link',
        wamid: 'wamid.STUB1',
        direction: 'out',
        status: 'sent',
        timestamp: NOW.toISOString(),
      },
    ]);
  });

  it('ignores a duplicate delivery of the same message id', async () => {
    await ctx.service.handleEvent(confirmEvent);
    expect(await ctx.service.handleEvent(confirmEvent)).toBe('duplicate');
    expect(ctx.payments.created).toHaveLength(1);
    expect(ctx.whatsapp.sent).toHaveLength(1);
  });

  it('does not downgrade an order that is already PAID_EARLY', async () => {
    await ctx.store.updateOrderFields('#1042', { confirmStatus: 'PAID_EARLY' });
    const late: MetaEvent = { ...confirmEvent, messageId: 'wamid.LATE' };
    expect(await ctx.service.handleEvent(late)).toBe('no_match');
    expect((await ctx.store.findOrderByNo('#1042'))?.confirmStatus).toBe('PAID_EARLY');
    expect(ctx.payments.created).toHaveLength(0);
  });

  it('does not throw when the phone matches no pending order', async () => {
    const unknown: MetaEvent = { ...confirmEvent, messageId: 'wamid.UNK', from: '919000000000' };
    expect(await ctx.service.handleEvent(unknown)).toBe('no_match');
    expect(ctx.whatsapp.sent).toHaveLength(0);
  });

  it('queues a cancel button reply for review rather than cancelling outright', async () => {
    const cancel: MetaEvent = {
      ...confirmEvent,
      messageId: 'wamid.CAN',
      buttonText: 'Cancel Order',
    };
    expect(await ctx.service.handleEvent(cancel)).toBe('cancelled');
    const order = await ctx.store.findOrderByNo('#1042');
    expect(order?.confirmStatus).toBe('CANCELLED');
    expect(order?.cancelStatus).toBe('REVIEW_PENDING');
    expect(ctx.payments.created).toHaveLength(0);
    expect(ctx.whatsapp.sent).toHaveLength(0);
    // Not just "no template sent" (that's true while queued regardless of whether
    // Shopify was touched) — pin that queueing never reaches Shopify either.
    expect(ctx.shopify.cancels).toEqual([]);
  });

  it('records delivery statuses against the message log', async () => {
    await ctx.store.appendMessage({
      orderNo: '#1042',
      template: 'order_confirm_cod',
      wamid: 'wamid.OUT1',
      direction: 'out',
      status: 'sent',
      timestamp: '2026-08-16T10:00:00.000Z',
    });
    const status: MetaEvent = { kind: 'status', wamid: 'wamid.OUT1', status: 'delivered' };
    expect(await ctx.service.handleEvent(status)).toBe('status_logged');
    expect(ctx.store.messages[0]?.status).toBe('delivered');
  });

  it('ignores plain text messages', async () => {
    const text: MetaEvent = {
      kind: 'text',
      messageId: 'wamid.TXT',
      from: '919876543210',
      text: 'where is my order',
    };
    expect(await ctx.service.handleEvent(text)).toBe('ignored');
    expect(ctx.whatsapp.sent).toHaveLength(0);
  });

  it('ignores an unrecognised button label', async () => {
    const other: MetaEvent = { ...confirmEvent, messageId: 'wamid.OTH', buttonText: 'Track Order' };
    expect(await ctx.service.handleEvent(other)).toBe('ignored');
  });

  it('leaves the order CONFIRMED when link creation fails, so a retry can finish the job', async () => {
    ctx.payments.failWith = new Error('Cashfree 503');
    await expect(ctx.service.handleEvent(confirmEvent)).rejects.toThrow('Cashfree 503');
    expect((await ctx.store.findOrderByNo('#1042'))?.confirmStatus).toBe('CONFIRMED');
  });
});

describe('ConfirmationService with pay-early disabled', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(async () => {
    ctx = build({ payEarlyEnabled: false });
    await ctx.store.appendOrder(order());
  });

  it('still confirms the order and stamps confirmedAt', async () => {
    expect(await ctx.service.handleEvent(confirmEvent)).toBe('confirmed');
    const row = await ctx.store.findOrderByNo('#1042');
    expect(row?.confirmStatus).toBe('CONFIRMED');
    expect(row?.confirmedAt).toBe(NOW.toISOString());
  });

  it('creates no payment link', async () => {
    await ctx.service.handleEvent(confirmEvent);
    expect(ctx.payments.created).toHaveLength(0);
  });

  it('sends no pay_early_link template', async () => {
    await ctx.service.handleEvent(confirmEvent);
    expect(ctx.whatsapp.sent).toHaveLength(0);
  });

  it('leaves paymentLink blank on the order row', async () => {
    await ctx.service.handleEvent(confirmEvent);
    const row = await ctx.store.findOrderByNo('#1042');
    expect(row?.paymentLink).toBe('');
  });

  it('does not throw even with a payment client that would fail on blank Cashfree credentials', async () => {
    ctx.payments.failWith = new Error('Cashfree 401 invalid credentials');
    await expect(ctx.service.handleEvent(confirmEvent)).resolves.toBe('confirmed');
  });
});
