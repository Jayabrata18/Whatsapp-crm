import type { EffectRow, InvoiceRow, ShipmentRow } from '../../src/adapters/sheets.js';

export const baseShipment: ShipmentRow = {
  orderNo: '#1042',
  awb: 'SF000000001',
  courier: 'Shadowfax',
  status: 'SHIPPED',
  shippedAt: '2026-09-10T10:00:00.000Z',
  ofdAt: '',
  deliveredAt: '',
  rtoInitiatedAt: '',
  rtoReturnedAt: '',
  lastSyncedAt: '2026-09-10T10:00:00.000Z',
  rawStatus: 'IN_TRANSIT',
  rtoRestockedAt: '',
};

export const baseInvoice: InvoiceRow = {
  invoiceNo: 'UM/26-27/0001',
  orderNo: '#1042',
  invoiceDate: '2026-09-10',
  placeOfSupply: 'KA',
  hsn: '6109',
  gstRate: 5,
  taxableValue: 1000,
  cgst: 25,
  sgst: 25,
  igst: 0,
  roundOff: 0,
  invoiceTotal: 1050,
  mediaId: 'media-abc',
  status: 'ISSUED',
};

export const baseEffect: EffectRow = {
  effectId: 'eff-1',
  orderNo: '#1042',
  kind: 'RTO_CANCEL',
  payloadJson: '{}',
  attempts: 0,
  state: 'PENDING',
  lastError: '',
  createdAt: '2026-09-10T10:00:00.000Z',
  nextAttemptAt: '2026-09-10T10:00:00.000Z',
};
