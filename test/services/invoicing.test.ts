import { describe, it, expect } from 'vitest';
import { InvoicingService, TEMPLATE_DELIVERED, type InvoicingDeps } from '../../src/services/invoicing.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { StubWhatsAppClient } from '../fakes/stubClients.js';
import { stateCodeFor } from '../../src/core/placeOfSupply.js';
import { baseInvoice } from '../fixtures/stage1.js';
import type { GstLine, GstRates } from '../../src/core/gst.js';
import type { InvoiceData, InvoiceRenderer } from '../../src/adapters/invoicePdf.js';
import type { OrderRow } from '../../src/adapters/sheets.js';

const NOW = new Date('2026-09-15T09:00:00.000Z');

// Seller is West Bengal ('19'), so a WB buyer is intra-state and an MH buyer is inter-state.
const SELLER = {
  legalName: 'Urbnmyth Apparel Pvt Ltd',
  address: '221B Camac Street, Kolkata, West Bengal 700016',
  gstin: '19AAAAA0000A1Z5',
  stateCode: '19',
};

const RATES: GstRates = { thresholdInr: 2500, low: 5, high: 18 };

const DEFAULT_LINES: GstLine[] = [{ inclUnitPrice: 1800, quantity: 1 }]; // 5% slab
const SHIPPING_CHARGED = 99;

/** A working renderer that records every InvoiceData it was asked to draw. */
function recordingRenderer(rendered: InvoiceData[]): InvoiceRenderer {
  return {
    render: async (data) => {
      rendered.push(data);
      return Buffer.from('%PDF-1.4 fake invoice');
    },
  };
}

async function seedOrder(
  store: InMemorySheetStore,
  orderNo: string,
  opts: { lines: GstLine[]; provinceCode: string },
): Promise<void> {
  const itemAmount = opts.lines.reduce((sum, l) => sum + l.inclUnitPrice * l.quantity, 0);
  const grossAmount = itemAmount + SHIPPING_CHARGED;
  const posCode = stateCodeFor(opts.provinceCode) ?? '';

  const order: OrderRow = {
    orderNo,
    orderId: orderNo.replace('#', ''),
    customerName: 'Aarav',
    phone: '919876543210',
    amount: grossAmount,
    codFee: 0,
    payable: grossAmount,
    isCod: true,
    confirmStatus: 'CONFIRMED',
    paymentLink: '',
    createdAt: '2026-09-01T10:00:00.000Z',
    confirmedAt: '2026-09-01T10:05:00.000Z',
    paidAt: '2026-09-01T10:05:00.000Z',
    fulfillmentStatus: 'DELIVERED',
    awb: 'SF000000001',
    cancelStatus: 'NONE',
    cancelReason: '',
    invoiceNo: '',
    rating: '',
    gstDiscrepancy: 0,
    // The exact data a real intake would have frozen — this is the load-bearing input to
    // computeGst, not the ledger's aggregate, so a mixed-rate order stays mixed-rate.
    linesJson: JSON.stringify(opts.lines),
  };
  await store.appendOrder(order);

  await store.appendLedgerOrder(
    {
      orderNo,
      orderDate: '2026-09-10',
      pincode: '700001',
      state: 'West Bengal',
      posCode,
      skus: 'ITEM x1',
      itemAmount,
      shippingCharged: SHIPPING_CHARGED,
      grossAmount,
      isCod: true,
    },
    25,
  );
}

interface HarnessOpts {
  lines?: GstLine[];
  provinceCode?: string;
  orders?: string[];
  renderer?: InvoiceRenderer;
  /** Reuse an existing store instead of seeding a fresh one — for the rollback test, which
   * must prove a *second* service instance sees the *same* unconsumed sequence number. */
  store?: InMemorySheetStore;
}

async function harness(opts: HarnessOpts = {}) {
  const store = opts.store ?? new InMemorySheetStore();
  const whatsapp = new StubWhatsAppClient();
  const rendered: InvoiceData[] = [];
  const renderer = opts.renderer ?? recordingRenderer(rendered);

  if (!opts.store) {
    const orderNos = opts.orders ?? ['#1042'];
    for (const orderNo of orderNos) {
      await seedOrder(store, orderNo, {
        lines: opts.lines ?? DEFAULT_LINES,
        provinceCode: opts.provinceCode ?? 'WB',
      });
    }
  }

  const deps: InvoicingDeps = {
    store,
    renderer,
    whatsapp,
    seller: SELLER,
    hsn: '6109',
    rates: RATES,
    seriesPrefix: 'UM',
    templateLang: 'en',
    now: () => NOW,
  };
  const svc = new InvoicingService(deps);
  return { svc, store, whatsapp, rendered };
}

describe('InvoicingService', () => {
  it('allocates the next number, renders, uploads and sends', async () => {
    const { svc, store, whatsapp } = await harness();
    const result = await svc.issueForOrder('#1042');

    expect(result?.invoiceNo).toBe('UM/26-27/0001');
    expect(whatsapp.documentsSent).toHaveLength(0);
    expect(whatsapp.sent[0]).toMatchObject({
      template: TEMPLATE_DELIVERED,
      documentHeaderMediaId: 'media.STUB1',
    });
    expect(store.invoices[0]).toMatchObject({ invoiceNo: 'UM/26-27/0001', status: 'ISSUED' });
    expect((await store.findOrderByNo('#1042'))?.invoiceNo).toBe('UM/26-27/0001');
  });

  it('rolls the counter back when rendering fails, so the series stays gapless', async () => {
    const { svc, store } = await harness({
      renderer: { render: async () => { throw new Error('pdf boom'); } },
    });

    await expect(svc.issueForOrder('#1042')).rejects.toThrow('pdf boom');
    expect(store.invoices).toHaveLength(0);
    expect((await store.findOrderByNo('#1042'))?.invoiceNo).toBe('');

    // Same store, a fresh service instance — the realistic shape of a retry (a new request,
    // or a redeployed instance) hitting a sheet that never recorded the failed attempt.
    const { svc: svc2 } = await harness({ store });
    expect((await svc2.issueForOrder('#1042'))?.invoiceNo).toBe('UM/26-27/0001');
  });

  it('never issues two numbers concurrently', async () => {
    const { svc } = await harness({ orders: ['#1', '#2', '#3'] });
    const issued = await Promise.all(['#1', '#2', '#3'].map((no) => svc.issueForOrder(no)));
    expect(issued.map((i) => i?.invoiceNo).sort()).toEqual([
      'UM/26-27/0001',
      'UM/26-27/0002',
      'UM/26-27/0003',
    ]);
  });

  it('splits CGST and SGST for a West Bengal buyer', async () => {
    const { svc, store } = await harness({ provinceCode: 'WB' });
    await svc.issueForOrder('#1042');
    expect(store.invoices[0]).toMatchObject({ igst: 0 });
    expect(store.invoices[0]!.cgst).toBeGreaterThan(0);
  });

  it('uses IGST for a Maharashtra buyer', async () => {
    const { svc, store } = await harness({ provinceCode: 'MH' });
    await svc.issueForOrder('#1042');
    expect(store.invoices[0]).toMatchObject({ cgst: 0, sgst: 0 });
    expect(store.invoices[0]!.igst).toBeGreaterThan(0);
  });

  it('is a no-op when the order already has an invoice', async () => {
    const { svc, store } = await harness();
    await svc.issueForOrder('#1042');
    expect(await svc.issueForOrder('#1042')).toBeNull();
    expect(store.invoices).toHaveLength(1);
  });

  it('writes one register row per rate for a mixed-rate order, under one number', async () => {
    const { svc, store } = await harness({
      lines: [
        { inclUnitPrice: 1000, quantity: 1 }, // 5%
        { inclUnitPrice: 3000, quantity: 1 }, // 18%
      ],
    });
    await svc.issueForOrder('#1042');

    expect(store.invoices.map((i) => i.gstRate)).toEqual([5, 18]);
    expect(new Set(store.invoices.map((i) => i.invoiceNo)).size).toBe(1);
    expect(store.invoices.every((i) => i.invoiceTotal === store.invoices[0]!.invoiceTotal)).toBe(true);
  });

  it('refuses to invoice, rather than guessing a blended rate, when lines_json is blank', async () => {
    // Was: "falls back to a single blended line and warns". That fallback tested the whole
    // subtotal against the ₹2,500 threshold, so two ₹1,400 tees — each a 5% supply — came
    // out as an 18% invoice. Spec §5.3 says flag, not guess; nothing is issued now.
    const { svc, store } = await harness();
    await store.updateOrderFields('#1042', { linesJson: '' });
    await expect(svc.issueForOrder('#1042')).rejects.toThrow(/line_items_unavailable/);
    expect(store.invoices).toHaveLength(0);
    expect((await store.findOrderByNo('#1042'))?.invoiceNo).toBe('');
  });

  it('refuses to invoice, rather than falling back to the seller state, when place of supply is unresolved', async () => {
    // Was: "falls back to the seller state and warns". Substituting '19' turned a
    // Maharashtra buyer's IGST into CGST+SGST and filed the supply under the wrong state.
    const { svc, store } = await harness({ provinceCode: 'NOPE' });
    await expect(svc.issueForOrder('#1042')).rejects.toThrow(/unresolved_place_of_supply/);
    expect(store.invoices).toHaveLength(0);
  });

  describe('amount actually charged', () => {
    it('invoices the full amount handed over at the door for a COD order, even with a codFee configured', async () => {
      const { svc, store } = await harness();
      // amount (1899) stays the door figure; payable (1849) is what an EARLY-PAY discount
      // would have been, which never applies to a COD order that pays at delivery.
      await store.updateOrderFields('#1042', { codFee: 50, payable: 1849, confirmStatus: 'CONFIRMED' });
      await svc.issueForOrder('#1042');
      expect(store.invoices[0]?.invoiceTotal).toBe(1899);
    });

    it('invoices the discounted figure for a genuinely PAID_EARLY order', async () => {
      const { svc, store } = await harness();
      await store.updateOrderFields('#1042', { codFee: 50, payable: 1849, confirmStatus: 'PAID_EARLY' });
      await svc.issueForOrder('#1042');
      expect(store.invoices[0]?.invoiceTotal).toBe(1849);
    });
  });

  describe('resuming a partially-completed issuance', () => {
    /** Simulates a prior attempt that got as far as the register write and no further. */
    async function seedIssuedRegisterRow(store: InMemorySheetStore, invoiceNo: string, mediaId: string) {
      await store.appendInvoiceLines([{ ...baseInvoice, orderNo: '#1042', invoiceNo, mediaId }]);
    }

    it('recovers by stamping the order when a register row exists but the stamp never landed — does not re-allocate or re-render', async () => {
      const { svc, store, whatsapp } = await harness();
      await seedIssuedRegisterRow(store, 'UM/26-27/0007', 'media.PRIOR');
      // order.invoiceNo is still '' — the updateOrderFields write is exactly what failed last time.

      const result = await svc.issueForOrder('#1042');

      expect(result?.invoiceNo).toBe('UM/26-27/0007');
      expect(store.invoices).toHaveLength(1); // no second register row was written
      expect((await store.findOrderByNo('#1042'))?.invoiceNo).toBe('UM/26-27/0007');
      expect(whatsapp.uploaded).toHaveLength(0); // no re-render, no re-upload
      expect(whatsapp.sent[0]).toMatchObject({ documentHeaderMediaId: 'media.PRIOR' });
    });

    it('returns null once the register row, the stamp, and the delivered message all exist — genuinely done', async () => {
      const { svc, store, whatsapp } = await harness();
      await seedIssuedRegisterRow(store, 'UM/26-27/0007', 'media.PRIOR');
      await store.updateOrderFields('#1042', { invoiceNo: 'UM/26-27/0007' });
      await store.appendMessage({
        orderNo: '#1042', template: TEMPLATE_DELIVERED, wamid: 'wamid.PRIOR', direction: 'out',
        status: 'sent', timestamp: '2026-09-10T00:00:00.000Z',
      });

      expect(await svc.issueForOrder('#1042')).toBeNull();
      expect(store.invoices).toHaveLength(1);
      expect(store.messages).toHaveLength(1); // no duplicate send
      expect(whatsapp.sent).toHaveLength(0);
    });

    it('resends the document when the order is stamped but the delivered message never went out — does not re-allocate or re-register', async () => {
      const { svc, store, whatsapp } = await harness();
      await seedIssuedRegisterRow(store, 'UM/26-27/0007', 'media.PRIOR');
      await store.updateOrderFields('#1042', { invoiceNo: 'UM/26-27/0007' });
      // No message row exists yet — sendTemplate is exactly what failed last time.

      const result = await svc.issueForOrder('#1042');

      expect(result?.invoiceNo).toBe('UM/26-27/0007');
      expect(store.invoices).toHaveLength(1);
      expect(whatsapp.uploaded).toHaveLength(0);
      expect(whatsapp.sent[0]).toMatchObject({ documentHeaderMediaId: 'media.PRIOR' });
      expect(store.messages).toHaveLength(1);
    });
  });
});
