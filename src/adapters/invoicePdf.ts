import PDFDocument from 'pdfkit';
import type { TaxSplit } from '../core/gst.js';
import { rupeesInWords } from '../core/amountInWords.js';

export interface InvoiceLine {
  description: string;
  quantity: number;
  taxable: number;
  rate: number;
  tax: number;
}

export interface InvoiceData {
  invoiceNo: string;
  invoiceDate: string;
  seller: { legalName: string; address: string; gstin: string };
  buyer: { name: string; address: string };
  placeOfSupply: string;
  hsn: string;
  lines: InvoiceLine[];
  shippingTaxable: number;
  shippingTax: number;
  split: TaxSplit;
  roundOff: number;
  total: number;
}

export interface InvoiceRenderer {
  render(data: InvoiceData): Promise<Buffer>;
}

function inr(amount: number): string {
  return `Rs ${amount.toFixed(2)}`;
}

/**
 * Renders a GST tax invoice as a PDF using pdfkit rather than headless Chrome:
 * this is a one-page document sent from a service that runs at
 * min-instances=0, so a small, deterministic, direct-drawing renderer beats a
 * ~300MB browser dependency with multi-second cold starts.
 *
 * Drawing goes entirely through pdfkit's public API (`doc.text()`, `doc.font()`,
 * `doc.moveDown()`) so the document's layout, font embedding and page
 * resources are exactly what the library produces for any other pdfkit
 * document — no reliance on how it happens to encode a content stream
 * internally.
 */
export class PdfKitRenderer implements InvoiceRenderer {
  async render(data: InvoiceData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      this.draw(doc, data);
      doc.end();
    });
  }

  private draw(doc: PDFKit.PDFDocument, data: InvoiceData): void {
    doc.fontSize(16).text('TAX INVOICE', { align: 'center' });
    doc.moveDown();

    // Seller block: legal name, address and GSTIN are required on every GST
    // tax invoice.
    doc.fontSize(11).text(data.seller.legalName);
    doc.fontSize(9).text(data.seller.address);
    doc.text(`GSTIN: ${data.seller.gstin}`);
    doc.moveDown();

    doc.text(`Invoice No: ${data.invoiceNo}`);
    doc.text(`Invoice Date: ${data.invoiceDate}`);
    doc.moveDown();

    // Buyer block and place of supply.
    doc.text(`Bill To: ${data.buyer.name}`);
    doc.text(data.buyer.address);
    doc.text(`Place of Supply: ${data.placeOfSupply}`);
    doc.moveDown();

    // Line-item table: description, HSN, quantity, taxable value, rate, tax.
    doc.text('Description        HSN      Qty      Taxable      Rate      Tax');
    for (const line of data.lines) {
      doc.text(
        `${line.description}   ${data.hsn}   ${line.quantity}   ${inr(line.taxable)}   ${line.rate}%   ${inr(line.tax)}`,
      );
    }
    doc.text(`Shipping   ${data.hsn}   1   ${inr(data.shippingTaxable)}   -   ${inr(data.shippingTax)}`);
    doc.moveDown();

    // Tax split: CGST+SGST for an intra-state supply, IGST for an
    // inter-state one — never both on the same invoice.
    if (data.split.igst > 0) {
      doc.text(`IGST: ${inr(data.split.igst)}`);
    } else {
      doc.text(`CGST: ${inr(data.split.cgst)}`);
      doc.text(`SGST: ${inr(data.split.sgst)}`);
    }
    doc.moveDown();

    doc.text(`Round Off: ${inr(data.roundOff)}`);
    doc.fontSize(10).text(`Total: ${inr(data.total)}`);
    doc.fontSize(9).text(`Amount in Words: ${rupeesInWords(data.total)}`);
    doc.moveDown();

    doc.fontSize(8).text('Computer generated invoice, no signature required', { align: 'center' });
  }
}
