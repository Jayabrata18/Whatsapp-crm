import { paymentLinkId } from './confirmation.js';
import type { SheetStore } from '../adapters/sheets.js';
import type { OrderTagger } from '../adapters/shopifyAdmin.js';
import { log } from '../logger.js';

export type PaymentResult = 'paid' | 'duplicate' | 'no_match' | 'ignored';

export const PAID_EARLY_TAG = 'paid-early';

export interface PaymentDeps {
  store: SheetStore;
  tagger: OrderTagger;
  now?: () => Date;
}

interface CashfreePayload {
  data?: {
    link_id?: unknown;
    link_status?: unknown;
    order?: { order_id?: unknown } | null;
  } | null;
}

export class PaymentService {
  private readonly now: () => Date;

  constructor(private readonly deps: PaymentDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async handle(payload: unknown): Promise<PaymentResult> {
    const { store, tagger } = this.deps;
    const data = (payload as CashfreePayload)?.data ?? {};

    const linkId = typeof data.link_id === 'string' ? data.link_id : null;
    if (!linkId) {
      log('info', 'cashfree webhook has no link_id, ignored');
      return 'ignored';
    }

    if (data.link_status !== 'PAID') {
      log('info', 'cashfree webhook is not a completed payment, ignored', {
        link_id: linkId,
        link_status: String(data.link_status),
      });
      return 'ignored';
    }

    const externalId = typeof data.order?.order_id === 'string' ? data.order.order_id : linkId;
    if (await store.hasEvent('cashfree', externalId)) {
      return 'duplicate';
    }
    await store.recordEvent('cashfree', externalId);

    // The link id was derived from the order number at confirmation time, so
    // reversing that derivation avoids storing a second lookup key.
    const orders = await store.listOrders();
    const order = orders.find((row) => paymentLinkId(row.orderNo) === linkId);

    if (!order) {
      log('warn', 'cashfree payment matched no order', { link_id: linkId });
      return 'no_match';
    }

    if (order.confirmStatus === 'PAID_EARLY') {
      log('info', 'order already marked paid', { order_no: order.orderNo });
      return 'duplicate';
    }

    await store.updateOrder(order.orderNo, {
      confirmStatus: 'PAID_EARLY',
      paidAt: this.now().toISOString(),
    });

    try {
      await tagger.addTag(order.orderId, PAID_EARLY_TAG);
    } catch (error) {
      // The money is already collected. Answering 500 here would make Cashfree
      // retry a webhook for a payment that succeeded, so this is logged only.
      log('error', 'shopify tagging failed after payment', {
        order_no: order.orderNo,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    log('info', 'order paid early', { order_no: order.orderNo, amount: order.payable });
    return 'paid';
  }
}
