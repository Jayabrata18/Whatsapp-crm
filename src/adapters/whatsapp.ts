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
}

export interface WhatsAppClient {
  sendTemplate(input: SendTemplateInput): Promise<{ wamid: string }>;
}

interface Component {
  type: string;
  sub_type?: string;
  index?: string;
  parameters: Array<{ type: 'text'; text: string }>;
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
      throw new Error(`WhatsApp send failed [${res.status}] template=${input.template}: ${detail}`);
    }

    const parsed = JSON.parse(text) as { messages?: Array<{ id?: string }> };
    const wamid = parsed.messages?.[0]?.id;
    if (!wamid) {
      throw new Error(`WhatsApp send returned no message id for template=${input.template}`);
    }
    return { wamid };
  }
}
