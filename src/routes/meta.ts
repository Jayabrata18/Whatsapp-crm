import { Router } from 'express';
import { verifyMetaSignature } from '../core/signatures.js';
import { parseMetaWebhook } from '../core/metaWebhook.js';
import type { ConfirmationService } from '../services/confirmation.js';
import type { RatingService } from '../services/rating.js';
import { log } from '../logger.js';

export function createMetaRouter(deps: {
  confirmation: ConfirmationService;
  rating: Pick<RatingService, 'handleRatingReply'>;
  appSecret: string;
  verifyToken: string;
}): Router {
  const router = Router();

  router.get('/webhook/meta', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === deps.verifyToken && typeof challenge === 'string') {
      log('info', 'meta webhook verified');
      res.status(200).send(challenge);
      return;
    }

    log('warn', 'meta webhook verification rejected');
    res.sendStatus(403);
  });

  router.post('/webhook/meta', async (req, res) => {
    const rawBody = req.rawBody ?? Buffer.alloc(0);
    const signature = req.get('X-Hub-Signature-256');

    if (!verifyMetaSignature(rawBody, signature, deps.appSecret)) {
      log('warn', 'meta webhook signature rejected');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    try {
      const events = parseMetaWebhook(req.body);
      for (const event of events) {
        const result = await deps.confirmation.handleEvent(event);
        // A button reply that isn't "I Confirm"/"Cancel Order" falls through here
        // unhandled — the rating quick-replies are exactly that. Confirmation's own
        // messageId dedup already guards this against a duplicate Meta delivery.
        if (result === 'ignored' && event.kind === 'button') {
          await deps.rating.handleRatingReply(event.from, event.buttonText);
        }
      }
      res.status(200).json({ handled: events.length });
    } catch (error) {
      // 500 so Meta retries. Idempotency makes the retry safe.
      log('error', 'meta webhook processing failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'processing failed' });
    }
  });

  return router;
}
