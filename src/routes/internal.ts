import { Router } from 'express';
import type { Request } from 'express';
import { safeCompare } from '../core/signatures.js';
import { Mutex } from '../core/mutex.js';
import type { ShipmentSyncService } from '../services/shipmentSync.js';
import type { EffectService } from '../services/effects.js';
import type { RatingService } from '../services/rating.js';
import type { ReportingService } from '../services/reporting.js';
import { log } from '../logger.js';

const MONTH_PATTERN = /^\d{4}-\d{2}$/;

function isAuthorised(req: Request, taskToken: string): boolean {
  const header = req.get('Authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  return bearer !== undefined && safeCompare(bearer, taskToken);
}

export function createInternalRouter(deps: {
  shipmentSync: Pick<ShipmentSyncService, 'syncOpenShipments'>;
  effects: Pick<EffectService, 'drain'>;
  rating: Pick<RatingService, 'sweep'>;
  reporting: Pick<ReportingService, 'generate'>;
  taskToken: string;
}): Router {
  const router = Router();

  // Cloud Scheduler's own retry-on-timeout can fire a second call while the first
  // is still running. `EffectService.drain()` and `RatingService.sweep()` each read
  // a due/eligible set before writing anything back per item — unlike
  // `ShipmentSyncService` (whose transition guard is the documented answer to the
  // webhook/poller race) and `ReportingService` (already mutexed internally), an
  // overlapping second call here could read the same "not yet done" snapshot and
  // re-run a handler concurrently, or send a second rating message before the
  // first call's send is recorded. One instance per the `--max-instances=1`
  // deploy (see deploy.sh / spec §5.6) makes an in-process `Mutex` here a real,
  // sufficient guard — not decorative — so this route, not the service, is where
  // it's added: it is scoped to "don't let two calls to *this endpoint* overlap,"
  // not a change to either service's own concurrency contract.
  const drainMutex = new Mutex();
  const ratingMutex = new Mutex();

  router.use('/internal', (req, res, next) => {
    if (!isAuthorised(req, deps.taskToken)) {
      // `req.path` is relative to this middleware's own `/internal` mount point
      // (Express strips it the same way it would for a sub-router), so the full
      // request path is logged via `originalUrl` instead.
      log('warn', 'internal task call rejected', { path: req.originalUrl });
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  router.post('/internal/sync-shipments', async (_req, res) => {
    try {
      // `ShipmentSyncService.syncOpenShipments` funnels every shipment through
      // `applyShipmentStatus`, the same guarded transition the Shadowfax webhook
      // uses — that convergence point, not a route-level lock, is this service's
      // answer to a concurrent webhook/poll race (see shipmentSync.ts).
      const result = await deps.shipmentSync.syncOpenShipments();
      res.status(200).json(result);
    } catch (error) {
      log('error', 'sync-shipments failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'processing failed' });
    }
  });

  router.post('/internal/rating-sweep', async (_req, res) => {
    try {
      const result = await ratingMutex.run(() => deps.rating.sweep());
      res.status(200).json(result);
    } catch (error) {
      log('error', 'rating-sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'processing failed' });
    }
  });

  router.post('/internal/drain-effects', async (_req, res) => {
    try {
      const result = await drainMutex.run(() => deps.effects.drain());
      res.status(200).json(result);
    } catch (error) {
      log('error', 'drain-effects failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'processing failed' });
    }
  });

  router.get('/internal/b2cs', async (req, res) => {
    const month = req.query.month;
    if (typeof month !== 'string' || !MONTH_PATTERN.test(month)) {
      res.status(400).json({ error: 'month must be provided as YYYY-MM' });
      return;
    }

    try {
      // `ReportingService.generate` already serialises itself on an internal
      // mutex against a concurrent call for a different month — no extra lock
      // needed here.
      const { csv } = await deps.reporting.generate(month);
      res.status(200).type('text/csv').send(csv);
    } catch (error) {
      log('error', 'b2cs generation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'processing failed' });
    }
  });

  return router;
}
