import type { FulfillmentStatus } from '../core/shipmentState.js';
import { log } from '../logger.js';

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

/**
 * Parses a timestamp defensively: an empty/missing value or one that doesn't
 * parse (e.g. a garbled string from an API we don't fully control) falls back
 * to now, logged, rather than throwing a RangeError out of the caller.
 */
function safeIso(raw: string | null | undefined, context: string): string {
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    log('warn', 'shadowfax: unparseable timestamp, defaulting to now', { context, raw });
  }
  return new Date().toISOString();
}

export function parseShadowfaxWebhook(payload: unknown): TrackedShipment | null {
  const body = payload as Record<string, unknown>;

  // Without an AWB there is nothing to match an order against.
  const awb = firstString(body?.awb_number, body?.awb, body?.waybill);
  if (!awb) return null;

  const rawStatus = firstString(body?.status, body?.current_status) ?? '';
  const timestamp = firstString(body?.timestamp, body?.updated_at);
  const at = safeIso(timestamp, `webhook awb=${awb}`);

  return { awb, status: mapShadowfaxStatus(rawStatus), rawStatus, at };
}

/**
 * ASSUMED SHAPE — UNCONFIRMED against the real Shadowfax API. Shadowfax's
 * exact polling-response vocabulary and envelope is an open item pending
 * their account manager (see the module comment on STATUS_MAP above). This
 * type documents our best guess only; `extractShipments`/`parseShipmentEntry`
 * below treat every field here as untrusted and degrade a mismatch to a
 * skipped-and-logged entry rather than a thrown error, precisely because
 * this shape has never been verified against production Shadowfax traffic.
 */
interface ShadowfaxTrackResponse {
  shipments: Array<{ awb: string; status: string; updated_at?: string }>;
}

/** Returns the shipments array from a track response, or null if the body doesn't have one. */
function extractShipments(body: unknown): unknown[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const shipments = (body as Record<string, unknown>).shipments;
  return Array.isArray(shipments) ? shipments : null;
}

/**
 * Parses one shipment entry defensively. An entry missing an AWB or a status
 * string can't be turned into a `TrackedShipment` at all, so it's skipped
 * (logged) rather than thrown over — one malformed entry must not cost the
 * rest of the batch.
 */
function parseShipmentEntry(entry: unknown): TrackedShipment | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const row = entry as Record<string, unknown>;

  const awb = typeof row.awb === 'string' && row.awb.length > 0 ? row.awb : null;
  const rawStatus = typeof row.status === 'string' ? row.status : null;
  if (!awb || rawStatus === null) return null;

  const updatedAt = typeof row.updated_at === 'string' ? row.updated_at : undefined;
  return {
    awb,
    status: mapShadowfaxStatus(rawStatus),
    rawStatus,
    at: safeIso(updatedAt, `poll awb=${awb}`),
  };
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

      const body: unknown = await res.json();
      const shipments = extractShipments(body);
      if (shipments === null) {
        // Same philosophy as an unmapped status: be loud, don't guess, don't
        // die — one batch with an unrecognisable envelope must not take the
        // rest of the poll down with it.
        log('warn', 'shadowfax: track response had no usable shipments list, skipping batch', {
          awbs: batch.join(','),
        });
        continue;
      }

      for (const entry of shipments) {
        const parsed = parseShipmentEntry(entry);
        if (!parsed) {
          log('warn', 'shadowfax: skipping unparseable shipment entry', { entry });
          continue;
        }
        results.push(parsed);
      }
    }

    return results;
  }
}
