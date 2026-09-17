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
  now?: () => Date;
}

export class RtoService {
  private readonly now: () => Date;

  constructor(private readonly deps: RtoDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * The parcel has started its way back. Shopify only restocks *at* cancel time, and
   * that's too early here — the goods haven't physically arrived yet — so this cancels
   * with `restock: false` and leaves the inventory adjustment to `onRtoReturned`.
   *
   * The effect queue that calls this retries the *whole handler* on failure, not
   * individual steps, so every step here is guarded on state actually observed
   * rather than assumed not to have run yet:
   *   - cancel only fires if the order isn't already `CANCELLED` — Shopify has no
   *     "cancel an already-cancelled order" no-op, so calling it twice would error
   *     and strand the retry here forever.
   *   - tag and the ledger write are naturally idempotent (re-tagging is a no-op;
   *     the ledger write repeats the same K–Q values), so they always run.
   *   - the message send is guarded by the message log, which doubles as the record
   *     of whether the customer actually got told — the same shape
   *     `InvoicingService.issueForOrder` uses to resume a partially-completed run.
   */
  async onRtoInitiated(orderNo: string): Promise<void> {
    const { store, shopify, whatsapp, templateLang } = this.deps;

    const order = await store.findOrderByNo(orderNo);
    if (!order) {
      log('warn', 'onRtoInitiated called for an unknown order', { order_no: orderNo });
      return;
    }

    if (order.cancelStatus !== 'CANCELLED') {
      await shopify.cancelOrder(order.orderId, {
        reason: 'OTHER',
        note: RTO_CANCEL_NOTE,
        restock: false,
      });
    }

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

    const alreadySent = (await store.listMessages()).some(
      (message) =>
        message.orderNo === orderNo &&
        message.template === TEMPLATE_CANCELLED &&
        message.direction === 'out',
    );
    if (alreadySent) return;

    const timestamp = this.now().toISOString();
    const { wamid } = await whatsapp.sendTemplate({
      to: order.phone,
      template: TEMPLATE_CANCELLED,
      languageCode: templateLang,
      bodyParams: [order.customerName, order.orderNo, 'returned to us undelivered'],
    });
    await store.appendMessage({
      orderNo, template: TEMPLATE_CANCELLED, wamid, direction: 'out', status: 'sent', timestamp,
    });
  }

  /**
   * The parcel is physically back. This is deliberately a separate effect from
   * `onRtoInitiated`: `inventoryAdjustQuantities` is a different API from `orderCancel`
   * with different failure modes, and it can partially succeed across variants — so it
   * gets its own retry rather than piggybacking on (and potentially re-running) the
   * already-succeeded cancel.
   *
   * KNOWN GAP: this method is not safe against a retry after a *partial* success inside
   * `adjustInventory` itself. `ShopifyWriter.adjustInventory` takes one batch of changes
   * and returns `Promise<void>` — it throws on any `userErrors`, but reports no per-item
   * outcome, so on a partial failure there is no way for this service to tell which
   * variants already landed and which didn't. A naive retry re-reads the same line items
   * from `getOrderLineItems` and re-submits the full batch, double-crediting whichever
   * variants succeeded on the failed attempt. Making this safe would need either the
   * Shopify adapter to report per-change results, or a persisted per-item "restocked"
   * marker written before/after each change — both outside this file's scope. Left as an
   * open gap rather than a false guarantee; see the Task 17/18 report.
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
