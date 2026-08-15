export interface CreateLinkInput {
  /** Stable, caller-supplied id — makes link creation idempotent on Cashfree's side. */
  linkId: string;
  amount: number;
  customerName: string;
  customerPhone: string;
  purpose: string;
  expiryHours: number;
}

export interface PaymentLinkClient {
  createLink(input: CreateLinkInput): Promise<{ linkUrl: string; linkId: string }>;
}

const HOSTS = {
  TEST: 'https://sandbox.cashfree.com',
  PROD: 'https://api.cashfree.com',
} as const;

export class CashfreeClient implements PaymentLinkClient {
  private readonly appId: string;
  private readonly secretKey: string;
  private readonly host: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(opts: {
    appId: string;
    secretKey: string;
    env: 'TEST' | 'PROD';
    fetchImpl?: typeof fetch;
    now?: () => Date;
  }) {
    this.appId = opts.appId;
    this.secretKey = opts.secretKey;
    this.host = HOSTS[opts.env];
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  async createLink(input: CreateLinkInput): Promise<{ linkUrl: string; linkId: string }> {
    const expiry = new Date(this.now().getTime() + input.expiryHours * 3600_000).toISOString();

    const res = await this.fetchImpl(`${this.host}/pg/links`, {
      method: 'POST',
      headers: {
        'x-client-id': this.appId,
        'x-client-secret': this.secretKey,
        'x-api-version': '2023-08-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        link_id: input.linkId,
        link_amount: input.amount,
        link_currency: 'INR',
        link_purpose: input.purpose,
        customer_details: {
          customer_name: input.customerName,
          customer_phone: input.customerPhone,
        },
        link_expiry_time: expiry,
        // Our WhatsApp flow owns reminders; Cashfree's would double-message the customer.
        link_auto_reminders: false,
        link_notify: { send_sms: false, send_email: false },
      }),
    });

    const text = await res.text();

    if (!res.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) detail = parsed.message;
      } catch {
        // Non-JSON error body; fall through with the raw text.
      }
      throw new Error(
        `Cashfree link creation failed [${res.status}] linkId=${input.linkId}: ${detail}`,
      );
    }

    const parsed = JSON.parse(text) as { link_url?: string; link_id?: string };
    if (!parsed.link_url) {
      throw new Error(`Cashfree returned no link_url for linkId=${input.linkId}`);
    }
    return { linkUrl: parsed.link_url, linkId: parsed.link_id ?? input.linkId };
  }
}
