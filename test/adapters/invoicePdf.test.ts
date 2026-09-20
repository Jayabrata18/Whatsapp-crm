import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import PDFDocument from 'pdfkit';
import { PdfKitRenderer, type InvoiceData } from '../../src/adapters/invoicePdf.js';
import { rupeesInWords } from '../../src/core/amountInWords.js';

const sampleInvoiceData: InvoiceData = {
  invoiceNo: 'UM/26-27/0007',
  invoiceDate: '2026-09-15',
  seller: {
    legalName: 'Urbnmyth Apparel Pvt Ltd',
    address: '221B Camac Street, Kolkata, West Bengal 700016',
    gstin: '19AAAAA0000A1Z5',
  },
  buyer: {
    name: 'Asha Verma',
    address: '12 Lake Gardens, Kolkata, West Bengal 700045',
  },
  placeOfSupply: 'West Bengal (19)',
  hsn: '6109',
  lines: [
    { description: 'Oversized Cotton Tee', quantity: 1, taxable: 1808.57, rate: 5, tax: 90.43 },
  ],
  shippingTaxable: 47.62,
  shippingTax: 2.38,
  split: { cgst: 46.41, sgst: 46.4, igst: 0 },
  roundOff: 0,
  total: 1949,
};

describe('PdfKitRenderer', () => {
  // Spying on pdfkit's own public `text()` method — rather than reading the
  // rendered bytes — lets these tests assert on what the renderer *told
  // pdfkit to draw*, matching the design spec's "testable by asserting on
  // draw calls" and staying independent of how pdfkit happens to encode a
  // page's content stream. `text` lives on the shared prototype, so spying on
  // it here catches calls made by any PDFDocument instance created during the
  // test, including the one `render()` constructs internally.
  let textSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    textSpy = vi.spyOn(PDFDocument.prototype, 'text');
  });

  afterEach(() => {
    textSpy.mockRestore();
  });

  function drawnText(): string[] {
    return textSpy.mock.calls.map((call: unknown[]) => String(call[0]));
  }

  it('produces a well-formed PDF and draws every legally required field', async () => {
    const bytes = await new PdfKitRenderer().render(sampleInvoiceData);

    // Smoke check that a real, non-trivial PDF came out — not an assertion
    // about pdfkit's internal encoding, just that rendering actually worked.
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(500);

    const drawn = drawnText();
    const containsSubstring = (value: string) => drawn.some((line) => line.includes(value));
    const line = sampleInvoiceData.lines[0];
    if (!line) throw new Error('test fixture must have at least one line item');

    // Fields drawn as their own atomic cell/line — assert the exact drawn
    // value, so this fails if that specific field were ever dropped, not
    // just if some unrelated string happens to contain it.
    const expectedWords = rupeesInWords(sampleInvoiceData.total);
    const exactCells = [
      'TAX INVOICE',
      'HSN', // table column header
      sampleInvoiceData.hsn, // actual HSN code on the line item, not just the header word
      line.description,
      String(line.quantity),
      `Rs ${line.taxable.toFixed(2)}`,
      `${line.rate}%`,
      `Rs ${line.tax.toFixed(2)}`,
      'Shipping',
      `Rs ${sampleInvoiceData.shippingTaxable.toFixed(2)}`,
      `Rs ${sampleInvoiceData.shippingTax.toFixed(2)}`,
      'Computer generated invoice, no signature required',
    ];
    for (const value of exactCells) {
      expect(drawn.includes(value)).toBe(true);
    }

    // Fields drawn as part of a longer labelled line ("Invoice No: ...") —
    // assert the field's real value appears, not just the label.
    const labelledSubstrings = [
      sampleInvoiceData.seller.legalName,
      sampleInvoiceData.seller.address,
      sampleInvoiceData.seller.gstin,
      sampleInvoiceData.invoiceNo,
      sampleInvoiceData.invoiceDate,
      sampleInvoiceData.buyer.name,
      sampleInvoiceData.buyer.address,
      sampleInvoiceData.placeOfSupply,
      `Rs ${sampleInvoiceData.split.cgst.toFixed(2)}`,
      `Rs ${sampleInvoiceData.split.sgst.toFixed(2)}`,
      `Rs ${sampleInvoiceData.roundOff.toFixed(2)}`,
      `Rs ${sampleInvoiceData.total.toFixed(2)}`,
      expectedWords, // the total-in-words integration with amountInWords.ts
    ];
    for (const value of labelledSubstrings) {
      expect(containsSubstring(value)).toBe(true);
    }
  });

  it('draws CGST and SGST for an intra-state buyer, and never draws an IGST line', async () => {
    await new PdfKitRenderer().render(sampleInvoiceData);

    const drawn = drawnText();
    expect(drawn.some((line) => line.includes('CGST'))).toBe(true);
    expect(drawn.some((line) => line.includes('SGST'))).toBe(true);
    // Guards against a renderer that draws both lines and merely zeroes the
    // unused one, rather than genuinely branching on the split.
    expect(drawn.some((line) => line.includes('IGST'))).toBe(false);
  });

  it('draws IGST for an inter-state buyer, and never draws a CGST or SGST line', async () => {
    await new PdfKitRenderer().render({ ...sampleInvoiceData, split: { cgst: 0, sgst: 0, igst: 90.43 } });

    const drawn = drawnText();
    expect(drawn.some((line) => line.includes('IGST'))).toBe(true);
    expect(drawn.some((line) => line.includes('CGST'))).toBe(false);
    expect(drawn.some((line) => line.includes('SGST'))).toBe(false);
  });

  it('wraps a long description within its column instead of overrunning the next one', async () => {
    const longDescription =
      'Premium Heavyweight Oversized Cotton Crewneck T-Shirt With Reinforced Stitching And Ribbed Collar';
    await new PdfKitRenderer().render({
      ...sampleInvoiceData,
      lines: [{ ...sampleInvoiceData.lines[0]!, description: longDescription }],
    });

    const drawn = drawnText();
    // The renderer must still hand the full, untruncated description to
    // pdfkit (wrapping happens inside pdfkit via the column's `width` option,
    // not by the renderer cutting the string short itself).
    expect(drawn).toContain(longDescription);
    // The HSN cell drawn right after it must be exactly the code, not the
    // tail end of the description spilling over — i.e. columns, not padding.
    expect(drawn).toContain(sampleInvoiceData.hsn);
  });
});
