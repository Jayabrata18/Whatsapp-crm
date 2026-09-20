const GRAPH_VERSION = 'v21.0';

export interface SendTemplateInput {
  to: string;
  template: string;
  languageCode: string;
  /**
   * Values for the template's {{1}}, {{2}}, … slots, in order. A plain string
   * array rather than Graph's raw component structure — services should not
   * have to know Graph's schema, so the adapter owns that translation.
   */
  bodyParams: string[];
  /** Dynamic suffix appended to a URL button, if the template has one. */
  urlButtonSuffix?: string;
  /** Media id of a previously uploaded document to use as the header. */
  documentHeaderMediaId?: string;
  /** Media id of a previously uploaded image to use as the header. */
  imageHeaderMediaId?: string;
}

export interface WhatsAppClient {
  sendTemplate(input: SendTemplateInput): Promise<{ wamid: string }>;
  uploadMedia(input: { bytes: Buffer; filename: string; mimeType: string }): Promise<{ mediaId: string }>;
  sendDocument(input: { to: string; mediaId: string; filename: string; caption?: string }): Promise<{ wamid: string }>;
  sendText(input: { to: string; body: string }): Promise<{ wamid: string }>;
}

type ComponentParameter =
  | { type: 'text'; text: string }
  | { type: 'document'; document: { id: string; filename: string } }
  | { type: 'image'; image: { id: string } };

interface Component {
  type: string;
  sub_type?: string;
  index?: string;
  parameters: ComponentParameter[];
}

export class GraphWhatsAppClient implements WhatsAppClient {
  private readonly accessToken: string;
  private readonly phoneNumberId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { accessToken: string; phoneNumberId: string; fetchImpl?: typeof fetch }) {
    this.accessToken = opts.accessToken;
    this.phoneNumberId = opts.phoneNumberId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async sendTemplate(input: SendTemplateInput): Promise<{ wamid: string }> {
    const components: Component[] = [];

    if (input.bodyParams.length > 0) {
      components.push({
        type: 'body',
        parameters: input.bodyParams.map((text) => ({ type: 'text' as const, text })),
      });
    }

    if (input.urlButtonSuffix) {
      components.push({
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: input.urlButtonSuffix }],
      });
    }

    // Graph requires the header component before the body, so it is
    // unshifted to the front rather than pushed — appending it here would
    // silently produce a malformed message.
    if (input.documentHeaderMediaId) {
      components.unshift({
        type: 'header',
        parameters: [
          { type: 'document', document: { id: input.documentHeaderMediaId, filename: 'invoice.pdf' } },
        ],
      });
    }

    if (input.imageHeaderMediaId) {
      components.unshift({
        type: 'header',
        parameters: [{ type: 'image', image: { id: input.imageHeaderMediaId } }],
      });
    }

    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: input.to,
      type: 'template',
      template: {
        name: input.template,
        language: { code: input.languageCode },
        ...(components.length > 0 ? { components } : {}),
      },
    };

    return this.postMessage(body, `template=${input.template}`);
  }

  async uploadMedia(input: {
    bytes: Buffer;
    filename: string;
    mimeType: string;
  }): Promise<{ mediaId: string }> {
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', input.mimeType);
    form.set('file', new Blob([input.bytes], { type: input.mimeType }), input.filename);

    const res = await this.fetchImpl(
      `https://graph.facebook.com/${GRAPH_VERSION}/${this.phoneNumberId}/media`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: form,
      },
    );

    const text = await res.text();

    if (!res.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string; code?: number } };
        if (parsed.error?.message) detail = `${parsed.error.message} (code ${parsed.error.code})`;
      } catch {
        // Non-JSON error body; fall through with the raw text.
      }
      throw new Error(`WhatsApp media upload failed [${res.status}] filename=${input.filename}: ${detail}`);
    }

    const parsed = JSON.parse(text) as { id?: string };
    if (!parsed.id) {
      throw new Error(`WhatsApp media upload returned no media id for filename=${input.filename}`);
    }
    return { mediaId: parsed.id };
  }

  async sendDocument(input: {
    to: string;
    mediaId: string;
    filename: string;
    caption?: string;
  }): Promise<{ wamid: string }> {
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: input.to,
      type: 'document',
      document: {
        id: input.mediaId,
        filename: input.filename,
        ...(input.caption ? { caption: input.caption } : {}),
      },
    };

    return this.postMessage(body, `document to=${input.to}`);
  }

  async sendText(input: { to: string; body: string }): Promise<{ wamid: string }> {
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: input.to,
      type: 'text',
      text: { body: input.body },
    };

    return this.postMessage(body, `text to=${input.to}`);
  }

  private async postMessage(body: unknown, context: string): Promise<{ wamid: string }> {
    const res = await this.fetchImpl(
      `https://graph.facebook.com/${GRAPH_VERSION}/${this.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    const text = await res.text();

    if (!res.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string; code?: number } };
        if (parsed.error?.message) detail = `${parsed.error.message} (code ${parsed.error.code})`;
      } catch {
        // Non-JSON error body; fall through with the raw text.
      }
      throw new Error(`WhatsApp send failed [${res.status}] ${context}: ${detail}`);
    }

    const parsed = JSON.parse(text) as { messages?: Array<{ id?: string }> };
    const wamid = parsed.messages?.[0]?.id;
    if (!wamid) {
      throw new Error(`WhatsApp send returned no message id for ${context}`);
    }
    return { wamid };
  }
}
