const API_VERSION = '2025-01';

const TAGS_ADD = `
  mutation addTag($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

const ORDER_CANCEL = `
  mutation cancelOrder($orderId: ID!, $reason: OrderCancelReason!, $restock: Boolean!,
                       $refund: Boolean!, $staffNote: String) {
    orderCancel(orderId: $orderId, reason: $reason, restock: $restock,
                refund: $refund, staffNote: $staffNote) {
      userErrors { field message }
    }
  }
`;

const ORDER_MARK_AS_PAID = `
  mutation markPaid($input: OrderMarkAsPaidInput!) {
    orderMarkAsPaid(input: $input) { userErrors { field message } }
  }
`;

const INVENTORY_ADJUST = `
  mutation adjust($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) { userErrors { field message } }
  }
`;

const ORDER_LINE_ITEMS = `
  query orderLineItems($id: ID!) {
    order(id: $id) {
      lineItems(first: 250) {
        nodes {
          quantity
          currentQuantity
          variant { inventoryItem { id } }
        }
      }
    }
  }
`;

export interface OrderTagger {
  addTag(orderId: string, tag: string): Promise<void>;
}

export interface ShopifyWriter extends OrderTagger {
  /**
   * `'already_cancelled'` means Shopify rejected the mutation because the order was
   * already cancelled — expected on a retry that lands after a prior attempt's cancel
   * actually succeeded but a later step (the sheet write, the message send) failed
   * first. Every other failure still throws. Mirrors `markAsPaid`'s `'already_paid'`.
   */
  cancelOrder(
    orderId: string,
    opts: { reason: 'OTHER' | 'CUSTOMER'; note: string; restock: boolean },
  ): Promise<'cancelled' | 'already_cancelled'>;
  /**
   * `'already_paid'` means Shopify rejected the mutation because the order's financial
   * status wasn't eligible (no positive outstanding balance / already `PAID`) — expected
   * on a retry, and importantly, Shopify creates no second transaction for it. Every
   * other failure still throws.
   */
  markAsPaid(orderId: string): Promise<'marked' | 'already_paid'>;
  adjustInventory(
    items: Array<{ inventoryItemId: string; locationId: string; delta: number }>,
  ): Promise<void>;
  getOrderLineItems(
    orderId: string,
  ): Promise<Array<{ inventoryItemId: string; quantity: number }>>;
}

export class ShopifyAdminClient implements ShopifyWriter {
  private readonly storeDomain: string;
  private readonly adminToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { storeDomain: string; adminToken: string; fetchImpl?: typeof fetch }) {
    this.storeDomain = opts.storeDomain;
    this.adminToken = opts.adminToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Runs a GraphQL request against the Admin API and checks both places a
   * failure can hide: GraphQL answers HTTP 200 even when a mutation fails,
   * so the top-level `errors` array and the mutation's `userErrors` both
   * have to be inspected.
   *
   * Returns `userErrors` to the caller rather than throwing on them — most
   * callers want the throw-on-any-userError behavior of `graphql()` below,
   * but `markAsPaid` needs to inspect them itself to tell an expected,
   * already-happened outcome from a genuine failure.
   */
  private async request<T>(
    query: string,
    variables: Record<string, unknown>,
    mutationName: string,
  ): Promise<{ data: T; userErrors: Array<{ message?: string }> }> {
    const res = await this.fetchImpl(
      `https://${this.storeDomain}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': this.adminToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      },
    );

    if (!res.ok) {
      throw new Error(`Shopify ${mutationName} failed [${res.status}]`);
    }

    const parsed = (await res.json()) as {
      data?: Record<string, { userErrors?: Array<{ message?: string }> } | undefined>;
      errors?: Array<{ message?: string }>;
    };

    const topLevelErrors = parsed.errors ?? [];
    if (topLevelErrors.length > 0) {
      const messages = topLevelErrors.map((e) => e.message ?? 'unknown error').join('; ');
      throw new Error(`Shopify ${mutationName} rejected: ${messages}`);
    }

    const mutationResult = parsed.data?.[mutationName];
    return { data: parsed.data as T, userErrors: mutationResult?.userErrors ?? [] };
  }

  /** `request()`, but throws on any `userErrors` too — what every mutation but `markAsPaid` wants. */
  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    mutationName: string,
  ): Promise<T> {
    const { data, userErrors } = await this.request<T>(query, variables, mutationName);
    if (userErrors.length > 0) {
      const messages = userErrors.map((e) => e.message ?? 'unknown error').join('; ');
      throw new Error(`Shopify ${mutationName} rejected: ${messages}`);
    }
    return data;
  }

  async addTag(orderId: string, tag: string): Promise<void> {
    await this.graphql(
      TAGS_ADD,
      { id: `gid://shopify/Order/${orderId}`, tags: [tag] },
      'tagsAdd',
    );
  }

  async cancelOrder(
    orderId: string,
    opts: { reason: 'OTHER' | 'CUSTOMER'; note: string; restock: boolean },
  ): Promise<'cancelled' | 'already_cancelled'> {
    const { userErrors } = await this.request(
      ORDER_CANCEL,
      {
        orderId: `gid://shopify/Order/${orderId}`,
        reason: opts.reason,
        restock: opts.restock,
        // Refunds are a money decision and stay manual; this call never
        // issues one, regardless of why the order was cancelled.
        refund: false,
        staffNote: opts.note,
      },
      'orderCancel',
    );

    if (userErrors.length === 0) return 'cancelled';

    // Shopify rejects a cancel against an order that's already cancelled — expected on
    // a retry that lands after a prior attempt's cancel already succeeded, and no second
    // cancellation happens, so this is a no-op to treat as success. Matched on both
    // "already" and "cancel" rather than one exact phrase: the precise wording at our
    // pinned API version isn't independently confirmed, and community reports show
    // Shopify doesn't always phrase this consistently. Every other userError (e.g. an
    // order id Shopify doesn't recognise) still has to throw.
    const allAlreadyCancelled = userErrors.every((e) => {
      const message = (e.message ?? '').toLowerCase();
      return message.includes('already') && message.includes('cancel');
    });
    if (allAlreadyCancelled) return 'already_cancelled';

    const messages = userErrors.map((e) => e.message ?? 'unknown error').join('; ');
    throw new Error(`Shopify orderCancel rejected: ${messages}`);
  }

  async markAsPaid(orderId: string): Promise<'marked' | 'already_paid'> {
    const { userErrors } = await this.request(
      ORDER_MARK_AS_PAID,
      { input: { id: `gid://shopify/Order/${orderId}` } },
      'orderMarkAsPaid',
    );

    if (userErrors.length === 0) return 'marked';

    // Shopify's own wording when the order's financial status isn't eligible (no positive
    // outstanding balance, or already PAID) — creates no second transaction, so a retry
    // landing here is a no-op to treat as success, not a failure. Every other userError
    // (e.g. an order id Shopify doesn't recognise) still has to throw.
    const allAlreadyPaid = userErrors.every((e) =>
      (e.message ?? '').toLowerCase().includes('cannot be marked as paid'),
    );
    if (allAlreadyPaid) return 'already_paid';

    const messages = userErrors.map((e) => e.message ?? 'unknown error').join('; ');
    throw new Error(`Shopify orderMarkAsPaid rejected: ${messages}`);
  }

  async adjustInventory(
    items: Array<{ inventoryItemId: string; locationId: string; delta: number }>,
  ): Promise<void> {
    await this.graphql(
      INVENTORY_ADJUST,
      {
        input: {
          name: 'available',
          reason: 'restock',
          changes: items.map((item) => ({
            inventoryItemId: item.inventoryItemId,
            locationId: item.locationId,
            delta: item.delta,
          })),
        },
      },
      'inventoryAdjustQuantities',
    );
  }

  async getOrderLineItems(
    orderId: string,
  ): Promise<Array<{ inventoryItemId: string; quantity: number }>> {
    const data = await this.graphql<{
      order?: {
        lineItems?: {
          nodes?: Array<{
            quantity: number;
            currentQuantity?: number | null;
            variant?: { inventoryItem?: { id: string } } | null;
          }>;
        };
      };
    }>(ORDER_LINE_ITEMS, { id: `gid://shopify/Order/${orderId}` }, 'order');

    const nodes = data.order?.lineItems?.nodes ?? [];
    return nodes
      .filter((node) => node.variant?.inventoryItem?.id)
      .map((node) => ({
        inventoryItemId: node.variant!.inventoryItem!.id,
        // currentQuantity nets out lines removed by an order edit; quantity
        // is the line as originally recorded. Prefer currentQuantity so an
        // edited-off line never gets restocked (it never physically shipped
        // in the first place) — under-restocking is a visible, fixable
        // error, overselling is a customer-facing one. Fall back to
        // quantity for an older API response or a null currentQuantity.
        quantity: node.currentQuantity ?? node.quantity,
      }));
  }
}
