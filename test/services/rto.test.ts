import { describe, it, expect } from 'vitest';
import { RtoService, RTO_CANCEL_NOTE, TEMPLATE_CANCELLED, type RtoDeps } from '../../src/services/rto.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { StubShopifyWriter, StubWhatsAppClient } from '../fakes/stubClients.js';
import type { OrderRow } from '../../src/adapters/sheets.js';

const LOCATION_ID = 'gid://shopify/Location/9';

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
    fulfillmentStatus: 'RTO_INITIATED',
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

interface HarnessOpts {
  adjustThrows?: boolean;
  lineItems?: Array<{ inventoryItemId: string; quantity: number }>;
}

async function harness(opts: HarnessOpts = {}) {
  const store = new InMemorySheetStore();
  await store.appendOrder(order());
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

  const shopify = new StubShopifyWriter();
  shopify.lineItems = opts.lineItems ?? [{ inventoryItemId: 'gid://shopify/InventoryItem/1', quantity: 2 }];
  if (opts.adjustThrows) shopify.failAdjustWith = new Error('inventory adjust boom');

  const whatsapp = new StubWhatsAppClient();

  const deps: RtoDeps = {
    store,
    shopify,
    whatsapp,
    templateLang: 'en',
    locationId: LOCATION_ID,
  };
  const svc = new RtoService(deps);
  return { svc, store, shopify, whatsapp };
}

describe('RtoService', () => {
  it('cancels without restocking and tags rto on initiate', async () => {
    const { svc, shopify } = await harness();
    await svc.onRtoInitiated('#1042');
    expect(shopify.cancels).toEqual([{ orderId: '99', reason: 'OTHER', note: RTO_CANCEL_NOTE, restock: false }]);
    expect(shopify.tags).toEqual([{ orderId: '99', tag: 'rto' }]);
  });

  it('sends the cancellation message with RTO as the reason', async () => {
    const { svc, whatsapp } = await harness();
    await svc.onRtoInitiated('#1042');
    expect(whatsapp.sent[0]).toMatchObject({
      template: TEMPLATE_CANCELLED,
      bodyParams: ['Aarav', '#1042', 'returned to us undelivered'],
    });
  });

  it('records an RTO ledger outcome with no collection and no platform fee', async () => {
    const { svc, store } = await harness();
    await svc.onRtoInitiated('#1042');
    expect(store.ledger[0]).toMatchObject({ outcome: 'RTO', collectedAmount: 0, platformFee: 0 });
  });

  it('marks the order cancelled with RTO as the cancel reason', async () => {
    const { svc, store } = await harness();
    await svc.onRtoInitiated('#1042');
    const row = await store.findOrderByNo('#1042');
    expect(row).toMatchObject({ cancelStatus: 'CANCELLED', cancelReason: 'RTO', confirmStatus: 'CANCELLED' });
  });

  it('restocks only on return, not on initiate', async () => {
    const { svc, shopify } = await harness();
    await svc.onRtoInitiated('#1042');
    expect(shopify.inventoryAdjustments).toEqual([]);

    await svc.onRtoReturned('#1042');
    expect(shopify.inventoryAdjustments).toEqual([
      [{ inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/9', delta: 2 }],
    ]);
  });

  it('restocks every returned line item with its own quantity, not a fixed delta', async () => {
    // Two distinct variants with different quantities — if the delta were hardcoded
    // rather than read per-item, this would collapse to one value for both.
    const { svc, shopify } = await harness({
      lineItems: [
        { inventoryItemId: 'gid://shopify/InventoryItem/1', quantity: 2 },
        { inventoryItemId: 'gid://shopify/InventoryItem/2', quantity: 1 },
      ],
    });
    await svc.onRtoReturned('#1042');
    expect(shopify.inventoryAdjustments).toEqual([
      [
        { inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: LOCATION_ID, delta: 2 },
        { inventoryItemId: 'gid://shopify/InventoryItem/2', locationId: LOCATION_ID, delta: 1 },
      ],
    ]);
  });

  it('propagates a restock failure so the effect retries independently of the cancel', async () => {
    const { svc, shopify } = await harness({ adjustThrows: true });
    await svc.onRtoInitiated('#1042'); // succeeded
    await expect(svc.onRtoReturned('#1042')).rejects.toThrow();
    expect(shopify.cancels).toHaveLength(1); // not re-run
  });
});
