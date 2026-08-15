import type { SendTemplateInput, WhatsAppClient } from '../../src/adapters/whatsapp.js';
import type { CreateLinkInput, PaymentLinkClient } from '../../src/adapters/cashfree.js';
import type { OrderTagger } from '../../src/adapters/shopifyAdmin.js';

export class StubWhatsAppClient implements WhatsAppClient {
  sent: SendTemplateInput[] = [];
  failWith: Error | null = null;
  private counter = 0;

  async sendTemplate(input: SendTemplateInput): Promise<{ wamid: string }> {
    if (this.failWith) throw this.failWith;
    this.sent.push(input);
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
