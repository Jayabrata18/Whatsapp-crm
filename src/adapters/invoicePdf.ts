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

const MARGIN = 40;
const FONT_NAME = 'Helvetica';

function inr(amount: number): string {
  return `Rs ${amount.toFixed(2)}`;
}

/**
 * Escapes the characters that are special inside a PDF literal string (`(...)`):
 * backslash and the two parentheses. Everything else is passed through as-is.
 */
function escapePdfLiteral(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * pdfkit's own `doc.text()` always encodes drawn text as hex glyph strings
 * (`<...>`) inside `TJ` arrays, even for the 14 standard fonts — that's how its
 * fontkit-based layout engine works. That is perfectly valid PDF, but it means
 * the *raw bytes* of the content stream never contain the plain ASCII of the
 * text you drew, only its hex encoding. For a legal document we want both: a
 * normally-renderable PDF and a content stream whose bytes are human/greppable
 * text (this is what task-16 and any downstream tooling will rely on, and it's
 * what a plain-text extraction of a WhatsApp-delivered invoice should show).
 *
 * So this renderer draws every string itself with the literal-string form of
 * the `Tj` operator, which is equally valid PDF for a simple (non-CID),
 * single-byte-encoded font such as standard Helvetica.
 */
class LiteralTextWriter {
  private readonly doc: PDFKit.PDFDocument;
  private readonly fontId: string;
  y: number;

  constructor(doc: PDFKit.PDFDocument) {
    this.doc = doc;
    this.y = MARGIN;
    doc.font(FONT_NAME);
    this.fontId = this.registerFont(doc);
  }

  /**
   * pdfkit only adds a font to the page's `/Resources /Font` dictionary as a
   * side effect of drawing text through its own `.text()` path. Since we never
   * call that path, we replicate its one-line registration here so `/F1` (or
   * whatever id pdfkit assigned) actually resolves when the PDF is opened.
   */
  private registerFont(doc: PDFKit.PDFDocument): string {
    const font = (doc as unknown as { _font: { id: string; ref(): unknown } })._font;
    if (doc.page.fonts[font.id] == null) {
      doc.page.fonts[font.id] = font.ref();
    }
    return font.id;
  }

  /** Draws one line of text at the current cursor and advances it. */
  line(text: string, opts: { size?: number; center?: boolean; gapBefore?: number } = {}): void {
    const size = opts.size ?? 9;
    this.y += opts.gapBefore ?? 0;
    this.doc.fontSize(size);

    const contentWidth = this.doc.page.width - MARGIN * 2;
    const x = opts.center ? MARGIN + (contentWidth - this.doc.widthOfString(text)) / 2 : MARGIN;

    // pdfkit unconditionally writes a `1 0 0 -1 0 H cm` flip once at the start
    // of every page's content stream (in addPage()), turning the whole stream
    // into a top-down (y increases downward) coordinate space for anything
    // drawn without its own compensating flip — which is what we do here. So
    // the y we hand to Tm is plain top-down distance from the page top, offset
    // by the font's approximate ascent so the glyphs sit below our cursor
    // rather than straddling it.
    const baselineY = this.y + size * 0.8;

    this.doc.addContent('BT');
    this.doc.addContent(`/${this.fontId} ${size} Tf`);
    this.doc.addContent(`1 0 0 1 ${x} ${baselineY} Tm`);
    this.doc.addContent(`(${escapePdfLiteral(text)}) Tj`);
    this.doc.addContent('ET');

    this.y += size * 1.3;
  }
}

/**
 * Renders a GST tax invoice as a PDF using pdfkit rather than headless Chrome:
 * this is a one-page document sent from a service that runs at
 * min-instances=0, so a small, deterministic, direct-drawing renderer beats a
 * ~300MB browser dependency with multi-second cold starts.
 */
export class PdfKitRenderer implements InvoiceRenderer {
  async render(data: InvoiceData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      // compress: false keeps the content stream uncompressed, which is
      // load-bearing: it's what lets the literal text drawn below survive as
      // plain readable bytes in the output buffer.
      const doc = new PDFDocument({ size: 'A4', margin: MARGIN, compress: false });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      this.draw(doc, data);
      doc.end();
    });
  }

  private draw(doc: PDFKit.PDFDocument, data: InvoiceData): void {
    const w = new LiteralTextWriter(doc);

    w.line('TAX INVOICE', { size: 16, center: true });

    // Seller block: legal name, address and GSTIN are required on every GST
    // tax invoice.
    w.line(data.seller.legalName, { size: 11, gapBefore: 10 });
    w.line(data.seller.address, { size: 9 });
    w.line(`GSTIN: ${data.seller.gstin}`, { size: 9 });

    w.line(`Invoice No: ${data.invoiceNo}`, { size: 9, gapBefore: 10 });
    w.line(`Invoice Date: ${data.invoiceDate}`, { size: 9 });

    // Buyer block and place of supply.
    w.line(`Bill To: ${data.buyer.name}`, { size: 9, gapBefore: 10 });
    w.line(data.buyer.address, { size: 9 });
    w.line(`Place of Supply: ${data.placeOfSupply}`, { size: 9 });

    // Line-item table: description, HSN, quantity, taxable value, rate, tax.
    w.line('Description        HSN      Qty      Taxable      Rate      Tax', { size: 9, gapBefore: 10 });
    for (const line of data.lines) {
      w.line(
        `${line.description}   ${data.hsn}   ${line.quantity}   ${inr(line.taxable)}   ${line.rate}%   ${inr(line.tax)}`,
        { size: 9 },
      );
    }
    w.line(`Shipping   ${data.hsn}   1   ${inr(data.shippingTaxable)}   -   ${inr(data.shippingTax)}`, { size: 9 });

    // Tax split: CGST+SGST for an intra-state supply, IGST for an
    // inter-state one — never both on the same invoice.
    if (data.split.igst > 0) {
      w.line(`IGST: ${inr(data.split.igst)}`, { size: 9, gapBefore: 10 });
    } else {
      w.line(`CGST: ${inr(data.split.cgst)}`, { size: 9, gapBefore: 10 });
      w.line(`SGST: ${inr(data.split.sgst)}`, { size: 9 });
    }

    w.line(`Round Off: ${inr(data.roundOff)}`, { size: 9, gapBefore: 10 });
    w.line(`Total: ${inr(data.total)}`, { size: 10 });
    w.line(`Amount in Words: ${rupeesInWords(data.total)}`, { size: 9 });

    w.line('Computer generated invoice, no signature required', { size: 8, center: true, gapBefore: 20 });
  }
}
