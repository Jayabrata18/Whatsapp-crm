import { describe, it, expect } from 'vitest';
import { ShipmentSyncService } from '../../src/services/shipmentSync.js';
import { EffectService } from '../../src/services/effects.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { StubShipmentTracker } from '../fakes/stubClients.js';
import type { OrderRow } from '../../src/adapters/sheets.js';

const NOW = new Date('2026-09-15T09:00:00.000Z');
const AT = '2026-09-14T08:00:00.000Z'; // the courier-reported event time, distinct from `now`

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    orderNo: '#1042',
    orderId: '5544332211',
    customerName: 'Aarav',
    phone: '919876543210',
    amount: 1899,
    codFee: 50,
    payable: 1849,
    isCod: true,
    confirmStatus: 'CONFIRMED',
    paymentLink: '',
    createdAt: '2026-09-01T10:00:00.000Z',
    confirmedAt: '2026-09-01T10:05:00.000Z',
    paidAt: '',
    fulfillmentStatus: 'NEW',
    awb: '',
    cancelStatus: 'NONE',
    cancelReason: '',
    invoiceNo: '',
    rating: '',
    gstDiscrepancy: 0,
    linesJson: '',
    ...overrides,
  };
}

function harness() {
  const store = new InMemorySheetStore();
  const effects = new EffectService({
    store,
    handlers: {
      delivered: async () => {},
      rto_initiated: async () => {},
      rto_returned: async () => {},
    },
    now: () => NOW,
  });
  const tracker = new StubShipmentTracker();
  const svc = new ShipmentSyncService({ store, effects, tracker, now: () => NOW });
  return { store, effects, tracker, svc };
}

describe('ShipmentSyncService', () => {
  it('applies a legal transition, stamps the order, and enqueues its effect', async () => {
    const { svc, store } = harness();
    await store.appendOrder(order());
    await svc.recordFulfillment('#1042', 'SF1', 'shadowfax');

    expect(await svc.applyShipmentStatus('SF1', 'DELIVERED', 'DELIVERED', AT)).toBe('applied');

    const shipment = await store.findShipmentByAwb('SF1');
    expect(shipment?.status).toBe('DELIVERED');
    expect(shipment?.deliveredAt).toBe(AT);
    expect(shipment?.lastSyncedAt).toBe(NOW.toISOString());

    const orderRow = await store.findOrderByNo('#1042');
    expect(orderRow?.fulfillmentStatus).toBe('DELIVERED');

    expect(store.effects.map((e) => e.kind)).toEqual(['delivered']);
  });

  it('applies a transition that carries no effect (OFD) without enqueuing anything', async () => {
    // Guards against a bug where every applied transition blindly enqueues an
    // effect — only DELIVERED / RTO_INITIATED / RTO_RETURNED should.
    const { svc, store } = harness();
    await svc.recordFulfillment('#1042', 'SF1', 'shadowfax');

    expect(await svc.applyShipmentStatus('SF1', 'OFD', 'OUT_FOR_DELIVERY', AT)).toBe('applied');

    const shipment = await store.findShipmentByAwb('SF1');
    expect(shipment?.status).toBe('OFD');
    expect(shipment?.ofdAt).toBe(AT);
    expect(store.effects).toHaveLength(0);
  });

  it('fires the rto_initiated effect exactly once when the webhook and the poller both deliver it', async () => {
    // This is the test that matters: the webhook path calls applyShipmentStatus
    // directly; the poller path goes through the actual syncOpenShipments ->
    // tracker -> applyShipmentStatus route. If the two ever diverged, this
    // would be the test to catch it — a naive "call applyShipmentStatus twice"
    // test would pass even if the poller took a shortcut around the guard.
    const { svc, store, tracker } = harness();
    await svc.recordFulfillment('#1042', 'SF1', 'shadowfax');

    // Path 1: webhook.
    const webhookResult = await svc.applyShipmentStatus(
      'SF1', 'RTO_INITIATED', 'RTO_INITIATED', AT,
    );
    expect(webhookResult).toBe('applied');

    // RTO_INITIATED is non-terminal, so the poller still considers it open.
    tracker.responses = [{ awb: 'SF1', status: 'RTO_INITIATED', rawStatus: 'RTO_INITIATED', at: AT }];

    // Path 2: poller, four hours later, sees the same status again.
    const pollResult = await svc.syncOpenShipments();

    expect(tracker.requestedAwbs).toEqual([['SF1']]);
    expect(pollResult).toEqual({ checked: 1, applied: 0 });
    expect(store.effects.filter((e) => e.kind === 'rto_initiated')).toHaveLength(1);
  });

  it('never regresses a delivered shipment, and still refreshes rawStatus/lastSyncedAt', async () => {
    const { svc, store } = harness();
    await svc.recordFulfillment('#1042', 'SF1', 'shadowfax');
    await svc.applyShipmentStatus('SF1', 'DELIVERED', 'DELIVERED', AT); // enqueues 'delivered'
    const effectsAfterDelivery = store.effects.length;

    const result = await svc.applyShipmentStatus('SF1', 'OFD', 'OUT_FOR_DELIVERY', AT);

    expect(result).toBe('ignored_illegal');
    const row = await store.findShipmentByAwb('SF1');
    expect(row?.status).toBe('DELIVERED');
    // The guard refuses the transition, but a stale poll result is still worth
    // recording for diagnosis — it must not look like the sync never ran.
    expect(row?.rawStatus).toBe('OUT_FOR_DELIVERY');
    expect(row?.lastSyncedAt).toBe(NOW.toISOString());
    // The illegal move enqueues nothing on top of the earlier legitimate delivery.
    expect(store.effects).toHaveLength(effectsAfterDelivery);
  });

  it('records an unmapped status without changing state, but persists rawStatus for diagnosis', async () => {
    const { svc, store } = harness();
    await svc.recordFulfillment('#1042', 'SF1', 'shadowfax');

    expect(await svc.applyShipmentStatus('SF1', null, 'TELEPORTED', AT)).toBe('ignored_unknown_status');

    const row = await store.findShipmentByAwb('SF1');
    expect(row?.status).toBe('SHIPPED');
    expect(row?.rawStatus).toBe('TELEPORTED');
    expect(row?.lastSyncedAt).toBe(NOW.toISOString());
    expect(store.effects).toHaveLength(0);
  });

  it('ignores a status for an AWB it has never seen, and touches nothing', async () => {
    const { svc, store } = harness();
    expect(await svc.applyShipmentStatus('UNKNOWN', 'DELIVERED', 'DELIVERED', AT)).toBe('no_shipment');
    expect(store.shipments).toHaveLength(0);
    expect(store.effects).toHaveLength(0);
  });

  it('polls only non-terminal shipments', async () => {
    const { svc, store, tracker } = harness();
    await svc.recordFulfillment('#1', 'A', 'shadowfax');
    await svc.recordFulfillment('#2', 'B', 'shadowfax');
    await svc.applyShipmentStatus('B', 'DELIVERED', 'DELIVERED', AT);

    await svc.syncOpenShipments();

    expect(tracker.requestedAwbs).toEqual([['A']]);
  });

  it('applies a transition discovered by the poller itself, not just detects it', async () => {
    // Guards against a poller shortcut that would mutate the store directly
    // instead of routing through applyShipmentStatus.
    const { svc, store, tracker } = harness();
    await svc.recordFulfillment('#1', 'A', 'shadowfax');
    tracker.responses = [{ awb: 'A', status: 'DELIVERED', rawStatus: 'DELIVERED', at: AT }];

    const result = await svc.syncOpenShipments();

    expect(result).toEqual({ checked: 1, applied: 1 });
    expect((await store.findShipmentByAwb('A'))?.status).toBe('DELIVERED');
    expect(store.effects.map((e) => e.kind)).toEqual(['delivered']);
  });

  it('does not call the tracker at all when there are no open shipments', async () => {
    const { svc, tracker } = harness();
    expect(await svc.syncOpenShipments()).toEqual({ checked: 0, applied: 0 });
    expect(tracker.requestedAwbs).toHaveLength(0);
  });

  it('recordFulfillment upserts a SHIPPED shipment row and stamps the order', async () => {
    const { svc, store } = harness();
    await store.appendOrder(order());

    await svc.recordFulfillment('#1042', 'SF1', 'shadowfax');

    const shipment = await store.findShipmentByAwb('SF1');
    expect(shipment).toMatchObject({
      orderNo: '#1042',
      awb: 'SF1',
      courier: 'shadowfax',
      status: 'SHIPPED',
    });
    expect(shipment?.shippedAt).toBe(NOW.toISOString());

    const orderRow = await store.findOrderByNo('#1042');
    expect(orderRow?.awb).toBe('SF1');
    expect(orderRow?.fulfillmentStatus).toBe('SHIPPED');
  });

  it('a second recordFulfillment for the same AWB does not regress the row', async () => {
    const { svc, store } = harness();
    await svc.recordFulfillment('#1042', 'SF1', 'shadowfax');
    await svc.applyShipmentStatus('SF1', 'DELIVERED', 'DELIVERED', AT);

    // A duplicate Shopify fulfillment webhook replaying after delivery.
    await svc.recordFulfillment('#1042', 'SF1', 'shadowfax');

    const row = await store.findShipmentByAwb('SF1');
    expect(row?.status).toBe('DELIVERED');
    expect(row?.deliveredAt).toBe(AT);
  });

  it('a replayed fulfillment webhook cannot reopen the door to a second delivered effect', async () => {
    // The full attack chain the guard exists to close: recordFulfillment,
    // deliver, a duplicate recordFulfillment replay, then the poller re-sends
    // the same DELIVERED status it already reported. Without the fix,
    // recordFulfillment's second call regresses the row to SHIPPED, which
    // makes SHIPPED -> DELIVERED transition-legal again and the effect fires
    // twice. This test must fail against the pre-fix recordFulfillment.
    const { svc, store, tracker } = harness();
    await svc.recordFulfillment('#1042', 'SF1', 'shadowfax');
    await svc.applyShipmentStatus('SF1', 'DELIVERED', 'DELIVERED', AT);

    await svc.recordFulfillment('#1042', 'SF1', 'shadowfax'); // duplicate webhook replay

    tracker.responses = [{ awb: 'SF1', status: 'DELIVERED', rawStatus: 'DELIVERED', at: AT }];
    await svc.syncOpenShipments(); // poller re-confirms the same status

    expect(store.effects.filter((e) => e.kind === 'delivered')).toHaveLength(1);
    const row = await store.findShipmentByAwb('SF1');
    expect(row?.status).toBe('DELIVERED');
    expect(row?.deliveredAt).toBe(AT);
  });
});
