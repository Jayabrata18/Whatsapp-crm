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
   *   - cancel is skipped outright if our own sheet already says `CANCELLED`. If a
   *     retry lands after Shopify's cancel succeeded but before that sheet write
   *     landed, `cancelOrder` still gets called again — but it resolves
   *     `'already_cancelled'` rather than throwing (mirroring `markAsPaid`'s
   *     `'already_paid'`), so this no longer strands the retry here.
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
      const result = await shopify.cancelOrder(order.orderId, {
        reason: 'OTHER',
        note: RTO_CANCEL_NOTE,
        restock: false,
      });
      if (result === 'already_cancelled') {
        log('info', 'order was already cancelled in Shopify on a prior attempt, continuing', {
          order_no: orderNo,
        });
      }
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
   * The shipment row's `rtoRestockedAt` stamp guards against a whole-handler retry that
   * isn't caused by `adjustInventory` itself (a crash before this method returns, a
   * duplicate effect enqueue, etc.) — once stamped, this returns without calling
   * `adjustInventory` again.
   *
   * KNOWN GAP, deliberately not fixed here: this stamp does **not** protect against a
   * failure *inside* a single `adjustInventory` call. `ShopifyWriter.adjustInventory`
   * takes one batch of changes and returns `Promise<void>` — it throws on any
   * `userErrors`, but reports no per-item outcome, so if Shopify partially applies some
   * changes before failing validation on others, there is no way for this service to
   * tell which variants already landed. A retry after that failure re-reads the same
   * line items and re-submits the full batch, double-crediting whichever variants
   * succeeded on the failed attempt. The real fix is Shopify's `@idempotent(key:)`
   * directive on `inventoryAdjustQuantities`, optional from API version 2026-01 and
   * required from 2026-04 — this adapter is pinned to 2025-01
   * (`shopifyAdmin.ts`'s `API_VERSION`), and that version bump is tracked as its own
   * task rather than folded in here, since no test in this repo (all fetch-faked) could
   * catch a GraphQL shape regression from bumping it. Accepted deliberately: the failure
   * needs a crash mid-mutation, and the resulting error is over-restock — visible in a
   * stock count and correctable by hand — not overselling, which is customer-facing.
   */
  async onRtoReturned(orderNo: string): Promise<void> {
    const { store, shopify, locationId } = this.deps;

    const order = await store.findOrderByNo(orderNo);
    if (!order) {
      log('warn', 'onRtoReturned called for an unknown order', { order_no: orderNo });
      return;
    }

    const shipment = await store.findShipmentByAwb(order.awb);
    if (shipment?.rtoRestockedAt) {
      log('info', 'restock already recorded for this shipment, skipping adjustInventory', {
        order_no: orderNo,
        awb: order.awb,
      });
      return;
    }

    const items = await shopify.getOrderLineItems(order.orderId);
    await shopify.adjustInventory(
      items.map((item) => ({ inventoryItemId: item.inventoryItemId, locationId, delta: item.quantity })),
    );

    if (shipment) {
      await store.upsertShipment({ ...shipment, rtoRestockedAt: this.now().toISOString() });
    } else {
      // No shipment row to stamp — the restock still happened, but a subsequent retry
      // has nothing to check against and would run adjustInventory again. Should not
      // occur in practice: onRtoReturned only fires from a shipment status transition,
      // which is exactly what writes this row (Task 15).
      log('warn', 'no shipment row found to stamp the restock against', {
        order_no: orderNo,
        awb: order.awb,
      });
    }
  }
}
