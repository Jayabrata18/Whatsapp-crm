import { Router } from 'express';
import type { Request } from 'express';
import { computeMetrics } from '../core/metrics.js';
import { safeCompare } from '../core/signatures.js';
import { mapShadowfaxStatus } from '../adapters/shadowfax.js';
import type { SheetStore } from '../adapters/sheets.js';
import type { CancellationService } from '../services/cancellation.js';
import type { ReportingService } from '../services/reporting.js';
import { log } from '../logger.js';

const MONTH_PATTERN = /^\d{4}-\d{2}$/;

/** '919876543210' -> '9198****3210' */
export function maskPhone(phone: string): string {
  if (phone.length < 8) return phone;
  return `${phone.slice(0, 4)}****${phone.slice(-4)}`;
}

/**
 * Bearer header first, `?token=` query second. The header is what the dashboard's own
 * `fetch()` calls use; the query fallback exists for plain-navigation links a browser
 * can't attach a header to — the GST CSV download link below is exactly that case.
 */
function isAuthorised(req: Request, dashboardToken: string): boolean {
  const header = req.get('Authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
  const supplied = bearer ?? queryToken;
  return supplied !== undefined && safeCompare(supplied, dashboardToken);
}

export function createApiRouter(deps: {
  store: SheetStore;
  dashboardToken: string;
  cancellation: Pick<CancellationService, 'listPendingReview' | 'approve'>;
  reporting: Pick<ReportingService, 'generate'>;
}): Router {
  const router = Router();

  router.use('/api', (req, res, next) => {
    if (!isAuthorised(req, deps.dashboardToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  router.get('/api/orders', async (_req, res) => {
    const orders = await deps.store.listOrders();
    const sorted = [...orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    // The dashboard needs to identify an order, not to dial it, and the page is
    // reachable by anyone holding the token — so phones go out masked.
    res.json({
      orders: sorted.map((row) => ({ ...row, phone: maskPhone(row.phone) })),
      metrics: computeMetrics(orders),
    });
  });

  router.get('/api/delivery', async (_req, res) => {
    const [orders, openShipments] = await Promise.all([
      deps.store.listOrders(),
      deps.store.listOpenShipments(),
    ]);

    const funnel = {
      shipped: orders.filter((o) => o.fulfillmentStatus === 'SHIPPED').length,
      ofd: orders.filter((o) => o.fulfillmentStatus === 'OFD').length,
      delivered: orders.filter((o) => o.fulfillmentStatus === 'DELIVERED').length,
    };

    // RTO_RETURNED is terminal (restocked, closed out) — the operator-facing "in
    // transit back" list is only the ones still open at RTO_INITIATED.
    const rto = openShipments.filter((s) => s.status === 'RTO_INITIATED');

    res.json({ funnel, rto });
  });

  router.get('/api/cancellations', async (_req, res) => {
    const orders = await deps.cancellation.listPendingReview();
    res.json({ orders: orders.map((row) => ({ ...row, phone: maskPhone(row.phone) })) });
  });

  router.post('/api/cancellations/:orderNo/approve', async (req, res) => {
    try {
      await deps.cancellation.approve(req.params.orderNo);
      res.status(200).json({ ok: true });
    } catch (error) {
      log('error', 'cancellation approval failed', {
        order_no: req.params.orderNo,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'processing failed' });
    }
  });

  router.get('/api/invoices', async (_req, res) => {
    const [invoices, orders] = await Promise.all([
      deps.store.listInvoices(),
      deps.store.listOrders(),
    ]);

    // Computed once at intake (see orderIntake.ts) as the gap between our slab-rule
    // GST and Shopify's own tax_lines — not re-derived here.
    const discrepancies = orders
      .filter((o) => o.gstDiscrepancy > 0)
      .map((row) => ({ ...row, phone: maskPhone(row.phone) }));

    res.json({ invoices, discrepancies });
  });

  router.get('/api/health-flags', async (_req, res) => {
    const [failedEffects, openShipments] = await Promise.all([
      deps.store.listFailedEffects(),
      deps.store.listOpenShipments(),
    ]);

    // A courier status the hub doesn't recognise leaves `rawStatus` set but the
    // shipment's own `status` unmoved (see shipmentSync.ts) — so it stays open and
    // shows up here rather than needing any dedicated storage of its own.
    const unmappedStatuses = openShipments
      .filter((s) => s.rawStatus !== '' && mapShadowfaxStatus(s.rawStatus) === null)
      .map((s) => ({ orderNo: s.orderNo, awb: s.awb, rawStatus: s.rawStatus }));

    res.json({ failedEffects, unmappedStatuses });
  });

  // Reuses the same reporting pipeline `/internal/b2cs` runs, behind the dashboard
  // token instead of the internal scheduler token — this is what the dashboard's
  // GST section links to for a plain-navigation CSV download.
  router.get('/api/b2cs', async (req, res) => {
    const month = req.query.month;
    if (typeof month !== 'string' || !MONTH_PATTERN.test(month)) {
      res.status(400).json({ error: 'month must be provided as YYYY-MM' });
      return;
    }

    try {
      const { csv } = await deps.reporting.generate(month);
      res.status(200).type('text/csv').send(csv);
    } catch (error) {
      log('error', 'b2cs generation failed via dashboard', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'processing failed' });
    }
  });

  return router;
}
