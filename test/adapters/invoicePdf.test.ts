import { describe, it, expect } from 'vitest';
import { PdfKitRenderer, type InvoiceData } from '../../src/adapters/invoicePdf.js';

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
  it('produces a PDF containing every legally required field', async () => {
    const bytes = await new PdfKitRenderer().render(sampleInvoiceData);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    const text = bytes.toString('latin1');
    for (const needed of ['UM/26-27/0007', '19AAAAA0000A1Z5', 'Place of Supply', 'HSN', 'CGST', 'SGST', 'no signature required']) {
      expect(text).toContain(needed);
    }
  });

  it('shows IGST instead of CGST/SGST for an inter-state buyer', async () => {
    const bytes = await new PdfKitRenderer().render({ ...sampleInvoiceData, split: { cgst: 0, sgst: 0, igst: 90.43 } });
    const text = bytes.toString('latin1');
    expect(text).toContain('IGST');
    expect(text).not.toContain('CGST');
  });
});
