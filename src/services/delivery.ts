import { round2, type GstRates } from '../core/gst.js';
import { ledgerNumber, ledgerString } from '../core/ledgerRow.js';
import {
  amountChargedFor,
  earlyPayDiscount,
  InvoiceBlockedError,
  resolveInvoiceBasis,
} from '../core/invoiceBasis.js';
import type { ShopifyWriter } from '../adapters/shopifyAdmin.js';
import type { SheetStore } from '../adapters/sheets.js';
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
      // 'already_paid' means a prior attempt's Shopify call actually landed but a later
      // step (this write, the ledger, invoicing) failed before the effect could record
      // success — Shopify creates no second transaction for it, so this is a retry
      // finding its own earlier work, not a failure. Both outcomes carry on identically.
      const result = await shopify.markAsPaid(order.orderId);
      if (result === 'already_paid') {
        log('info', 'order was already marked paid in Shopify on a prior attempt, continuing', {
          order_no: orderNo,
        });
      }
      await store.updateOrderFields(orderNo, { paidAt: this.now().toISOString() });
    }

    // `payable` is the discounted early-payment figure; a COD customer hands over the
    // full `amount` at the door. Mirrors the identical rule in InvoicingService — the
    // ledger and the invoice must agree on what was actually collected for this order,
    // which is why both now read it off the one shared helper.
    const collectedAmount = amountChargedFor(order);

    const ledgerRows = await store.listLedger();
    const ledgerRow = ledgerRows.find((row) => ledgerString(row, 'order_no') === orderNo);

    // The same guard the invoice runs, against the same inputs, deliberately before the
    // ledger write: an order whose slab or place of supply can't be established has no
    // GST figures to record, and writing zeros into K–N would silently overstate the
    // W–Y net-revenue and EBITDA formulas that subtract them. Throwing leaves the ledger
    // row open, retries the effect, and lands the order on the Health panel — see
    // core/invoiceBasis.ts.
    const resolved = resolveInvoiceBasis(
      {
        posCode: ledgerString(ledgerRow, 'pos_code'),
        linesJson: order.linesJson,
        shippingCharged: ledgerNumber(ledgerRow, 'shipping_charged'),
        amountCharged: collectedAmount,
        discount: earlyPayDiscount(order),
      },
      rates,
    );
    if (!resolved.ok) {
      log('error', 'refusing to close the ledger on unresolved GST data', {
        order_no: orderNo,
        reasons: resolved.blocks.map((block) => block.reason).join(','),
      });
      throw new InvoiceBlockedError(orderNo, resolved.blocks);
    }
    const { breakdown } = resolved.basis;

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
