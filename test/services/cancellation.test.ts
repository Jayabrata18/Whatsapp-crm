import { describe, it, expect } from 'vitest';
import { CancellationService, type CancellationDeps } from '../../src/services/cancellation.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { StubShopifyWriter, StubWhatsAppClient } from '../fakes/stubClients.js';
import type { OrderRow } from '../../src/adapters/sheets.js';

const NOW = new Date('2026-09-15T09:00:00.000Z');

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
    fulfillmentStatus: 'NEW',
    awb: '',
    cancelStatus: 'NONE',
    cancelReason: '',
    invoiceNo: '',
    rating: '',
    gstDiscrepancy: 0,
    linesJson: JSON.stringify([{ inclUnitPrice: 1800, quantity: 1 }]),
    ...overrides,
  };
}

interface HarnessOpts {
  extraOrders?: Array<Partial<OrderRow>>;
}

async function harness(opts: HarnessOpts = {}) {
  const store = new InMemorySheetStore();
  await store.appendOrder(order());
  for (const extra of opts.extraOrders ?? []) {
    await store.appendOrder(order({ orderNo: '#other', ...extra }));
  }

  const shopify = new StubShopifyWriter();
  const whatsapp = new StubWhatsAppClient();

  const deps: CancellationDeps = {
    store,
    shopify,
    whatsapp,
    templateLang: 'en',
    now: () => NOW,
  };
  const svc = new CancellationService(deps);
  return { svc, store, shopify, whatsapp };
}

describe('CancellationService', () => {
  it('queues without touching Shopify or messaging the customer', async () => {
    const { svc, shopify, whatsapp, store } = await harness();
    await svc.queueForReview('#1042', 'CUSTOMER_REQUEST');

    expect(shopify.cancels).toEqual([]);
    expect(whatsapp.sent).toEqual([]); // telling them, then un-cancelling, is worse than a delay
    expect((await store.findOrderByNo('#1042'))?.cancelStatus).toBe('REVIEW_PENDING');
  });

  it('cancels WITH restock on approval, since nothing shipped', async () => {
    const { svc, shopify } = await harness();
    await svc.queueForReview('#1042', 'CUSTOMER_REQUEST');
    await svc.approve('#1042');
    expect(shopify.cancels).toEqual([
      { orderId: '99', reason: 'CUSTOMER', note: 'customer cancelled', restock: true },
    ]);
  });

  it('marks the order CANCELLED after approval', async () => {
    // Distinct from the Shopify-call assertion above: a fake could record the cancel call
    // without ever updating the sheet, which would leave the review queue reporting a
    // cancellation that never happened from the operator's point of view.
    const { svc, store } = await harness();
    await svc.queueForReview('#1042', 'CUSTOMER_REQUEST');
    await svc.approve('#1042');
    expect((await store.findOrderByNo('#1042'))?.cancelStatus).toBe('CANCELLED');
  });

  it('records a CANCELLED ledger outcome with no collection and no platform fee', async () => {
    const { svc, store } = await harness();
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
        isCod: true,
      },
      25,
    );
    await svc.queueForReview('#1042', 'CUSTOMER_REQUEST');
    await svc.approve('#1042');
    expect(store.ledger[0]).toMatchObject({ outcome: 'CANCELLED', collectedAmount: 0, platformFee: 0 });
  });

  it('sends the cancellation message only after approval', async () => {
    const { svc, whatsapp } = await harness();
    await svc.queueForReview('#1042', 'CUSTOMER_REQUEST');
    expect(whatsapp.sent).toEqual([]);

    await svc.approve('#1042');
    expect(whatsapp.sent[0]).toMatchObject({
      template: 'order_cancelled',
      bodyParams: ['Aarav', '#1042', 'cancelled at your request'],
    });
  });

  it('lists only orders awaiting review', async () => {
    const { svc, store } = await harness({ extraOrders: [{ cancelStatus: 'NONE' }] });
    await svc.queueForReview('#1042', 'CUSTOMER_REQUEST');
    expect((await svc.listPendingReview()).map((o) => o.orderNo)).toEqual(['#1042']);
    // Sanity check the fixture actually seeded a second, non-matching order —
    // otherwise this assertion would pass even if the filter were deleted.
    expect((await store.listOrders())).toHaveLength(2);
  });

  it('is a no-op when approving an order that is not pending review', async () => {
    const { svc, shopify, whatsapp, store } = await harness();
    await svc.approve('#1042');
    expect(shopify.cancels).toEqual([]);
    expect(whatsapp.sent).toEqual([]);
    expect((await store.findOrderByNo('#1042'))?.cancelStatus).toBe('NONE');
  });

  it('does not cancel or message twice on a double-approve', async () => {
    const { svc, shopify, whatsapp } = await harness();
    await svc.queueForReview('#1042', 'CUSTOMER_REQUEST');
    await svc.approve('#1042');
    await svc.approve('#1042');
    expect(shopify.cancels).toHaveLength(1);
    expect(whatsapp.sent).toHaveLength(1);
  });
});
