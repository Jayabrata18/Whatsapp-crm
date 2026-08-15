import { Router } from 'express';
import { verifyCashfreeSignature } from '../core/signatures.js';
import type { PaymentService } from '../services/payment.js';
import { log } from '../logger.js';

export function createCashfreeRouter(deps: {
  payment: PaymentService;
  secretKey: string;
}): Router {
  const router = Router();

  router.post('/webhook/cashfree', async (req, res) => {
    const rawBody = req.rawBody ?? Buffer.alloc(0);
    const signature = req.get('x-webhook-signature');
    const timestamp = req.get('x-webhook-timestamp');

    if (!verifyCashfreeSignature(rawBody, signature, timestamp, deps.secretKey)) {
      log('warn', 'cashfree webhook signature rejected');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    try {
      const result = await deps.payment.handle(req.body);
      res.status(200).json({ result });
    } catch (error) {
      log('error', 'cashfree webhook processing failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'processing failed' });
    }
  });

  return router;
}
