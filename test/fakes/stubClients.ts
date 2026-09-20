import type { SendTemplateInput, WhatsAppClient } from '../../src/adapters/whatsapp.js';
import type { CreateLinkInput, PaymentLinkClient } from '../../src/adapters/cashfree.js';
import type { OrderTagger, ShopifyWriter } from '../../src/adapters/shopifyAdmin.js';
import type { ShipmentTracker, TrackedShipment } from '../../src/adapters/shadowfax.js';

export class StubWhatsAppClient implements WhatsAppClient {
  sent: SendTemplateInput[] = [];
  uploaded: Array<{ bytes: Buffer; filename: string; mimeType: string }> = [];
  documentsSent: Array<{ to: string; mediaId: string; filename: string; caption?: string }> = [];
  textsSent: Array<{ to: string; body: string }> = [];
  failWith: Error | null = null;
  private counter = 0;

  async sendTemplate(input: SendTemplateInput): Promise<{ wamid: string }> {
    if (this.failWith) throw this.failWith;
    this.sent.push(input);
    this.counter += 1;
    return { wamid: `wamid.STUB${this.counter}` };
  }

  async uploadMedia(input: {
    bytes: Buffer;
    filename: string;
    mimeType: string;
  }): Promise<{ mediaId: string }> {
    if (this.failWith) throw this.failWith;
    this.uploaded.push(input);
    return { mediaId: `media.STUB${this.uploaded.length}` };
  }

  async sendDocument(input: {
    to: string;
    mediaId: string;
    filename: string;
    caption?: string;
  }): Promise<{ wamid: string }> {
    if (this.failWith) throw this.failWith;
    this.documentsSent.push(input);
    this.counter += 1;
    return { wamid: `wamid.STUB${this.counter}` };
  }

  async sendText(input: { to: string; body: string }): Promise<{ wamid: string }> {
    if (this.failWith) throw this.failWith;
    this.textsSent.push(input);
    this.counter += 1;
    return { wamid: `wamid.STUB${this.counter}` };
  }

  get lastTemplate(): string | undefined {
    return this.sent.at(-1)?.template;
  }
}

export class StubPaymentLinkClient implements PaymentLinkClient {
  created: CreateLinkInput[] = [];
  failWith: Error | null = null;

  async createLink(input: CreateLinkInput): Promise<{ linkUrl: string; linkId: string }> {
    if (this.failWith) throw this.failWith;
    this.created.push(input);
    return { linkUrl: `https://cf.test/links/${input.linkId}`, linkId: input.linkId };
  }
}

export class StubOrderTagger implements OrderTagger {
  tagged: Array<{ orderId: string; tag: string }> = [];
  failWith: Error | null = null;

  async addTag(orderId: string, tag: string): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.tagged.push({ orderId, tag });
  }
}

/** Full `ShopifyWriter` fake shared by the delivery and RTO service tests. */
export class StubShopifyWriter implements ShopifyWriter {
  markedPaid: string[] = [];
  cancels: Array<{ orderId: string; reason: 'OTHER' | 'CUSTOMER'; note: string; restock: boolean }> = [];
  tags: Array<{ orderId: string; tag: string }> = [];
  inventoryAdjustments: Array<Array<{ inventoryItemId: string; locationId: string; delta: number }>> = [];
  lineItems: Array<{ inventoryItemId: string; quantity: number }> = [];
  failMarkAsPaidWith: Error | null = null;
  failAdjustWith: Error | null = null;
  failCancelWith: Error | null = null;
  /** What `markAsPaid` resolves to when it doesn't throw — set to `'already_paid'` to
   *  simulate a retry against an order Shopify already marked paid. */
  markAsPaidResult: 'marked' | 'already_paid' = 'marked';
  /** What `cancelOrder` resolves to when it doesn't throw — set to `'already_cancelled'`
   *  to simulate a retry against an order Shopify already cancelled. */
  cancelOrderResult: 'cancelled' | 'already_cancelled' = 'cancelled';

  async addTag(orderId: string, tag: string): Promise<void> {
    this.tags.push({ orderId, tag });
  }

  async cancelOrder(
    orderId: string,
    opts: { reason: 'OTHER' | 'CUSTOMER'; note: string; restock: boolean },
  ): Promise<'cancelled' | 'already_cancelled'> {
    if (this.failCancelWith) throw this.failCancelWith;
    this.cancels.push({ orderId, ...opts });
    return this.cancelOrderResult;
  }

  async markAsPaid(orderId: string): Promise<'marked' | 'already_paid'> {
    if (this.failMarkAsPaidWith) throw this.failMarkAsPaidWith;
    this.markedPaid.push(orderId);
    return this.markAsPaidResult;
  }

  async adjustInventory(
    items: Array<{ inventoryItemId: string; locationId: string; delta: number }>,
  ): Promise<void> {
    if (this.failAdjustWith) throw this.failAdjustWith;
    this.inventoryAdjustments.push(items);
  }

  async getOrderLineItems(
    _orderId: string,
  ): Promise<Array<{ inventoryItemId: string; quantity: number }>> {
    return this.lineItems;
  }
}

/** Records every batch of AWBs it was asked to poll; returns whatever `responses` holds. */
export class StubShipmentTracker implements ShipmentTracker {
  requestedAwbs: string[][] = [];
  responses: TrackedShipment[] = [];

  async fetchStatuses(awbs: string[]): Promise<TrackedShipment[]> {
    this.requestedAwbs.push([...awbs]);
    return this.responses;
  }
}
