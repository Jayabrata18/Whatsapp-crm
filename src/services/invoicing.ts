import { Mutex } from '../core/mutex.js';
import { financialYear, formatInvoiceNumber } from '../core/invoiceNumber.js';
import { round2, splitTax, type GstBreakdown, type GstRates } from '../core/gst.js';
import { isInterState } from '../core/placeOfSupply.js';
import { ledgerNumber, ledgerString } from '../core/ledgerRow.js';
import {
  amountChargedFor,
  earlyPayDiscount,
  InvoiceBlockedError,
  resolveInvoiceBasis,
} from '../core/invoiceBasis.js';
import type { InvoiceRow, OrderRow, SheetStore } from '../adapters/sheets.js';
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

export class InvoicingService {
  private readonly mutex = new Mutex();
  private readonly now: () => Date;

  constructor(private readonly deps: InvoicingDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async issueForOrder(orderNo: string): Promise<{ invoiceNo: string } | null> {
    const exists = await this.deps.store.findOrderByNo(orderNo);
    if (!exists) return null;

    /*
     * Allocation, render and rollback all happen inside the mutex. GST requires a
     * gapless series, so a failed render must return the number to the pool before
     * any other caller can allocate. See spec §5.6.
     *
     * The entry decision below consults what actually exists — ISSUED register rows,
     * the order's own invoiceNo stamp, and whether the delivered message was ever sent
     * — rather than a single flag. allocate/register/stamp/send are four separate,
     * unbatched writes against the real Sheets adapter, so a partial failure between any
     * two of them must leave every later stage resumable rather than stuck: a flag-only
     * check either re-allocates a second number when the register row already landed, or
     * returns null forever once the order is stamped even if the customer never received
     * the document.
     */
    return this.mutex.run(async () => {
      // Re-read inside the mutex: a concurrent call for the same order could have just
      // finished a stage, and the decision below must be based on current state.
      const order = await this.deps.store.findOrderByNo(orderNo);
      if (!order) return null;

      const issuedRows = (await this.deps.store.listInvoices()).filter(
        (row) => row.orderNo === orderNo && row.status === 'ISSUED',
      );

      if (issuedRows.length > 0) {
        return this.resume(orderNo, order, issuedRows);
      }

      if (order.invoiceNo) {
        // A number is stamped but no ISSUED row backs it — most likely every row for it
        // was voided. There's no register entry to resume from, so this reissues fresh
        // rather than getting stuck: a flag with nothing behind it should not block forever.
        log('warn', 'order has an invoice number but no ISSUED register rows, reissuing', {
          order_no: orderNo,
        });
      }

      return this.issueFresh(order, orderNo);
    });
  }

  private async issueFresh(order: OrderRow, orderNo: string): Promise<{ invoiceNo: string }> {
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

    // From here on the register row durably exists. A failure in either of the next two
    // steps must not allocate a second number on retry — issueForOrder's entry check finds
    // this row on the next call and resumes from exactly here via `resume()`.
    await this.deps.store.updateOrderFields(orderNo, { invoiceNo });
    await this.sendDeliveredMessage(orderNo, order, mediaId);

    return { invoiceNo };
  }

  /**
   * Reached when an ISSUED register row already exists for this order — recovers whichever
   * of stamp/send didn't complete last time, without re-allocating or re-registering.
   */
  private async resume(
    orderNo: string,
    order: OrderRow,
    issuedRows: InvoiceRow[],
  ): Promise<{ invoiceNo: string } | null> {
    const invoiceNo = issuedRows[0]!.invoiceNo;
    const mediaId = issuedRows[0]!.mediaId;

    if (!order.invoiceNo) {
      await this.deps.store.updateOrderFields(orderNo, { invoiceNo });
    }

    const alreadySent = (await this.deps.store.listMessages()).some(
      (message) =>
        message.orderNo === orderNo &&
        message.template === TEMPLATE_DELIVERED &&
        message.direction === 'out',
    );
    if (alreadySent) return null; // registered, stamped, and delivered — genuinely done

    // The PDF already exists on Meta from the original attempt; re-sending reuses that
    // mediaId rather than rendering and uploading a second copy.
    await this.sendDeliveredMessage(orderNo, order, mediaId);
    return { invoiceNo };
  }

  private async sendDeliveredMessage(orderNo: string, order: OrderRow, mediaId: string): Promise<void> {
    const timestamp = this.now().toISOString();
    const { wamid } = await this.deps.whatsapp.sendTemplate({
      to: order.phone, template: TEMPLATE_DELIVERED, languageCode: this.deps.templateLang,
      bodyParams: [order.customerName, order.orderNo], documentHeaderMediaId: mediaId,
    });
    await this.deps.store.appendMessage({
      orderNo, template: TEMPLATE_DELIVERED, wamid, direction: 'out',
      status: 'sent', timestamp,
    });
  }

  /**
   * Reads the ledger row for the order's already-resolved place of supply and its shipping
   * charge, and the order's own frozen `linesJson` for the real rate-determining data.
   * `linesJson` is what makes a mixed-rate order stay mixed-rate at invoicing time — the
   * ledger only ever kept one blended `itemAmount`, which can't recover which items sat in
   * which GST slab. See docs/superpowers/specs/2026-09-15-stage-1-design.md §4.4/§4.5.
   *
   * Everything that could be guessed is instead refused: `resolveInvoiceBasis` blocks on an
   * unresolved place of supply, on missing line data, and on a round-off past ±₹1, and this
   * throws rather than issuing a tax invoice built on any of them. The throw propagates out
   * through the delivery effect, which retries and then records the effect FAILED — visible
   * on the dashboard's Health panel alongside the blocked-invoice list that reads the same
   * guard.
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
    const resolved = resolveInvoiceBasis(
      {
        posCode: ledgerString(ledgerRow, 'pos_code'),
        linesJson: order.linesJson,
        shippingCharged: ledgerNumber(ledgerRow, 'shipping_charged'),
        amountCharged: amountChargedFor(order),
        discount: earlyPayDiscount(order),
      },
      this.deps.rates,
    );

    if (!resolved.ok) {
      log('error', 'refusing to issue an invoice on unresolved data', {
        order_no: order.orderNo,
        reasons: resolved.blocks.map((block) => block.reason).join(','),
      });
      throw new InvoiceBlockedError(order.orderNo, resolved.blocks);
    }

    const { placeOfSupply, breakdown } = resolved.basis;
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
}
