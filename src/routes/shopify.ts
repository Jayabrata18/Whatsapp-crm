import { Router } from 'express';
import { verifyShopifyHmac } from '../core/signatures.js';
import { parseShopifyFulfillment } from '../core/shopifyOrder.js';
import type { OrderIntakeService } from '../services/orderIntake.js';
import type { ShipmentSyncService } from '../services/shipmentSync.js';
import type { SheetStore } from '../adapters/sheets.js';
import { log } from '../logger.js';

const FULFILLMENT_TOPICS = new Set(['fulfillments/create', 'fulfillments/update']);

export function createShopifyRouter(deps: {
  intake: OrderIntakeService;
  shipmentSync: Pick<ShipmentSyncService, 'recordFulfillment'>;
  store: Pick<SheetStore, 'listOrders'>;
  webhookSecret: string;
}): Router {
  const router = Router();

  router.post('/webhook/shopify', async (req, res) => {
    const rawBody = req.rawBody ?? Buffer.alloc(0);
    const signature = req.get('X-Shopify-Hmac-Sha256');

    // HMAC verification applies to every topic on this endpoint — it runs before
    // the topic is even inspected, so no branch below can bypass it.
    if (!verifyShopifyHmac(rawBody, signature, deps.webhookSecret)) {
      log('warn', 'shopify webhook signature rejected');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    const topic = req.get('X-Shopify-Topic');

    try {
      if (topic !== undefined && FULFILLMENT_TOPICS.has(topic)) {
        const result = await handleFulfillment(deps, req.body);
        res.status(200).json({ result });
        return;
      }

      // Default branch: `orders/create` and any topic this endpoint hasn't been
      // taught yet both land here, matching the intake behaviour this route has
      // always had.
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

type FulfillmentResult = 'recorded' | 'no_tracking_number';

/**
 * A fulfillment webhook carries the numeric `order_id`, not the `#1042`-shaped
 * `orderNo` that `ShipmentSyncService`/`OrderRow` key on — so this resolves it off
 * the same `orderId` `parseShopifyOrder` already froze into the order row at
 * intake, rather than parsing an order number out of the fulfillment's own
 * `name` field (an undocumented, fulfillment-local string, not the order's).
 * An order that can't be found is a genuine unknown — not a "nothing to do
 * here" — so it throws, which the caller's catch turns into a 500: Shopify
 * retries, and by the time it does, the `orders/create` webhook (delivered
 * independently, with no ordering guarantee against this one) has very likely
 * already landed.
 */
async function handleFulfillment(
  deps: { shipmentSync: Pick<ShipmentSyncService, 'recordFulfillment'>; store: Pick<SheetStore, 'listOrders'> },
  payload: unknown,
): Promise<FulfillmentResult> {
  const parsed = parseShopifyFulfillment(payload);

  if (!parsed.awb) {
    log('info', 'fulfillment webhook carried no tracking number yet, skipping', {
      order_id: parsed.orderId,
    });
    return 'no_tracking_number';
  }

  const orders = await deps.store.listOrders();
  const order = orders.find((row) => row.orderId === parsed.orderId);
  if (!order) {
    throw new Error(`fulfillment webhook for unknown Shopify order_id=${parsed.orderId}`);
  }

  await deps.shipmentSync.recordFulfillment(order.orderNo, parsed.awb, parsed.courier);
  return 'recorded';
}
