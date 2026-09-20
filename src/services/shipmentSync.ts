import { canTransition, type FulfillmentStatus } from '../core/shipmentState.js';
import type { SheetStore, ShipmentRow } from '../adapters/sheets.js';
import type { ShipmentTracker } from '../adapters/shadowfax.js';
import type { EffectService } from './effects.js';
import { log } from '../logger.js';

export type SyncResult = 'applied' | 'ignored_illegal' | 'ignored_unknown_status' | 'no_shipment';

export interface ShipmentSyncDeps {
  store: SheetStore;
  effects: EffectService;
  tracker: ShipmentTracker;
  now?: () => Date;
}

/** Only these three transitions carry a side effect; everything else is a silent state move. */
const EFFECT_FOR: Partial<Record<FulfillmentStatus, string>> = {
  DELIVERED: 'delivered',
  RTO_INITIATED: 'rto_initiated',
  RTO_RETURNED: 'rto_returned',
};

/** Which `ShipmentRow` timestamp column a given status stamps, if any. */
function stampPatch(status: FulfillmentStatus, at: string): Partial<ShipmentRow> {
  switch (status) {
    case 'SHIPPED':
      return { shippedAt: at };
    case 'OFD':
      return { ofdAt: at };
    case 'DELIVERED':
      return { deliveredAt: at };
    case 'RTO_INITIATED':
      return { rtoInitiatedAt: at };
    case 'RTO_RETURNED':
      return { rtoReturnedAt: at };
    case 'NEW':
      return {};
  }
}

/**
 * The single convergence point for courier status. A Shadowfax webhook and the
 * four-hourly poller (via `syncOpenShipments`) both end up calling
 * `applyShipmentStatus` — neither one enqueues an effect itself, and neither
 * knows what fires downstream. `canTransition`'s refusal of a same-status
 * repeat, or of any move out of a terminal state, IS the idempotency guard: it
 * runs before any effect is enqueued, so the same status arriving twice — one
 * webhook plus one poll, or two webhook retries — can never double-invoice or
 * double-message a customer.
 */
export class ShipmentSyncService {
  private readonly now: () => Date;

  constructor(private readonly deps: ShipmentSyncDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * The only place a fulfillment status changes. Callers hand it a status and
   * get back what happened; they never decide themselves whether to enqueue an
   * effect, so a webhook and the poller can never diverge on that decision.
   */
  async applyShipmentStatus(
    awb: string,
    status: FulfillmentStatus | null,
    rawStatus: string,
    at: string,
  ): Promise<SyncResult> {
    const { store, effects } = this.deps;
    const shipment = await store.findShipmentByAwb(awb);
    if (!shipment) {
      log('warn', 'shipment status for unknown awb', { awb, raw_status: rawStatus });
      return 'no_shipment';
    }

    const nowIso = this.now().toISOString();

    if (status === null) {
      // Never a silent no-op: an ignored status is an order that stops moving
      // with nobody noticing. rawStatus is persisted so the sheet shows exactly
      // what the courier sent, diagnosable later without replaying the webhook.
      log('warn', 'unmapped courier status', {
        awb,
        order_no: shipment.orderNo,
        raw_status: rawStatus,
      });
      await store.upsertShipment({ ...shipment, rawStatus, lastSyncedAt: nowIso });
      return 'ignored_unknown_status';
    }

    if (!canTransition(shipment.status, status)) {
      // Not an error: this is the idempotency guard doing its job — a repeat
      // of the same status, or a stale update after a terminal state, refused
      // before any effect could be enqueued.
      log('info', 'shipment transition ignored', {
        awb,
        order_no: shipment.orderNo,
        from: shipment.status,
        to: status,
      });
      await store.upsertShipment({ ...shipment, rawStatus, lastSyncedAt: nowIso });
      return 'ignored_illegal';
    }

    await store.upsertShipment({
      ...shipment,
      ...stampPatch(status, at),
      status,
      rawStatus,
      lastSyncedAt: nowIso,
    });
    await store.updateOrderFields(shipment.orderNo, { fulfillmentStatus: status });

    const kind = EFFECT_FOR[status];
    if (kind) {
      await effects.enqueue(shipment.orderNo, kind, { orderNo: shipment.orderNo, awb, at });
    }

    return 'applied';
  }

  /**
   * The poller's entry point. It never applies a status itself — it only
   * fetches and hands each result to `applyShipmentStatus`, the same function
   * the webhook calls, so the two paths can't quietly diverge.
   */
  async syncOpenShipments(): Promise<{ checked: number; applied: number }> {
    const open = await this.deps.store.listOpenShipments();
    const awbs = open.map((s) => s.awb);
    if (awbs.length === 0) return { checked: 0, applied: 0 };

    const tracked = await this.deps.tracker.fetchStatuses(awbs);

    let applied = 0;
    for (const shipment of tracked) {
      const result = await this.applyShipmentStatus(
        shipment.awb,
        shipment.status,
        shipment.rawStatus,
        shipment.at,
      );
      if (result === 'applied') applied += 1;
    }

    return { checked: awbs.length, applied };
  }

  /**
   * Called at fulfillment time, to open the shipment record a courier status
   * can later transition. Routed through the same `canTransition` guard as
   * `applyShipmentStatus` — a duplicate Shopify fulfillment webhook (the kind
   * `hasEvent`/`recordEvent` dedup elsewhere in this codebase exists precisely
   * because they happen) must never regress a shipment that has already moved
   * past SHIPPED. An unguarded overwrite back to SHIPPED would make a later
   * status (e.g. DELIVERED) transition-legal again on the next poll, and the
   * guarded effect this whole file exists to fire once would fire twice.
   * On refusal this is loud, not silent, matching the unmapped-status branch's
   * philosophy. When it does write, it merges onto any existing row rather
   * than replacing it, so no timestamp already recorded is ever wiped.
   */
  async recordFulfillment(orderNo: string, awb: string, courier: string): Promise<void> {
    const nowIso = this.now().toISOString();
    const existing = await this.deps.store.findShipmentByAwb(awb);

    if (existing && !canTransition(existing.status, 'SHIPPED')) {
      log('warn', 'fulfillment recorded for a shipment already past SHIPPED, ignored', {
        awb,
        order_no: orderNo,
        status: existing.status,
      });
      return;
    }

    const base: ShipmentRow = existing ?? {
      orderNo,
      awb,
      courier,
      status: 'NEW',
      shippedAt: '',
      ofdAt: '',
      deliveredAt: '',
      rtoInitiatedAt: '',
      rtoReturnedAt: '',
      lastSyncedAt: '',
      rawStatus: '',
      rtoRestockedAt: '',
    };

    await this.deps.store.upsertShipment({
      ...base,
      orderNo,
      awb,
      courier,
      status: 'SHIPPED',
      shippedAt: nowIso,
      rawStatus: 'SHIPPED',
      lastSyncedAt: nowIso,
    });
    await this.deps.store.updateOrderFields(orderNo, { awb, fulfillmentStatus: 'SHIPPED' });
  }
}
