import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { computeMetrics } from '../core/metrics.js';
import type { SheetStore } from '../adapters/sheets.js';

function tokenMatches(supplied: string | undefined, expected: string): boolean {
  if (!supplied) return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** '919876543210' -> '9198****3210' */
export function maskPhone(phone: string): string {
  if (phone.length < 8) return phone;
  return `${phone.slice(0, 4)}****${phone.slice(-4)}`;
}

export function createApiRouter(deps: { store: SheetStore; dashboardToken: string }): Router {
  const router = Router();

  router.get('/api/orders', async (req, res) => {
    const header = req.get('Authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;

    if (!tokenMatches(bearer ?? queryToken, deps.dashboardToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const orders = await deps.store.listOrders();
    const sorted = [...orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    // The dashboard needs to identify an order, not to dial it, and the page is
    // reachable by anyone holding the token — so phones go out masked.
    res.json({
      orders: sorted.map((row) => ({ ...row, phone: maskPhone(row.phone) })),
      metrics: computeMetrics(orders),
    });
  });

  return router;
}
