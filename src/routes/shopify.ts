import { Router } from 'express';
import { verifyShopifyHmac } from '../core/signatures.js';
import type { OrderIntakeService } from '../services/orderIntake.js';
import { log } from '../logger.js';

export function createShopifyRouter(deps: {
  intake: OrderIntakeService;
  webhookSecret: string;
}): Router {
  const router = Router();

  router.post('/webhook/shopify', async (req, res) => {
    const rawBody = req.rawBody ?? Buffer.alloc(0);
    const signature = req.get('X-Shopify-Hmac-Sha256');

    if (!verifyShopifyHmac(rawBody, signature, deps.webhookSecret)) {
      log('warn', 'shopify webhook signature rejected');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    try {
      const result = await deps.intake.handle(req.body);
      res.status(200).json({ result });
    } catch (error) {
      // 500 so Shopify retries. Idempotency makes the retry safe.
      log('error', 'shopify webhook processing failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'processing failed' });
    }
  });

  return router;
}
