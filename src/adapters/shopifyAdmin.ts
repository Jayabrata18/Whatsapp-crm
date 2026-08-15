const API_VERSION = '2025-01';

const TAGS_ADD = `
  mutation addTag($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

export interface OrderTagger {
  addTag(orderId: string, tag: string): Promise<void>;
}

export class ShopifyAdminClient implements OrderTagger {
  private readonly storeDomain: string;
  private readonly adminToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { storeDomain: string; adminToken: string; fetchImpl?: typeof fetch }) {
    this.storeDomain = opts.storeDomain;
    this.adminToken = opts.adminToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async addTag(orderId: string, tag: string): Promise<void> {
    const res = await this.fetchImpl(
      `https://${this.storeDomain}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': this.adminToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: TAGS_ADD,
          variables: { id: `gid://shopify/Order/${orderId}`, tags: [tag] },
        }),
      },
    );

    if (!res.ok) {
      throw new Error(`Shopify tagsAdd failed [${res.status}] orderId=${orderId}`);
    }

    const parsed = (await res.json()) as {
      data?: { tagsAdd?: { userErrors?: Array<{ message?: string }> } };
      errors?: Array<{ message?: string }>;
    };

    // GraphQL answers 200 even when the mutation failed, so both the top-level
    // `errors` and the mutation's `userErrors` have to be checked.
    const errors = [...(parsed.errors ?? []), ...(parsed.data?.tagsAdd?.userErrors ?? [])].map(
      (e) => e.message ?? 'unknown error',
    );

    if (errors.length > 0) {
      throw new Error(`Shopify tagsAdd rejected orderId=${orderId}: ${errors.join('; ')}`);
    }
  }
}
