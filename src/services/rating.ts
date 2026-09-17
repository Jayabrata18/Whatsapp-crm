import type { OrderRow, SheetStore } from '../adapters/sheets.js';
import type { WhatsAppClient } from '../adapters/whatsapp.js';
import { log } from '../logger.js';

export const TEMPLATE_RATING = 'order_rating';

const DAY_MS = 86_400_000;

export type RatingBucket = '1-2' | '3' | '4-5';

export interface RatingDeps {
  store: SheetStore;
  whatsapp: Pick<WhatsAppClient, 'sendTemplate' | 'sendText'>;
  templateLang: string;
  /** Minimum days since delivery before the sweep asks for a rating. */
  ratingDelayDays: number;
  judgemeReviewUrl: string;
  now?: () => Date;
}

/**
 * WhatsApp templates permit at most three quick-reply buttons, so the rating ask
 * is bucketed into three: `'1-2'`, `'3'`, `'4-5'`. Buttons render with emoji and
 * an en-dash (`'⭐ 4–5'`), not a hyphen, and Meta's `button.text` echoes back
 * whatever the template rendered — so this normalises by extracting digits
 * rather than string-matching a label, which makes emoji/dash variants and a
 * bare `'4-5'` (e.g. from a manual test) all resolve the same way. Anything
 * that doesn't reduce to one of the three configured buckets returns null.
 */
export function normalizeRatingReply(buttonText: string): RatingBucket | null {
  const digits = buttonText.match(/\d+/g);
  if (!digits) return null;
  const joined = digits.join('-');
  return joined === '1-2' || joined === '3' || joined === '4-5' ? joined : null;
}

export class RatingService {
  private readonly now: () => Date;

  constructor(private readonly deps: RatingDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Runs as a fresh process invocation on every cron tick, so "already asked"
   * cannot live in memory on this instance — it is read back from the message
   * log each call, the same log `RtoService`/`CancellationService` check to make
   * a send resumable. That also makes a re-run after a mid-sweep crash safe: any
   * order this loop already reached (and logged) before failing is skipped on
   * the next pass, and every other due order is still asked.
   */
  async sweep(): Promise<{ sent: number }> {
    const { store, whatsapp, templateLang, ratingDelayDays } = this.deps;

    const orders = await store.listOrders();
    const messages = await store.listMessages();
    const alreadyAsked = new Set(
      messages
        .filter((message) => message.template === TEMPLATE_RATING && message.direction === 'out')
        .map((message) => message.orderNo),
    );

    const nowMs = this.now().getTime();
    let sent = 0;

    for (const order of orders) {
      if (order.fulfillmentStatus !== 'DELIVERED') continue;
      if (alreadyAsked.has(order.orderNo)) continue;

      const shipment = await store.findShipmentByAwb(order.awb);
      if (!shipment?.deliveredAt) continue;

      const deliveredMs = Date.parse(shipment.deliveredAt);
      if (Number.isNaN(deliveredMs)) continue;
      if (nowMs - deliveredMs < ratingDelayDays * DAY_MS) continue;

      const timestamp = this.now().toISOString();
      const { wamid } = await whatsapp.sendTemplate({
        to: order.phone,
        template: TEMPLATE_RATING,
        languageCode: templateLang,
        bodyParams: [order.customerName, order.orderNo],
      });
      await store.appendMessage({
        orderNo: order.orderNo,
        template: TEMPLATE_RATING,
        wamid,
        direction: 'out',
        status: 'sent',
        timestamp,
      });
      sent += 1;
    }

    return { sent };
  }

  /**
   * The customer's own button tap just opened a 24-hour WhatsApp service window,
   * so the follow-up goes out as free-form text (`sendText`) rather than a paid
   * template — the reply is free precisely because it rides that window.
   */
  async handleRatingReply(phone: string, buttonText: string): Promise<'stored' | 'no_match'> {
    const { store, whatsapp, judgemeReviewUrl } = this.deps;

    const bucket = normalizeRatingReply(buttonText);
    if (!bucket) {
      log('info', 'rating reply did not match a known bucket', { phone, button: buttonText });
      return 'no_match';
    }

    const order = await this.findLatestDelivered(phone);
    if (!order) {
      log('warn', 'rating reply matched no delivered order', { phone });
      return 'no_match';
    }

    await store.updateOrderFields(order.orderNo, { rating: bucket });
    await whatsapp.sendText({ to: phone, body: this.replyBody(bucket, judgemeReviewUrl) });

    if (bucket === '1-2') {
      // No dedicated ticket store exists yet — surfaced as a log line for the
      // operator to act on, the same way an unmapped courier status or a
      // stranded restock is surfaced elsewhere in this codebase.
      log('warn', 'low rating flagged for service follow-up', { order_no: order.orderNo, phone });
    }

    return 'stored';
  }

  private async findLatestDelivered(phone: string): Promise<OrderRow | null> {
    const { store } = this.deps;
    let best: { order: OrderRow; deliveredAt: string } | null = null;

    for (const order of await store.listOrders()) {
      if (order.phone !== phone || order.fulfillmentStatus !== 'DELIVERED') continue;
      const shipment = await store.findShipmentByAwb(order.awb);
      const deliveredAt = shipment?.deliveredAt ?? '';
      if (!best || deliveredAt.localeCompare(best.deliveredAt) > 0) {
        best = { order, deliveredAt };
      }
    }

    return best?.order ?? null;
  }

  private replyBody(bucket: RatingBucket, judgemeReviewUrl: string): string {
    if (bucket === '4-5') {
      return `So glad you loved it! Would you mind sharing a quick review? ${judgemeReviewUrl}`;
    }
    if (bucket === '1-2') {
      return "We're sorry to hear that — our team will reach out shortly to make it right.";
    }
    return 'Thanks so much for letting us know how it went!';
  }
}
