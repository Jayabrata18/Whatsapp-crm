import { Mutex } from '../core/mutex.js';
import { financialYear, formatInvoiceNumber } from '../core/invoiceNumber.js';
import { computeGst, round2, splitTax, type GstBreakdown, type GstLine, type GstRates } from '../core/gst.js';
import { isInterState } from '../core/placeOfSupply.js';
import type { OrderRow, SheetStore } from '../adapters/sheets.js';
import type { InvoiceData, InvoiceLine, InvoiceRenderer } from '../adapters/invoicePdf.js';
import type { WhatsAppClient } from '../adapters/whatsapp.js';
import { log } from '../logger.js';

export interface InvoicingDeps {
  store: SheetStore;
  renderer: InvoiceRenderer;
  whatsapp: WhatsAppClient;
  seller: { legalName: string; address: string; gstin: string; stateCode: string };
  hsn: string;
  rates: GstRates;
  seriesPrefix: string;
  templateLang: string;
  now?: () => Date;
}

export const TEMPLATE_DELIVERED = 'order_delivered_invoice';

/** Reads one field off a `listLedger()` row, which is loosely typed since it mirrors a sheet. */
function ledgerString(row: Record<string, unknown> | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function ledgerNumber(row: Record<string, unknown> | undefined, key: string): number {
  const value = Number(row?.[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export class InvoicingService {
  private readonly mutex = new Mutex();
  private readonly now: () => Date;

  constructor(private readonly deps: InvoicingDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async issueForOrder(orderNo: string): Promise<{ invoiceNo: string } | null> {
    const order = await this.deps.store.findOrderByNo(orderNo);
    if (!order) return null;
    if (order.invoiceNo) return null; // already invoiced; effect retries land here

    /*
     * Allocation, render and rollback all happen inside the mutex. GST requires a
     * gapless series, so a failed render must return the number to the pool before
     * any other caller can allocate. See spec §5.6.
     */
    return this.mutex.run(async () => {
      const issuedAt = this.now();
      const fy = financialYear(issuedAt);
      const seq = (await this.deps.store.lastInvoiceSequence(fy)) + 1;
      const invoiceNo = formatInvoiceNumber(this.deps.seriesPrefix, fy, seq);

      const { data, breakdown } = await this.buildInvoiceData(order, invoiceNo, issuedAt);

      // Nothing is persisted until the render succeeds, so a throw here consumes
      // no sequence number at all — the next call allocates the same one.
      const bytes = await this.deps.renderer.render(data);
      const { mediaId } = await this.deps.whatsapp.uploadMedia({
        bytes, filename: `${invoiceNo.replace(/\//g, '-')}.pdf`, mimeType: 'application/pdf',
      });

      // One register row per rate. Shipping folds into the row for the rate it was
      // apportioned to, so the rate-wise taxable values here are exactly what B2CS needs.
      const interState = isInterState(data.placeOfSupply, this.deps.seller.stateCode);
      const byRate = new Map<number, { taxable: number; tax: number }>();
      for (const part of [...breakdown.goods, ...breakdown.shipping]) {
        const bucket = byRate.get(part.rate) ?? { taxable: 0, tax: 0 };
        byRate.set(part.rate, {
          taxable: round2(bucket.taxable + part.taxable),
          tax: round2(bucket.tax + part.tax),
        });
      }

      await this.deps.store.appendInvoiceLines(
        [...byRate.entries()].sort((a, b) => a[0] - b[0]).map(([rate, sums]) => {
          const split = splitTax(sums.tax, interState);
          return {
            invoiceNo, orderNo, invoiceDate: issuedAt.toISOString(),
            placeOfSupply: data.placeOfSupply, hsn: this.deps.hsn,
            gstRate: rate, taxableValue: sums.taxable,
            cgst: split.cgst, sgst: split.sgst, igst: split.igst,
            roundOff: breakdown.roundOff, invoiceTotal: breakdown.total,
            mediaId, status: 'ISSUED' as const,
          };
        }),
      );
      await this.deps.store.updateOrderFields(orderNo, { invoiceNo });

      const { wamid } = await this.deps.whatsapp.sendTemplate({
        to: order.phone, template: TEMPLATE_DELIVERED, languageCode: this.deps.templateLang,
        bodyParams: [order.customerName, order.orderNo], documentHeaderMediaId: mediaId,
      });
      await this.deps.store.appendMessage({
        orderNo, template: TEMPLATE_DELIVERED, wamid, direction: 'out',
        status: 'sent', timestamp: issuedAt.toISOString(),
      });

      return { invoiceNo };
    });
  }

  /**
   * Reads the ledger row for the order's already-resolved place of supply and its aggregate
   * item amount, and the order's own frozen `linesJson` for the real rate-determining data.
   * `linesJson` is what makes a mixed-rate order stay mixed-rate at invoicing time — the
   * ledger only ever kept one blended `itemAmount`, which can't recover which items sat in
   * which GST slab. See docs/superpowers/specs/2026-09-15-stage-1-design.md §4.4/§4.5.
   */
  private async buildInvoiceData(
    order: OrderRow,
    invoiceNo: string,
    issuedAt: Date,
  ): Promise<{ data: InvoiceData; breakdown: GstBreakdown }> {
    const ledgerRows = await this.deps.store.listLedger();
    const ledgerRow = ledgerRows.find((row) => ledgerString(row, 'order_no') === order.orderNo);

    // pos_code was already resolved via stateCodeFor at intake (Task 9); an empty value means
    // stateCodeFor didn't recognise the code back then, not that this service should retry it —
    // the raw ISO code isn't persisted, only the resolved GST code or blank.
    let placeOfSupply = ledgerString(ledgerRow, 'pos_code');
    if (!placeOfSupply) {
      log('warn', 'place of supply unresolved for invoice, falling back to seller state', {
        order_no: order.orderNo,
      });
      placeOfSupply = this.deps.seller.stateCode;
    }

    const shippingCharged = ledgerNumber(ledgerRow, 'shipping_charged');
    const lines = this.resolveLines(order, ledgerRow);

    const breakdown = computeGst(lines, shippingCharged, order.payable, this.deps.rates);
    const interState = isInterState(placeOfSupply, this.deps.seller.stateCode);
    const split = splitTax(breakdown.taxTotal, interState);

    const invoiceLines: InvoiceLine[] = breakdown.goods.map((part) => ({
      description: `Goods @ ${part.rate}%`,
      quantity: 1,
      taxable: part.taxable,
      rate: part.rate,
      tax: part.tax,
    }));

    const shippingTaxable = round2(breakdown.shipping.reduce((sum, part) => sum + part.taxable, 0));
    const shippingTax = round2(breakdown.shipping.reduce((sum, part) => sum + part.tax, 0));

    const pincode = ledgerString(ledgerRow, 'pincode');
    const state = ledgerString(ledgerRow, 'state');

    const data: InvoiceData = {
      invoiceNo,
      invoiceDate: issuedAt.toISOString().slice(0, 10),
      seller: {
        legalName: this.deps.seller.legalName,
        address: this.deps.seller.address,
        gstin: this.deps.seller.gstin,
      },
      buyer: { name: order.customerName, address: [pincode, state].filter(Boolean).join(' ') },
      placeOfSupply,
      hsn: this.deps.hsn,
      lines: invoiceLines,
      shippingTaxable,
      shippingTax,
      split,
      roundOff: breakdown.roundOff,
      total: breakdown.total,
    };

    return { data, breakdown };
  }

  /**
   * `linesJson` is the real rate-determining data, frozen at intake. A blank or unparseable
   * value — an order placed before this column existed, or a corrupted cell — falls back to a
   * single blended line built from the ledger's aggregate `itemAmount`. An invoice at one rate
   * is better than no invoice at all, provided the gap is visible, so this warns rather than
   * throwing.
   */
  private resolveLines(order: OrderRow, ledgerRow: Record<string, unknown> | undefined): GstLine[] {
    if (order.linesJson) {
      try {
        const parsed: unknown = JSON.parse(order.linesJson);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed as GstLine[];
      } catch {
        // Falls through to the blended-line fallback below.
      }
    }

    log('warn', 'order lines unavailable, invoicing at a single blended rate', {
      order_no: order.orderNo,
    });
    return [{ inclUnitPrice: ledgerNumber(ledgerRow, 'item_amount'), quantity: 1 }];
  }
}
