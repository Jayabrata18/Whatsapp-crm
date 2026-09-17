import type { ShopifyWriter } from '../adapters/shopifyAdmin.js';
import type { OrderRow, SheetStore } from '../adapters/sheets.js';
import type { WhatsAppClient } from '../adapters/whatsapp.js';
import { TEMPLATE_CANCELLED } from './rto.js';
import { log } from '../logger.js';

export interface CancellationDeps {
  store: SheetStore;
  shopify: Pick<ShopifyWriter, 'cancelOrder'>;
  whatsapp: Pick<WhatsAppClient, 'sendTemplate'>;
  templateLang: string;
  now?: () => Date;
}

/**
 * A customer's "Cancel Order" tap only ever queues the order for operator review —
 * it never touches Shopify and never tells the customer anything. A mis-tap
 * shouldn't silently cancel a live order, and telling the customer they're
 * cancelled only to un-cancel a moment later on review is worse than a few
 * hours' delay. Shopify is only touched, and the customer only messaged, once
 * an operator calls `approve`.
 */
export class CancellationService {
  private readonly now: () => Date;

  constructor(private readonly deps: CancellationDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async queueForReview(orderNo: string, reason: 'CUSTOMER_REQUEST'): Promise<void> {
    const { store } = this.deps;

    const order = await store.findOrderByNo(orderNo);
    if (!order) {
      log('warn', 'queueForReview called for an unknown order', { order_no: orderNo });
      return;
    }

    await store.updateOrderFields(orderNo, {
      confirmStatus: 'CANCELLED',
      cancelStatus: 'REVIEW_PENDING',
      cancelReason: reason,
    });
  }

  async listPendingReview(): Promise<OrderRow[]> {
    const orders = await this.deps.store.listOrders();
    return orders.filter((order) => order.cancelStatus === 'REVIEW_PENDING');
  }

  /**
   * Guarded on `cancelStatus === 'REVIEW_PENDING'` so a double-click (or a repeated
   * call from the dashboard) can't cancel twice or send two messages: once this
   * completes, `cancelStatus` moves to `CANCELLED` and a second call is a no-op.
   *
   * Nothing shipped for a customer-initiated cancel, so — unlike an RTO cancel,
   * which passes `restock: false` because the goods are still in transit back —
   * this passes `restock: true`: cancel-time restock is correct here.
   *
   * The send itself is additionally guarded by the message log (the same shape
   * `RtoService.onRtoInitiated` uses), so a retry that lands after the Shopify
   * cancel and the sheet writes already succeeded doesn't double-message the
   * customer.
   *
   * A retry can also land in between: the Shopify cancel succeeds, but the
   * `cancelStatus: 'CANCELLED'` write fails before it lands, leaving
   * `cancelStatus` at `REVIEW_PENDING`. Without care, a retry would then call
   * `cancelOrder` a second time against an order Shopify already cancelled and
   * throw, stranding the order in the review queue forever with no way out.
   * `cancelOrder` resolves `'already_cancelled'` for exactly that case instead
   * of throwing (mirroring `markAsPaid`'s `'already_paid'`), so this treats
   * both outcomes as "Shopify is cancelled" and carries on to the rest of the
   * sequence.
   */
  async approve(orderNo: string): Promise<void> {
    const { store, shopify, whatsapp, templateLang } = this.deps;

    const order = await store.findOrderByNo(orderNo);
    if (!order || order.cancelStatus !== 'REVIEW_PENDING') {
      return;
    }

    const result = await shopify.cancelOrder(order.orderId, {
      reason: 'CUSTOMER',
      note: 'customer cancelled',
      restock: true,
    });
    if (result === 'already_cancelled') {
      log('info', 'order was already cancelled in Shopify on a prior attempt, continuing', {
        order_no: orderNo,
      });
    }

    await store.updateOrderFields(orderNo, { cancelStatus: 'CANCELLED' });

    // No money moved through the gateway and no invoice was ever raised for an order
    // that never shipped, so — exactly like an RTO outcome — the taxable/GST fields
    // stay at 0: there is no real tax event here to report.
    await store.updateLedgerOutcome(orderNo, {
      taxableValue: 0,
      gstRate: 0,
      gstOnGoods: 0,
      gstOnShipping: 0,
      outcome: 'CANCELLED',
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
      bodyParams: [order.customerName, order.orderNo, 'cancelled at your request'],
    });
    await store.appendMessage({
      orderNo, template: TEMPLATE_CANCELLED, wamid, direction: 'out', status: 'sent', timestamp,
    });
  }
}
