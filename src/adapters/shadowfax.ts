import type { FulfillmentStatus } from '../core/shipmentState.js';

export interface TrackedShipment {
  awb: string;
  status: FulfillmentStatus | null;
  rawStatus: string;
  at: string;
}

export interface ShipmentTracker {
  fetchStatuses(awbs: string[]): Promise<TrackedShipment[]>;
}

/**
 * Shadowfax's exact status vocabulary is an open item in the spec (§10). Every
 * string we know about lives here; anything else maps to null, which the caller
 * turns into a loud warning and a dashboard flag rather than a silent no-op.
 * Add rows here as Shadowfax confirms them — no other file needs to change.
 */
const STATUS_MAP: Record<string, FulfillmentStatus> = {
  PICKED_UP: 'SHIPPED',
  IN_TRANSIT: 'SHIPPED',
  SHIPPED: 'SHIPPED',
  DISPATCHED: 'SHIPPED',
  OUT_FOR_DELIVERY: 'OFD',
  OFD: 'OFD',
  DELIVERED: 'DELIVERED',
  RTO_INITIATED: 'RTO_INITIATED',
  RTO: 'RTO_INITIATED',
  RTO_IN_TRANSIT: 'RTO_INITIATED',
  UNDELIVERED: 'RTO_INITIATED',
  NDR: 'RTO_INITIATED',
  RTO_DELIVERED: 'RTO_RETURNED',
  RETURNED_TO_CLIENT: 'RTO_RETURNED',
  RTO_COMPLETED: 'RTO_RETURNED',
};

function normalise(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

export function mapShadowfaxStatus(raw: string): FulfillmentStatus | null {
  return STATUS_MAP[normalise(raw)] ?? null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

export function parseShadowfaxWebhook(payload: unknown): TrackedShipment | null {
  const body = payload as Record<string, unknown>;

  // Without an AWB there is nothing to match an order against.
  const awb = firstString(body?.awb_number, body?.awb, body?.waybill);
  if (!awb) return null;

  const rawStatus = firstString(body?.status, body?.current_status) ?? '';
  const timestamp = firstString(body?.timestamp, body?.updated_at);
  const at = new Date(timestamp ?? Date.now()).toISOString();

  return { awb, status: mapShadowfaxStatus(rawStatus), rawStatus, at };
}

interface ShadowfaxTrackResponse {
  shipments: Array<{ awb: string; status: string; updated_at?: string }>;
}

const AWB_CHUNK_SIZE = 50;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export class ShadowfaxClient implements ShipmentTracker {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async fetchStatuses(awbs: string[]): Promise<TrackedShipment[]> {
    const results: TrackedShipment[] = [];

    for (const batch of chunk(awbs, AWB_CHUNK_SIZE)) {
      const res = await this.fetchImpl(`${this.baseUrl}/track?awbs=${batch.join(',')}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });

      if (!res.ok) {
        throw new Error(`Shadowfax tracking request failed [${res.status}]`);
      }

      const parsed = (await res.json()) as ShadowfaxTrackResponse;
      for (const shipment of parsed.shipments) {
        results.push({
          awb: shipment.awb,
          status: mapShadowfaxStatus(shipment.status),
          rawStatus: shipment.status,
          at: new Date(shipment.updated_at ?? Date.now()).toISOString(),
        });
      }
    }

    return results;
  }
}
