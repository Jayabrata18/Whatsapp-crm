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
   * GAP THIS CLOSES (was open, now fixed by Task 25): this stamp does **not** protect
   * against a failure *inside* a single `adjustInventory` call. `ShopifyWriter.adjustInventory`
   * takes one batch of changes and returns `Promise<void>` — it throws on any
   * `userErrors`, but reports no per-item outcome, so if Shopify partially applies some
   * changes before failing validation on others, there is no way for this service to
   * tell which variants already landed. A retry after that failure would re-read the
   * same line items and re-submit the full batch, double-crediting whichever variants
   * succeeded on the failed attempt. `adjustInventory` now takes a second
   * `idempotencyKey` argument, threaded through to `inventoryAdjustQuantities`'s
   * `@idempotent(key:)` directive, which Shopify guarantees collapses a retried call
   * with the same key into a no-op rather than reapplying it. The key below is derived
   * deterministically from the order number and AWB — not a timestamp, a random UUID, or
   * an attempt counter — specifically so a retry of this same restock reuses the
   * identical key and Shopify recognises it as the same operation. This stamp
   * (`rtoRestockedAt`) still guards the *outer* whole-handler retry (skips calling
   * `adjustInventory` again at all); `@idempotent` guards the *inner* window where a
   * call was made but its outcome is unknown. Complementary, not redundant.
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
    if (items.length === 0) {
      // `getOrderLineItems` filters out any node without `variant.inventoryItem.id`
      // (a deleted product, a custom line item) and returns [] when the order can't be
      // read at all. Calling adjustInventory([]) would succeed trivially and the stamp
      // below would mark this shipment restocked forever, with the goods never returning
      // to stock and nothing saying so. Return before the stamp: an unstamped shipment
      // stays retryable, and this log is the operator's cue to restock by hand.
      log('error', 'no restockable line items for an RTO return — nothing adjusted, not stamped', {
        order_no: orderNo,
        order_id: order.orderId,
        awb: order.awb,
      });
      return;
    }

    // Deterministic on purpose: derived only from the order number and AWB, which don't
    // change between attempts, so a retry of this exact restock reuses the identical key
    // and Shopify's @idempotent directive collapses it into a no-op instead of
    // double-applying the delta. No Date.now(), no crypto.randomUUID(), no attempt
    // counter — any of those would produce a fresh key each retry and defeat the point.
    const idempotencyKey = `rto-restock:${order.orderNo}:${order.awb}`;
    await shopify.adjustInventory(
      items.map((item) => ({ inventoryItemId: item.inventoryItemId, locationId, delta: item.quantity })),
      idempotencyKey,
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
