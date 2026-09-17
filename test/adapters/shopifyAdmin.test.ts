import { describe, it, expect, vi } from 'vitest';
import { ShopifyAdminClient } from '../../src/adapters/shopifyAdmin.js';

function graphqlOk() {
  return vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ data: { tagsAdd: { userErrors: [] } } }), { status: 200 }),
    );
}

function okJson(v: unknown) {
  return new Response(JSON.stringify(v), { status: 200 });
}

describe('ShopifyAdminClient', () => {
  it('calls the Admin GraphQL endpoint with the access token', async () => {
    const fetchImpl = graphqlOk();
    await new ShopifyAdminClient({
      storeDomain: 'urbnmyth.myshopify.com',
      adminToken: 'shpat_x',
      fetchImpl,
    }).addTag('55443', 'paid-early');

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://urbnmyth.myshopify.com/admin/api/2025-01/graphql.json');
    expect(init.headers['X-Shopify-Access-Token']).toBe('shpat_x');
  });

  it('sends a tagsAdd mutation with the order GID and tag', async () => {
    const fetchImpl = graphqlOk();
    await new ShopifyAdminClient({
      storeDomain: 'urbnmyth.myshopify.com',
      adminToken: 'shpat_x',
      fetchImpl,
    }).addTag('55443', 'paid-early');

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.query).toContain('tagsAdd');
    expect(body.variables).toEqual({ id: 'gid://shopify/Order/55443', tags: ['paid-early'] });
  });

  it('throws when Shopify returns userErrors', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: { tagsAdd: { userErrors: [{ message: 'Order not found' }] } } }),
          { status: 200 },
        ),
      );
    await expect(
      new ShopifyAdminClient({ storeDomain: 'd', adminToken: 't', fetchImpl }).addTag(
        '1',
        'paid-early',
      ),
    ).rejects.toThrow(/Order not found/);
  });

  it('throws when Shopify returns top-level GraphQL errors', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ errors: [{ message: 'Throttled' }] }), { status: 200 }),
      );
    await expect(
      new ShopifyAdminClient({ storeDomain: 'd', adminToken: 't', fetchImpl }).addTag(
        '1',
        'paid-early',
      ),
    ).rejects.toThrow(/Throttled/);
  });

  it('throws on a non-2xx response without leaking the token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    await expect(
      new ShopifyAdminClient({
        storeDomain: 'd',
        adminToken: 'shpat_supersecret',
        fetchImpl,
      }).addTag('1', 'paid-early'),
    ).rejects.toThrow(/^(?!.*shpat_supersecret).*$/s);
  });

  it('resolves quietly on success', async () => {
    const fetchImpl = graphqlOk();
    await expect(
      new ShopifyAdminClient({ storeDomain: 'd', adminToken: 't', fetchImpl }).addTag(
        '1',
        'paid-early',
      ),
    ).resolves.toBeUndefined();
  });

  it('cancels with the RTO note and no restock', async () => {
    let body: any;
    const client = new ShopifyAdminClient({
      storeDomain: 'x.myshopify.com',
      adminToken: 't',
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String((init as RequestInit).body));
        return okJson({ data: { orderCancel: { userErrors: [] } } });
      },
    });

    await client.cancelOrder('99', {
      reason: 'OTHER',
      restock: false,
      note: 'user cancel, user did not take delivery or cancel the delivery',
    });

    expect(body.variables).toMatchObject({
      orderId: 'gid://shopify/Order/99',
      reason: 'OTHER',
      restock: false,
      staffNote: 'user cancel, user did not take delivery or cancel the delivery',
    });
  });

  it('throws on a userErrors response even though HTTP was 200', async () => {
    const client = new ShopifyAdminClient({
      storeDomain: 'x',
      adminToken: 't',
      fetchImpl: async () =>
        okJson({ data: { orderCancel: { userErrors: [{ message: 'already cancelled' }] } } }),
    });
    await expect(
      client.cancelOrder('99', { reason: 'OTHER', note: 'n', restock: false }),
    ).rejects.toThrow(/already cancelled/);
  });

  it('resolves "marked" when orderMarkAsPaid succeeds with no userErrors', async () => {
    const client = new ShopifyAdminClient({
      storeDomain: 'x',
      adminToken: 't',
      fetchImpl: async () => okJson({ data: { orderMarkAsPaid: { userErrors: [] } } }),
    });
    await expect(client.markAsPaid('99')).resolves.toBe('marked');
  });

  it('resolves "already_paid" instead of throwing when Shopify says the order cannot be marked as paid', async () => {
    const client = new ShopifyAdminClient({
      storeDomain: 'x',
      adminToken: 't',
      fetchImpl: async () =>
        okJson({
          data: {
            orderMarkAsPaid: {
              userErrors: [{ field: ['id'], message: 'Order cannot be marked as paid.' }],
            },
          },
        }),
    });
    await expect(client.markAsPaid('99')).resolves.toBe('already_paid');
  });

  it('still throws on a userErrors response that is not the already-paid case', async () => {
    const client = new ShopifyAdminClient({
      storeDomain: 'x',
      adminToken: 't',
      fetchImpl: async () =>
        okJson({ data: { orderMarkAsPaid: { userErrors: [{ message: 'Order not found' }] } } }),
    });
    await expect(client.markAsPaid('99')).rejects.toThrow(/Order not found/);
  });

  it('throws when even one userError among several is not the already-paid case', async () => {
    // Guards against a loose check that treats "any already-paid message present" as
    // success — every userError must qualify, or this has to stay loud.
    const client = new ShopifyAdminClient({
      storeDomain: 'x',
      adminToken: 't',
      fetchImpl: async () =>
        okJson({
          data: {
            orderMarkAsPaid: {
              userErrors: [
                { message: 'Order cannot be marked as paid.' },
                { message: 'Something else went wrong' },
              ],
            },
          },
        }),
    });
    await expect(client.markAsPaid('99')).rejects.toThrow(/Something else went wrong/);
  });

  it('sends one inventory delta per item', async () => {
    let body: any;
    const client = new ShopifyAdminClient({
      storeDomain: 'x',
      adminToken: 't',
      fetchImpl: async (_u, init) => {
        body = JSON.parse(String((init as RequestInit).body));
        return okJson({ data: { inventoryAdjustQuantities: { userErrors: [] } } });
      },
    });

    await client.adjustInventory([
      { inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/9', delta: 2 },
    ]);

    expect(body.variables.input.changes).toEqual([
      { inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/9', delta: 2 },
    ]);
  });

  it('returns line items keyed by inventory item id, preferring currentQuantity over quantity', async () => {
    const client = new ShopifyAdminClient({
      storeDomain: 'x',
      adminToken: 't',
      fetchImpl: async () =>
        okJson({
          data: {
            order: {
              lineItems: {
                nodes: [
                  // Edited down after the order was placed: currentQuantity should win.
                  {
                    quantity: 3,
                    currentQuantity: 1,
                    variant: { inventoryItem: { id: 'gid://shopify/InventoryItem/1' } },
                  },
                  // No order edit: currentQuantity is null, falls back to quantity.
                  {
                    quantity: 2,
                    currentQuantity: null,
                    variant: { inventoryItem: { id: 'gid://shopify/InventoryItem/2' } },
                  },
                  // Custom/no-variant line item: has no inventory item, must be filtered out.
                  {
                    quantity: 1,
                    currentQuantity: 1,
                    variant: null,
                  },
                ],
              },
            },
          },
        }),
    });

    const items = await client.getOrderLineItems('99');

    expect(items).toEqual([
      { inventoryItemId: 'gid://shopify/InventoryItem/1', quantity: 1 },
      { inventoryItemId: 'gid://shopify/InventoryItem/2', quantity: 2 },
    ]);
  });
});
