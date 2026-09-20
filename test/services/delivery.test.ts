import { describe, it, expect } from 'vitest';
import { DeliveryService, type DeliveryDeps, type InvoiceIssuer } from '../../src/services/delivery.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { StubShopifyWriter } from '../fakes/stubClients.js';
import type { GstRates } from '../../src/core/gst.js';
import type { ConfirmStatus, OrderRow } from '../../src/adapters/sheets.js';

const NOW = new Date('2026-09-15T09:00:00.000Z');
const RATES: GstRates = { thresholdInr: 2500, low: 5, high: 18 };
const PLATFORM_FEE_PCT = 5;

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    orderNo: '#1042',
    orderId: '99',
    customerName: 'Aarav',
    phone: '919876543210',
    amount: 1899,
    codFee: 0,
    payable: 1899,
    isCod: true,
    confirmStatus: 'CONFIRMED',
    paymentLink: '',
    createdAt: '2026-09-01T10:00:00.000Z',
    confirmedAt: '2026-09-01T10:05:00.000Z',
    paidAt: '',
    fulfillmentStatus: 'DELIVERED',
    awb: 'SF000000001',
    cancelStatus: 'NONE',
    cancelReason: '',
    invoiceNo: '',
    rating: '',
    gstDiscrepancy: 0,
    linesJson: JSON.stringify([{ inclUnitPrice: 1800, quantity: 1 }]),
    ...overrides,
  };
}

/** Records every order number it was asked to invoice; can be made to throw. */
class StubInvoicingService implements InvoiceIssuer {
  issued: string[] = [];
  throwWith: Error | null = null;

  async issueForOrder(orderNo: string): Promise<{ invoiceNo: string } | null> {
    if (this.throwWith) throw this.throwWith;
    this.issued.push(orderNo);
    return { invoiceNo: 'UM/26-27/0001' };
  }
}

interface HarnessOpts {
  isCod?: boolean;
  amount?: number;
  payable?: number;
  paidAt?: string;
  confirmStatus?: ConfirmStatus;
  invoicingThrows?: boolean;
  markAsPaidResult?: 'marked' | 'already_paid';
}

async function harness(opts: HarnessOpts = {}) {
  const store = new InMemorySheetStore();
  const amount = opts.amount ?? 1899;
  const payable = opts.payable ?? amount;

  await store.appendOrder(
    order({
      isCod: opts.isCod ?? true,
      amount,
      payable,
      paidAt: opts.paidAt ?? '',
      confirmStatus: opts.confirmStatus ?? 'CONFIRMED',
    }),
  );
  await store.appendLedgerOrder(
    {
      orderNo: '#1042',
      orderDate: '2026-09-01',
      pincode: '700001',
      state: 'West Bengal',
      posCode: '19',
      skus: 'TEE-BLK-L x1',
      itemAmount: 1800,
      shippingCharged: 99,
      grossAmount: 1899,
      isCod: opts.isCod ?? true,
    },
    25,
  );

  const shopify = new StubShopifyWriter();
  shopify.markAsPaidResult = opts.markAsPaidResult ?? 'marked';
  const invoicing = new StubInvoicingService();
  if (opts.invoicingThrows) invoicing.throwWith = new Error('invoicing boom');

  const deps: DeliveryDeps = {
    store,
    shopify,
    invoicing,
    rates: RATES,
    platformFeePct: PLATFORM_FEE_PCT,
    now: () => NOW,
  };
  const svc = new DeliveryService(deps);
  return { svc, store, shopify, invoicing };
}

describe('DeliveryService', () => {
  it('marks a COD order paid in Shopify', async () => {
    const { svc, shopify } = await harness({ isCod: true });
    await svc.onDelivered('#1042');
    expect(shopify.markedPaid).toEqual(['99']);
  });

  it('does not mark a prepaid order paid', async () => {
    const { svc, shopify } = await harness({ isCod: false });
    await svc.onDelivered('#1042');
    expect(shopify.markedPaid).toEqual([]);
  });

  it('writes the DELIVERED ledger outcome with the platform fee on the collected amount', async () => {
    const { svc, store } = await harness({ isCod: true, amount: 1899 });
    await svc.onDelivered('#1042');
    expect(store.ledger[0]).toMatchObject({ outcome: 'DELIVERED', collectedAmount: 1899, platformFee: 94.95 });
  });

  it('issues the invoice', async () => {
    const { svc, invoicing } = await harness();
    await svc.onDelivered('#1042');
    expect(invoicing.issued).toEqual(['#1042']);
  });

  it('propagates an invoicing failure so the effect retries', async () => {
    const { svc } = await harness({ invoicingThrows: true });
    await expect(svc.onDelivered('#1042')).rejects.toThrow();
  });

  it('does not re-mark an order that is already paid', async () => {
    const { svc, shopify } = await harness({ isCod: true, paidAt: '2026-09-10T00:00:00.000Z' });
    await svc.onDelivered('#1042');
    expect(shopify.markedPaid).toEqual([]);
  });

  it('stamps paidAt on the order row when marking a COD order paid', async () => {
    const { svc, store } = await harness({ isCod: true });
    await svc.onDelivered('#1042');
    expect((await store.findOrderByNo('#1042'))?.paidAt).toBe(NOW.toISOString());
  });

  it('writes the real GST split to the ledger, not zeros, for a delivered order', async () => {
    // item_amount 1800 + shipping_charged 99 at the 5% slab: computeGst backs out tax
    // from the 1899 actually collected. If this were hardcoded to 0 (or to some other
    // constant), these exact numbers would not appear — this proves computeGst ran.
    const { svc, store } = await harness({ isCod: true, amount: 1899 });
    await svc.onDelivered('#1042');
    expect(store.ledger[0]).toMatchObject({
      taxableValue: 1808.58,
      gstRate: 5,
      gstOnGoods: 85.71,
      gstOnShipping: 4.71,
    });
  });

  it('uses payable, not amount, as the collected amount for a genuinely PAID_EARLY order', async () => {
    // Mirrors the invoicing fix: a PAID_EARLY order collected the discounted `payable`
    // through the gateway, not the full `amount` a COD customer would hand over at the
    // door. The ledger must agree with what invoicing bills, or the two contradict.
    const { svc, store } = await harness({
      isCod: true,
      confirmStatus: 'PAID_EARLY',
      paidAt: '2026-09-05T00:00:00.000Z',
      amount: 1899,
      payable: 1849,
    });
    await svc.onDelivered('#1042');
    expect(store.ledger[0]).toMatchObject({ collectedAmount: 1849, platformFee: 92.45 });
  });

  it('completes the whole delivered flow on a retry against an order Shopify already marked paid', async () => {
    // Mirrors a real retry: a prior attempt's markAsPaid call actually landed in Shopify,
    // but a later step (this write, the ledger, invoicing) failed before that attempt
    // finished, so the effect queue re-runs onDelivered from the top. Shopify's own
    // markAsPaid mutation creates no second transaction here and resolves 'already_paid'
    // instead of throwing — this must not stall the rest of the sequence.
    const { svc, store, shopify, invoicing } = await harness({
      isCod: true,
      markAsPaidResult: 'already_paid',
    });
    await svc.onDelivered('#1042');

    expect(shopify.markedPaid).toEqual(['99']); // the call still happens on every attempt
    expect((await store.findOrderByNo('#1042'))?.paidAt).toBe(NOW.toISOString());
    expect(store.ledger[0]).toMatchObject({ outcome: 'DELIVERED' });
    expect(invoicing.issued).toEqual(['#1042']);
  });
});
