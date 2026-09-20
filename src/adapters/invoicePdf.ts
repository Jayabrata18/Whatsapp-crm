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

interface TableColumn {
  label: string;
  width: number;
  align: 'left' | 'right';
}

/**
 * Fixed column geometry for the line-item table. Widths sum to well within
 * an A4 page's content width (515pt after 40pt margins), left to right:
 * Description(170) HSN(50) Qty(40) Taxable(85) Rate(50) Tax(85) = 480pt,
 * starting at the 40pt left margin and ending at 520pt.
 */
const TABLE_COLUMNS: TableColumn[] = [
  { label: 'Description', width: 170, align: 'left' },
  { label: 'HSN', width: 50, align: 'left' },
  { label: 'Qty', width: 40, align: 'right' },
  { label: 'Taxable', width: 85, align: 'right' },
  { label: 'Rate', width: 50, align: 'right' },
  { label: 'Tax', width: 85, align: 'right' },
];

const TABLE_ROW_GAP = 4;

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
    doc.fontSize(9);
    let tableY = doc.y;
    tableY = this.drawTableRow(doc, tableY, TABLE_COLUMNS.map((col) => col.label));
    for (const line of data.lines) {
      tableY = this.drawTableRow(doc, tableY, [
        line.description,
        data.hsn,
        String(line.quantity),
        inr(line.taxable),
        `${line.rate}%`,
        inr(line.tax),
      ]);
    }
    tableY = this.drawTableRow(doc, tableY, [
      'Shipping',
      data.hsn,
      '1',
      inr(data.shippingTaxable),
      '-',
      inr(data.shippingTax),
    ]);
    // The table drew at explicit coordinates, bypassing pdfkit's own flowing
    // cursor; hand it back before resuming ordinary auto-flowing text below.
    doc.x = doc.page.margins.left;
    doc.y = tableY;
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

  /**
   * Draws one row of the line-item table at fixed column x-offsets and
   * widths, using pdfkit's own text wrapping (the `width` option) rather than
   * space padding: Helvetica is proportional, so literal spaces can't align
   * columns, and a longer description would shift every column after it. A
   * cell too long for its column wraps onto a second line within that
   * column's width instead of overrunning the next column. The row's height
   * — and the next row's starting y — is taken from the tallest cell, so a
   * wrapped description never collides with the row below it.
   */
  private drawTableRow(doc: PDFKit.PDFDocument, y: number, cells: string[]): number {
    let x = doc.page.margins.left;
    let rowHeight = 0;
    for (let i = 0; i < TABLE_COLUMNS.length; i++) {
      const column = TABLE_COLUMNS[i] as TableColumn;
      const cellText = cells[i] ?? '';
      doc.text(cellText, x, y, { width: column.width, align: column.align });
      rowHeight = Math.max(rowHeight, doc.heightOfString(cellText, { width: column.width }));
      x += column.width;
    }
    return y + rowHeight + TABLE_ROW_GAP;
  }
}
