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
  cancelOrder(
    orderId: string,
    opts: { reason: 'OTHER' | 'CUSTOMER'; note: string; restock: boolean },
  ): Promise<void>;
  markAsPaid(orderId: string): Promise<void>;
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
   */
  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    mutationName: string,
  ): Promise<T> {
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

    const mutationResult = parsed.data?.[mutationName];
    const errors = [...(parsed.errors ?? []), ...(mutationResult?.userErrors ?? [])].map(
      (e) => e.message ?? 'unknown error',
    );

    if (errors.length > 0) {
      throw new Error(`Shopify ${mutationName} rejected: ${errors.join('; ')}`);
    }

    return parsed.data as T;
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
  ): Promise<void> {
    await this.graphql(
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
  }

  async markAsPaid(orderId: string): Promise<void> {
    await this.graphql(
      ORDER_MARK_AS_PAID,
      { input: { id: `gid://shopify/Order/${orderId}` } },
      'orderMarkAsPaid',
    );
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
