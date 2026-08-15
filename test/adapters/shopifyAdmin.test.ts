import { describe, it, expect, vi } from 'vitest';
import { ShopifyAdminClient } from '../../src/adapters/shopifyAdmin.js';

function graphqlOk() {
  return vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ data: { tagsAdd: { userErrors: [] } } }), { status: 200 }),
    );
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
});
