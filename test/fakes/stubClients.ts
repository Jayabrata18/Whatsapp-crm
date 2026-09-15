import type { SendTemplateInput, WhatsAppClient } from '../../src/adapters/whatsapp.js';
import type { CreateLinkInput, PaymentLinkClient } from '../../src/adapters/cashfree.js';
import type { OrderTagger } from '../../src/adapters/shopifyAdmin.js';
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

/** Records every batch of AWBs it was asked to poll; returns whatever `responses` holds. */
export class StubShipmentTracker implements ShipmentTracker {
  requestedAwbs: string[][] = [];
  responses: TrackedShipment[] = [];

  async fetchStatuses(awbs: string[]): Promise<TrackedShipment[]> {
    this.requestedAwbs.push([...awbs]);
    return this.responses;
  }
}
