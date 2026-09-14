import { describe, it, expect, beforeEach } from 'vitest';
import { OrderIntakeService } from '../../src/services/orderIntake.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { StubWhatsAppClient } from '../fakes/stubClients.js';
import { shopifyOrderPayload } from '../fixtures/shopifyOrder.js';
import type { GstRates } from '../../src/core/gst.js';

const NOW = new Date('2026-08-16T10:00:00.000Z');
const RATES: GstRates = { thresholdInr: 2500, low: 5, high: 18 };
const CORPORATE_TAX_PCT = 25;

function build() {
  const store = new InMemorySheetStore();
  const whatsapp = new StubWhatsAppClient();
  const service = new OrderIntakeService({
    store,
    whatsapp,
    codFeeInr: 50,
    codGatewayNames: ['cash on delivery', 'cod'],
    templateLang: 'en',
    rates: RATES,
    corporateTaxPct: CORPORATE_TAX_PCT,
    now: () => NOW,
  });
  return { store, whatsapp, service };
}

describe('OrderIntakeService', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => {
    ctx = build();
  });

  it('writes a PENDING order row with waived-fee pricing', async () => {
    const result = await ctx.service.handle(shopifyOrderPayload());
    expect(result).toBe('processed');

    const row = await ctx.store.findOrderByNo('#1042');
    expect(row).toMatchObject({
      orderNo: '#1042',
      orderId: '5544332211',
      phone: '919876543210',
      amount: 1899,
      codFee: 50,
      payable: 1849,
      isCod: true,
      confirmStatus: 'PENDING',
      paymentLink: '',
      createdAt: NOW.toISOString(),
      confirmedAt: '',
      paidAt: '',
      fulfillmentStatus: 'NEW',
      awb: '',
      cancelStatus: 'NONE',
      cancelReason: '',
      invoiceNo: '',
      rating: '',
      gstDiscrepancy: 0,
    });
  });

  it('sends order_confirm_cod for a COD order with the right body params', async () => {
    await ctx.service.handle(shopifyOrderPayload());
    expect(ctx.whatsapp.sent).toHaveLength(1);
    expect(ctx.whatsapp.sent[0]).toMatchObject({
      to: '919876543210',
      template: 'order_confirm_cod',
      languageCode: 'en',
      bodyParams: ['Aarav', '#1042', 'Oversized Tee — Black x2, Cargo Pants — Olive x1', '1899'],
    });
  });

  it('sends order_confirm_prepaid for a prepaid order and charges no fee', async () => {
    await ctx.service.handle(
      shopifyOrderPayload({
        payment_gateway_names: ['Razorpay Secure'],
        financial_status: 'paid',
      }),
    );
    expect(ctx.whatsapp.lastTemplate).toBe('order_confirm_prepaid');
    const row = await ctx.store.findOrderByNo('#1042');
    expect(row).toMatchObject({ isCod: false, codFee: 0, payable: 1899 });
  });

  it('logs the send to the messages tab', async () => {
    await ctx.service.handle(shopifyOrderPayload());
    expect(ctx.store.messages[0]).toEqual({
      orderNo: '#1042',
      template: 'order_confirm_cod',
      wamid: 'wamid.STUB1',
      direction: 'out',
      status: 'sent',
      timestamp: NOW.toISOString(),
    });
  });

  it('ignores a duplicate webhook — one row, one message', async () => {
    await ctx.service.handle(shopifyOrderPayload());
    const second = await ctx.service.handle(shopifyOrderPayload());

    expect(second).toBe('duplicate');
    expect(await ctx.store.listOrders()).toHaveLength(1);
    expect(ctx.whatsapp.sent).toHaveLength(1);
  });

  it('skips an order with no usable phone but still records it', async () => {
    const result = await ctx.service.handle(
      shopifyOrderPayload({
        shipping_address: { phone: '12345' },
        customer: { first_name: 'Aarav', phone: null },
        billing_address: { phone: null },
      }),
    );

    expect(result).toBe('skipped_no_phone');
    expect(ctx.whatsapp.sent).toHaveLength(0);
    const row = await ctx.store.findOrderByNo('#1042');
    expect(row?.phone).toBe('');
    expect(row?.confirmStatus).toBe('NO_RESPONSE');
  });

  it('records the event before sending, so a send failure is not retried into a double-send', async () => {
    ctx.whatsapp.failWith = new Error('Meta 500');
    await expect(ctx.service.handle(shopifyOrderPayload())).rejects.toThrow('Meta 500');
    expect(await ctx.store.hasEvent('shopify', '5544332211')).toBe(true);
    expect(await ctx.store.listOrders()).toHaveLength(1);
  });

  it('propagates a parse failure so the route can answer 500', async () => {
    await expect(ctx.service.handle({ name: '#1042' })).rejects.toThrow(/id/);
  });

  it('writes a ledger row at order intake', async () => {
    await ctx.service.handle(shopifyOrderPayload());
    expect(ctx.store.ledger).toHaveLength(1);
    expect(ctx.store.ledger[0]).toMatchObject({ orderNo: '#1042', posCode: '19' });
  });

  it('leaves the operator block untouched at intake', async () => {
    await ctx.service.handle(shopifyOrderPayload());
    expect(ctx.store.ledger[0]).not.toHaveProperty('cogs');
    expect(ctx.store.ledger[0]).not.toHaveProperty('rtoLoss');
  });

  it('records no discrepancy when Shopify agrees with the slab rule', async () => {
    // ₹1899 inclusive at 5% → ₹90.43 GST; the payload's tax_lines say the same.
    await ctx.service.handle(shopifyOrderPayload({ tax_lines: [{ price: '90.43' }] }));
    expect((await ctx.store.findOrderByNo('#1042'))?.gstDiscrepancy).toBe(0);
  });

  it('records the gap when Shopify charged a different rate', async () => {
    await ctx.service.handle(shopifyOrderPayload({ tax_lines: [{ price: '289.68' }] })); // 18%
    expect((await ctx.store.findOrderByNo('#1042'))?.gstDiscrepancy).toBe(199.25);
  });

  it('treats a gap under ₹1 as agreement, since per-line rounding always drifts', async () => {
    await ctx.service.handle(shopifyOrderPayload({ tax_lines: [{ price: '90.90' }] }));
    expect((await ctx.store.findOrderByNo('#1042'))?.gstDiscrepancy).toBe(0);
  });

  it('records no discrepancy when the payload carries no tax_lines at all', async () => {
    await ctx.service.handle(shopifyOrderPayload({ tax_lines: undefined }));
    expect((await ctx.store.findOrderByNo('#1042'))?.gstDiscrepancy).toBe(0);
  });
});
