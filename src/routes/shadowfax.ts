import { Router } from 'express';
import { safeCompare } from '../core/signatures.js';
import { parseShadowfaxWebhook } from '../adapters/shadowfax.js';
import type { ShipmentSyncService } from '../services/shipmentSync.js';
import { log } from '../logger.js';

export function createShadowfaxRouter(deps: {
  shipmentSync: Pick<ShipmentSyncService, 'applyShipmentStatus'>;
  webhookSecret: string;
}): Router {
  const router = Router();

  router.post('/webhook/shadowfax', async (req, res) => {
    const token = req.get('X-Shadowfax-Token');

    // Never a retryable outcome: a bad or missing token is a forgery, not a
    // transient failure, so this is 401 rather than 500.
    if (!token || !safeCompare(token, deps.webhookSecret)) {
      log('warn', 'shadowfax webhook token rejected');
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    // Without an AWB there is nothing to match an order against, and retrying
    // will not conjure one — this is a genuine 400, not a 500.
    const parsed = parseShadowfaxWebhook(req.body);
    if (!parsed) {
      res.status(400).json({ error: 'missing awb' });
      return;
    }

    try {
      // Every other outcome — applied, an unmapped status, an illegal transition,
      // or no matching shipment — is a 200. `applyShipmentStatus` already decides
      // whether a status is retry-worthy; the route just reports what happened.
      const result = await deps.shipmentSync.applyShipmentStatus(
        parsed.awb,
        parsed.status,
        parsed.rawStatus,
        parsed.at,
      );
      res.status(200).json({ result });
    } catch (error) {
      log('error', 'shadowfax webhook processing failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'processing failed' });
    }
  });

  return router;
}
