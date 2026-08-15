import { computePricing } from '../core/incentive.js';
import { parseShopifyOrder } from '../core/shopifyOrder.js';
import type { OrderRow, SheetStore } from '../adapters/sheets.js';
import type { WhatsAppClient } from '../adapters/whatsapp.js';
import { log } from '../logger.js';

export type IntakeResult = 'processed' | 'duplicate' | 'skipped_no_phone';

export interface OrderIntakeDeps {
  store: SheetStore;
  whatsapp: WhatsAppClient;
  codFeeInr: number;
  codGatewayNames: string[];
  templateLang: string;
  now?: () => Date;
}

export const TEMPLATE_COD = 'order_confirm_cod';
export const TEMPLATE_PREPAID = 'order_confirm_prepaid';

export class OrderIntakeService {
  private readonly now: () => Date;

  constructor(private readonly deps: OrderIntakeDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * The ordering here is deliberate: the event is recorded and the row written
   * BEFORE the message is sent. If the send throws, the route answers 500 and
   * the sender retries — and the retry hits the dedupe check, so the customer
   * never gets two messages. Losing one message is recoverable; double-messaging
   * a customer is not.
   */
  async handle(payload: unknown): Promise<IntakeResult> {
    const { store, whatsapp, codFeeInr, codGatewayNames, templateLang } = this.deps;

    const parsed = parseShopifyOrder(payload, codGatewayNames);

    if (await store.hasEvent('shopify', parsed.orderId)) {
      log('info', 'shopify webhook ignored as duplicate', { order_no: parsed.orderNo });
      return 'duplicate';
    }
    await store.recordEvent('shopify', parsed.orderId);

    const pricing = computePricing(parsed.amount, parsed.isCod, codFeeInr);
    const timestamp = this.now().toISOString();
    const hasPhone = parsed.phone !== null;

    const row: OrderRow = {
      orderNo: parsed.orderNo,
      orderId: parsed.orderId,
      customerName: parsed.customerName,
      phone: parsed.phone ?? '',
      amount: parsed.amount,
      codFee: pricing.codFee,
      payable: pricing.payable,
      isCod: parsed.isCod,
      // No phone means no message can ever arrive, so the order starts terminal.
      confirmStatus: hasPhone ? 'PENDING' : 'NO_RESPONSE',
      paymentLink: '',
      createdAt: timestamp,
      confirmedAt: '',
      paidAt: '',
    };
    await store.appendOrder(row);

    if (!hasPhone) {
      log('warn', 'order has no usable phone, no message sent', { order_no: parsed.orderNo });
      return 'skipped_no_phone';
    }

    const template = parsed.isCod ? TEMPLATE_COD : TEMPLATE_PREPAID;
    const { wamid } = await whatsapp.sendTemplate({
      to: row.phone,
      template,
      languageCode: templateLang,
      bodyParams: [parsed.customerName, parsed.orderNo, parsed.itemsSummary, String(parsed.amount)],
    });

    await store.appendMessage({
      orderNo: parsed.orderNo,
      template,
      wamid,
      direction: 'out',
      status: 'sent',
      timestamp,
    });

    log('info', 'order confirmation sent', { order_no: parsed.orderNo, template });
    return 'processed';
  }
}
