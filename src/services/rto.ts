import type { ShopifyWriter } from '../adapters/shopifyAdmin.js';
import type { SheetStore } from '../adapters/sheets.js';
import type { WhatsAppClient } from '../adapters/whatsapp.js';
import { log } from '../logger.js';

/** The exact staff note the owner asked to appear on a cancelled-for-RTO Shopify order. */
export const RTO_CANCEL_NOTE = 'user cancel, user did not take delivery or cancel the delivery';
export const TEMPLATE_CANCELLED = 'order_cancelled';

export interface RtoDeps {
  store: SheetStore;
  shopify: ShopifyWriter;
  whatsapp: Pick<WhatsAppClient, 'sendTemplate'>;
  templateLang: string;
  /** Single fulfillment location restock adjustments are posted against. */
  locationId: string;
}

export class RtoService {
  constructor(private readonly deps: RtoDeps) {}

  /**
   * The parcel has started its way back. Shopify only restocks *at* cancel time, and
   * that's too early here — the goods haven't physically arrived yet — so this cancels
   * with `restock: false` and leaves the inventory adjustment to `onRtoReturned`.
   */
  async onRtoInitiated(orderNo: string): Promise<void> {
    const { store, shopify, whatsapp, templateLang } = this.deps;

    const order = await store.findOrderByNo(orderNo);
    if (!order) {
      log('warn', 'onRtoInitiated called for an unknown order', { order_no: orderNo });
      return;
    }

    await shopify.cancelOrder(order.orderId, {
      reason: 'OTHER',
      note: RTO_CANCEL_NOTE,
      restock: false,
    });
    await shopify.addTag(order.orderId, 'rto');

    await store.updateOrderFields(orderNo, {
      cancelStatus: 'CANCELLED',
      cancelReason: 'RTO',
      confirmStatus: 'CANCELLED',
    });

    // No money moved through the gateway on an RTO, and no invoice was ever raised for
    // it, so the taxable/GST fields stay at 0 — unlike a DELIVERED outcome, there is no
    // real tax event here to report.
    await store.updateLedgerOutcome(orderNo, {
      taxableValue: 0,
      gstRate: 0,
      gstOnGoods: 0,
      gstOnShipping: 0,
      outcome: 'RTO',
      collectedAmount: 0,
      platformFee: 0,
    });

    await whatsapp.sendTemplate({
      to: order.phone,
      template: TEMPLATE_CANCELLED,
      languageCode: templateLang,
      bodyParams: [order.customerName, order.orderNo, 'returned to us undelivered'],
    });
  }

  /**
   * The parcel is physically back. This is deliberately a separate effect from
   * `onRtoInitiated`: `inventoryAdjustQuantities` is a different API from `orderCancel`
   * with different failure modes, and it can partially succeed across variants — so it
   * gets its own retry rather than piggybacking on (and potentially re-running) the
   * already-succeeded cancel.
   */
  async onRtoReturned(orderNo: string): Promise<void> {
    const { store, shopify, locationId } = this.deps;

    const order = await store.findOrderByNo(orderNo);
    if (!order) {
      log('warn', 'onRtoReturned called for an unknown order', { order_no: orderNo });
      return;
    }

    const items = await shopify.getOrderLineItems(order.orderId);
    await shopify.adjustInventory(
      items.map((item) => ({ inventoryItemId: item.inventoryItemId, locationId, delta: item.quantity })),
    );
  }
}
