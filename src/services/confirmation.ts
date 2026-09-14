import { matchesCancel, matchesConfirm, type MetaEvent } from '../core/metaWebhook.js';
import type { SheetStore } from '../adapters/sheets.js';
import type { WhatsAppClient } from '../adapters/whatsapp.js';
import type { PaymentLinkClient } from '../adapters/cashfree.js';
import { log } from '../logger.js';

export type ConfirmResult =
  | 'confirmed'
  | 'cancelled'
  | 'duplicate'
  | 'no_match'
  | 'status_logged'
  | 'ignored';

export const TEMPLATE_PAY_LINK = 'pay_early_link';

export interface ConfirmationDeps {
  store: SheetStore;
  whatsapp: WhatsAppClient;
  payments: PaymentLinkClient;
  templateLang: string;
  linkExpiryHours: number;
  now?: () => Date;
}

/**
 * '#1042' -> 'urbnmyth-1042'. Deterministic on purpose: Cashfree rejects a
 * duplicate link_id, which is a second layer of protection against creating
 * two payment links for one order.
 */
export function paymentLinkId(orderNo: string): string {
  return `urbnmyth-${orderNo.replace(/[^a-zA-Z0-9]/g, '')}`;
}

export class ConfirmationService {
  private readonly now: () => Date;

  constructor(private readonly deps: ConfirmationDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async handleEvent(event: MetaEvent): Promise<ConfirmResult> {
    const { store } = this.deps;

    if (event.kind === 'status') {
      await store.updateMessageStatus(event.wamid, event.status);
      return 'status_logged';
    }

    if (await store.hasEvent('meta', event.messageId)) {
      return 'duplicate';
    }
    await store.recordEvent('meta', event.messageId);

    if (event.kind === 'text') {
      log('info', 'inbound text message ignored', { from: event.from });
      return 'ignored';
    }

    const isConfirm = matchesConfirm(event.buttonText);
    const isCancel = matchesCancel(event.buttonText);
    if (!isConfirm && !isCancel) {
      log('info', 'unrecognised button ignored', { button: event.buttonText });
      return 'ignored';
    }

    const order = await store.findLatestPendingByPhone(event.from);
    if (!order) {
      log('warn', 'button reply matched no pending order', { from: event.from });
      return 'no_match';
    }

    const timestamp = this.now().toISOString();

    await store.appendMessage({
      orderNo: order.orderNo,
      template: `button:${event.buttonText}`,
      wamid: event.messageId,
      direction: 'in',
      status: 'received',
      timestamp,
    });

    if (isCancel) {
      await store.updateOrderFields(order.orderNo, { confirmStatus: 'CANCELLED' });
      log('info', 'order cancelled by customer', { order_no: order.orderNo });
      return 'cancelled';
    }

    await store.updateOrderFields(order.orderNo, {
      confirmStatus: 'CONFIRMED',
      confirmedAt: timestamp,
    });

    // The amount comes from the row written at intake, never recomputed here:
    // the customer was quoted that number in the confirmation message, and the
    // link must match it even if COD_FEE_INR changed in between.
    const linkId = paymentLinkId(order.orderNo);
    const link = await this.deps.payments.createLink({
      linkId,
      amount: order.payable,
      customerName: order.customerName,
      customerPhone: order.phone,
      purpose: `Order ${order.orderNo}`,
      expiryHours: this.deps.linkExpiryHours,
    });

    await store.updateOrderFields(order.orderNo, { paymentLink: link.linkUrl });

    const { wamid } = await this.deps.whatsapp.sendTemplate({
      to: order.phone,
      template: TEMPLATE_PAY_LINK,
      languageCode: this.deps.templateLang,
      bodyParams: [order.customerName, String(order.payable), String(order.codFee)],
      urlButtonSuffix: link.linkId,
    });

    await store.appendMessage({
      orderNo: order.orderNo,
      template: TEMPLATE_PAY_LINK,
      wamid,
      direction: 'out',
      status: 'sent',
      timestamp,
    });

    log('info', 'order confirmed and payment link sent', {
      order_no: order.orderNo,
      payable: order.payable,
    });
    return 'confirmed';
  }
}
