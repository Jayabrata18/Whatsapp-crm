import { log } from '../logger.js';

/**
 * OAuth scopes this adapter needs on the Admin API access token — a missing scope fails
 * at runtime with an authorization error that looks nothing like a scope problem, so it's
 * recorded here rather than only in the Partner Dashboard:
 *   - `write_orders`, `read_orders` — orderCancel, orderMarkAsPaid, tagsAdd
 *   - `write_inventory` — inventoryAdjustQuantities
 *   - `read_products`, `read_inventory` — the order line-items query
 */
const API_VERSION = '2026-07';

const TAGS_ADD = `
  mutation addTag($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

const ORDER_CANCEL = `
  mutation cancelOrder($orderId: ID!, $notifyCustomer: Boolean, $refundMethod: OrderCancelRefundMethodInput!, $restock: Boolean!, $reason: OrderCancelReason!, $staffNote: String) {
    orderCancel(orderId: $orderId, notifyCustomer: $notifyCustomer, refundMethod: $refundMethod, restock: $restock, reason: $reason, staffNote: $staffNote) {
      job { id done }
      orderCancelUserErrors { field message code }
    }
  }
`;

const ORDER_MARK_AS_PAID = `
  mutation markPaid($input: OrderMarkAsPaidInput!) {
    orderMarkAsPaid(input: $input) { userErrors { field message } }
  }
`;

const INVENTORY_ADJUST = `
  mutation adjust($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
    inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      userErrors { field message }
    }
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
  /**
   * `idempotencyKey` must be deterministic per retryable restock (derived from the order
   * number and AWB, not a random or time-based value) — it's what lets Shopify's
   * `@idempotent` directive collapse a retried call into a no-op instead of double-
   * applying the delta. See `RtoService.onRtoReturned` for how the key is derived.
   */
  adjustInventory(
    items: Array<{ inventoryItemId: string; locationId: string; delta: number }>,
    idempotencyKey: string,
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
   *
   * Almost every mutation payload here names its error field `userErrors`.
   * `orderCancel` is the one exception — the live schema exposes
   * `orderCancelUserErrors` instead (plain `userErrors` still resolves but
   * is deprecated), so that one mutation name is special-cased below rather
   * than building a general field-name-discovery mechanism for a field that
   * varies in exactly one place.
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
      data?: Record<
        string,
        | { userErrors?: Array<{ message?: string }>; orderCancelUserErrors?: Array<{ message?: string }> }
        | undefined
      >;
      errors?: Array<{ message?: string }>;
    };

    const topLevelErrors = parsed.errors ?? [];
    if (topLevelErrors.length > 0) {
      const messages = topLevelErrors.map((e) => e.message ?? 'unknown error').join('; ');
      throw new Error(`Shopify ${mutationName} rejected: ${messages}`);
    }

    const mutationResult = parsed.data?.[mutationName];
    const userErrors =
      mutationName === 'orderCancel'
        ? mutationResult?.orderCancelUserErrors ?? []
        : mutationResult?.userErrors ?? [];
    return { data: parsed.data as T, userErrors };
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
    const { data, userErrors } = await this.request<{
      orderCancel?: { job?: { id: string; done: boolean } | null };
    }>(
      ORDER_CANCEL,
      {
        orderId: `gid://shopify/Order/${orderId}`,
        reason: opts.reason,
        restock: opts.restock,
        // Declared in the mutation and interpolated into it, but never supplied — it
        // resolved to null, leaving the behaviour to Shopify's default. The hub sends
        // its own WhatsApp message for both cancel paths (RtoService.onRtoInitiated and
        // CancellationService.approve), so a Shopify email would be a duplicate.
        notifyCustomer: false,
        // Refunds are a money decision and stay manual; this call never
        // issues one, regardless of why the order was cancelled.
        refundMethod: { originalPaymentMethodsRefund: false },
        staffNote: opts.note,
      },
      'orderCancel',
    );

    if (userErrors.length === 0) {
      // orderCancel is asynchronous: a clean response means Shopify *accepted* the
      // cancel job, not that it *completed*. Log the job id so a cancel that fails
      // later, inside that job, is still traceable back to this call — see the Task 25
      // brief's "known residual" note: this needs human verification against the real
      // store before launch, since nothing here polls the job to completion.
      log('info', 'Shopify orderCancel accepted, job queued', {
        order_id: orderId,
        job_id: data.orderCancel?.job?.id,
      });
      return 'cancelled';
    }

    // Shopify rejects a cancel against an order that's already cancelled — expected on
    // a retry that lands after a prior attempt's cancel already succeeded, and no second
    // cancellation happens, so this is a no-op to treat as success.
    //
    // The exact wording below ('already cancelled') is NOT independently confirmed
    // against Shopify's live response — it's our best guess at the real phrase.
    // Deliberately kept to one narrow phrase rather than broadened (e.g. matching on
    // "already" + "cancel" as two independent tokens): `orderCancel` also rejects a
    // cancel for three other, unrelated preconditions (a pending payment authorization,
    // an active return in progress, an outstanding fulfillment that can't be cancelled),
    // and at least one of those could plausibly phrase its own message with both
    // "already" and "cancel" in it — e.g. "a refund is already in progress and the
    // order cannot be cancelled". A false match on one of those would report
    // `'already_cancelled'` on a cancel that never happened, on an operation Shopify
    // documents as irreversible — a silent no-op, which is worse than this failing
    // loudly. If this string turns out to be wrong, that failure is loud by design: it
    // throws below with the exact message logged, so correcting the matcher is a
    // one-line change with no guesswork. Do not "helpfully" broaden this again without
    // confirming the real wording against a live response first.
    //
    // This was also considered and rejected as a code match instead of a message match:
    // the full `OrderCancelUserErrorCode` enum, read from the live 2026-07 schema, is
    // `NO_REFUND_PERMISSION`, `NO_REFUND_TO_STORE_CREDIT_PERMISSION`,
    // `STORE_CREDIT_REFUND_EXPIRATION_IN_PAST`, `STORE_CREDIT_REFUND_MISSING_CUSTOMER`,
    // `STORE_CREDIT_REFUND_B2B_NOT_SUPPORTED`, `NOT_FOUND`, `INVALID`, `INTERNAL_ERROR` —
    // there is no already-cancelled member. The only candidate is `INVALID`, which is
    // also what a genuinely invalid cancel returns; matching on it would swallow real
    // failures into the same silent no-op this comment already rules out for message
    // matching. No code-based rewrite is possible without Shopify adding one.
    const allAlreadyCancelled = userErrors.every((e) =>
      (e.message ?? '').toLowerCase().includes('already cancelled'),
    );
    if (allAlreadyCancelled) return 'already_cancelled';

    const messages = userErrors.map((e) => e.message ?? 'unknown error').join('; ');
    log('error', 'Shopify orderCancel rejected', { order_id: orderId, errors: messages });
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
    idempotencyKey: string,
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
        idempotencyKey,
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
