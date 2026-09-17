import { computeGst, round2, type GstLine, type GstRates } from '../core/gst.js';
import type { ShopifyWriter } from '../adapters/shopifyAdmin.js';
import type { OrderRow, SheetStore } from '../adapters/sheets.js';
import { log } from '../logger.js';

/** The one method this service needs from `InvoicingService` — narrow on purpose, like `OrderTagger`. */
export interface InvoiceIssuer {
  issueForOrder(orderNo: string): Promise<{ invoiceNo: string } | null>;
}

export interface DeliveryDeps {
  store: SheetStore;
  shopify: Pick<ShopifyWriter, 'markAsPaid'>;
  invoicing: InvoiceIssuer;
  rates: GstRates;
  platformFeePct: number;
  now?: () => Date;
}

/** Reads one field off a `listLedger()` row, which is loosely typed since it mirrors a sheet. */
function ledgerNumber(row: Record<string, unknown> | undefined, key: string): number {
  const value = Number(row?.[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Same fallback as `InvoicingService.resolveLines`: the frozen per-line data from intake
 * is the real rate-determining input, and a blank/unparseable value falls back to a single
 * blended line built from the ledger's aggregate `item_amount` rather than blocking the
 * ledger write entirely.
 */
function resolveLines(order: OrderRow, ledgerRow: Record<string, unknown> | undefined): GstLine[] {
  if (order.linesJson) {
    try {
      const parsed: unknown = JSON.parse(order.linesJson);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as GstLine[];
    } catch {
      // Falls through to the blended-line fallback below.
    }
  }
  log('warn', 'order lines unavailable, computing ledger GST at a single blended rate', {
    order_no: order.orderNo,
  });
  return [{ inclUnitPrice: ledgerNumber(ledgerRow, 'item_amount'), quantity: 1 }];
}

export class DeliveryService {
  private readonly now: () => Date;

  constructor(private readonly deps: DeliveryDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async onDelivered(orderNo: string): Promise<void> {
    const { store, shopify, invoicing, rates, platformFeePct } = this.deps;

    const order = await store.findOrderByNo(orderNo);
    if (!order) {
      log('warn', 'onDelivered called for an unknown order', { order_no: orderNo });
      return;
    }

    if (order.isCod && !order.paidAt) {
      await shopify.markAsPaid(order.orderId);
      await store.updateOrderFields(orderNo, { paidAt: this.now().toISOString() });
    }

    // `payable` is the discounted early-payment figure; a COD customer hands over the
    // full `amount` at the door. Mirrors the identical fix in InvoicingService — the
    // ledger and the invoice must agree on what was actually collected for this order.
    const collectedAmount = order.confirmStatus === 'PAID_EARLY' ? order.payable : order.amount;

    const ledgerRows = await store.listLedger();
    const ledgerRow = ledgerRows.find((row) => String(row['order_no'] ?? '') === orderNo);
    const shippingCharged = ledgerNumber(ledgerRow, 'shipping_charged');
    const lines = resolveLines(order, ledgerRow);
    const breakdown = computeGst(lines, shippingCharged, collectedAmount, rates);

    const gstOnGoods = round2(breakdown.goods.reduce((sum, part) => sum + part.tax, 0));
    const gstOnShipping = round2(breakdown.shipping.reduce((sum, part) => sum + part.tax, 0));
    // The ledger keeps one blended rate per row (unlike the per-rate invoice register),
    // so a mixed-rate order reports the rate carrying the largest taxable share.
    const dominant = [...breakdown.goods].sort((a, b) => b.taxable - a.taxable)[0];

    await store.updateLedgerOutcome(orderNo, {
      taxableValue: breakdown.taxableTotal,
      gstRate: dominant?.rate ?? 0,
      gstOnGoods,
      gstOnShipping,
      outcome: 'DELIVERED',
      collectedAmount,
      platformFee: round2(collectedAmount * (platformFeePct / 100)),
    });

    // Any throw here (a Sheets outage, a render failure, a network blip) must propagate
    // so the effect queue retries this whole handler rather than swallowing it.
    await invoicing.issueForOrder(orderNo);
  }
}
