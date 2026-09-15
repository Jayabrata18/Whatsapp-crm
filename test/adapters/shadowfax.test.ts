import { describe, it, expect, vi } from 'vitest';
import {
  mapShadowfaxStatus,
  parseShadowfaxWebhook,
  ShadowfaxClient,
} from '../../src/adapters/shadowfax.js';

describe('mapShadowfaxStatus', () => {
  it.each([
    ['DELIVERED', 'DELIVERED'],
    ['delivered', 'DELIVERED'],
    ['OUT_FOR_DELIVERY', 'OFD'],
    ['Out for Delivery', 'OFD'],
    ['PICKED_UP', 'SHIPPED'],
    ['IN_TRANSIT', 'SHIPPED'],
    ['RTO_INITIATED', 'RTO_INITIATED'],
    ['RTO Initiated', 'RTO_INITIATED'],
    ['RTO_DELIVERED', 'RTO_RETURNED'],
    ['Returned to Client', 'RTO_RETURNED'],
  ])('maps %s to %s', (raw, expected) => expect(mapShadowfaxStatus(raw)).toBe(expected));

  it('returns null for an unrecognised status so the caller can flag it', () => {
    expect(mapShadowfaxStatus('TELEPORTED')).toBeNull();
  });
});

describe('parseShadowfaxWebhook', () => {
  it('extracts awb, status and timestamp', () => {
    expect(
      parseShadowfaxWebhook({
        awb_number: 'SF123',
        status: 'DELIVERED',
        timestamp: '2026-09-15T10:00:00Z',
      }),
    ).toEqual({
      awb: 'SF123',
      status: 'DELIVERED',
      rawStatus: 'DELIVERED',
      at: '2026-09-15T10:00:00.000Z',
    });
  });

  it('preserves the raw status even when unmapped', () => {
    expect(parseShadowfaxWebhook({ awb_number: 'SF1', status: 'TELEPORTED' })).toMatchObject({
      status: null,
      rawStatus: 'TELEPORTED',
    });
  });

  it('returns null when there is no AWB to key on', () => {
    expect(parseShadowfaxWebhook({ status: 'DELIVERED' })).toBeNull();
  });
});

describe('ShadowfaxClient', () => {
  function okResponse(body: unknown) {
    return new Response(JSON.stringify(body), { status: 200 });
  }

  it('fetches statuses for the given AWBs and maps them', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        shipments: [
          { awb: 'SF1', status: 'DELIVERED', updated_at: '2026-09-15T10:00:00Z' },
          { awb: 'SF2', status: 'OUT_FOR_DELIVERY', updated_at: '2026-09-15T09:00:00Z' },
        ],
      }),
    );
    const client = new ShadowfaxClient({ baseUrl: 'https://sf.example', apiKey: 'k', fetchImpl });
    const result = await client.fetchStatuses(['SF1', 'SF2']);
    expect(result).toEqual([
      { awb: 'SF1', status: 'DELIVERED', rawStatus: 'DELIVERED', at: '2026-09-15T10:00:00.000Z' },
      { awb: 'SF2', status: 'OFD', rawStatus: 'OUT_FOR_DELIVERY', at: '2026-09-15T09:00:00.000Z' },
    ]);
  });

  it('sends the bearer token and awb csv on the request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ shipments: [] }));
    const client = new ShadowfaxClient({
      baseUrl: 'https://sf.example',
      apiKey: 'secret-key',
      fetchImpl,
    });
    await client.fetchStatuses(['SF1', 'SF2']);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://sf.example/track?awbs=SF1,SF2');
    expect(init.headers.Authorization).toBe('Bearer secret-key');
  });

  it('chunks the AWB list at 50 per request', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(okResponse({ shipments: [] })));
    const client = new ShadowfaxClient({ baseUrl: 'https://sf.example', apiKey: 'k', fetchImpl });
    const awbs = Array.from({ length: 120 }, (_, i) => `SF${i}`);
    await client.fetchStatuses(awbs);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const firstUrl = fetchImpl.mock.calls[0]![0] as string;
    const firstCsv = firstUrl.split('awbs=')[1]!;
    expect(firstCsv.split(',')).toHaveLength(50);
    const lastUrl = fetchImpl.mock.calls[2]![0] as string;
    const lastCsv = lastUrl.split('awbs=')[1]!;
    expect(lastCsv.split(',')).toHaveLength(20);
  });
});
