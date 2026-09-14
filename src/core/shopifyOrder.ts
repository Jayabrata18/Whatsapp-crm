import { round2 } from './gst.js';
import type { GstLine } from './gst.js';
import { normalizeIndianPhone } from './phone.js';

export interface ParsedOrder {
  orderNo: string;
  orderId: string;
  customerName: string;
  phone: string | null;
  amount: number;
  isCod: boolean;
  itemsSummary: string;
  pincode: string;
  provinceCode: string | null;
  provinceName: string;
  shippingCharged: number;
  itemAmount: number;
  lines: GstLine[];
  shopifyTaxTotal: number;
}

const SUMMARY_MAX = 180;

interface RawAddress {
  phone?: string | null;
  first_name?: string | null;
  zip?: string | null;
  province_code?: string | null;
  province?: string | null;
}

interface RawPayload {
  id?: unknown;
  name?: unknown;
  total_price?: unknown;
  subtotal_price?: unknown;
  financial_status?: unknown;
  payment_gateway_names?: unknown;
  customer?: { first_name?: string | null; phone?: string | null } | null;
  shipping_address?: RawAddress | null;
  billing_address?: RawAddress | null;
  line_items?: Array<{ title?: string | null; quantity?: number | null; price?: unknown }> | null;
  total_shipping_price_set?: { shop_money?: { amount?: unknown } | null } | null;
  tax_lines?: Array<{ price?: unknown }> | null;
}

function detectCod(payload: RawPayload, codGatewayNames: string[]): boolean {
  const gateways = Array.isArray(payload.payment_gateway_names)
    ? payload.payment_gateway_names.filter((g): g is string => typeof g === 'string')
    : [];

  if (gateways.length > 0) {
    return gateways.some((gateway) => {
      const lower = gateway.toLowerCase();
      return codGatewayNames.some((needle) => lower.includes(needle));
    });
  }

  // No gateway information — an unpaid order is almost certainly COD.
  return payload.financial_status === 'pending';
}

function buildItemsSummary(payload: RawPayload): string {
  const items = Array.isArray(payload.line_items) ? payload.line_items : [];
  const summary = items.map((item) => `${item?.title ?? 'Item'} x${item?.quantity ?? 1}`).join(', ');
  if (summary.length <= SUMMARY_MAX) return summary;
  return `${summary.slice(0, SUMMARY_MAX - 1)}…`;
}

export function parseShopifyOrder(payload: unknown, codGatewayNames: string[]): ParsedOrder {
  const raw = (payload ?? {}) as RawPayload;

  if (raw.id === undefined || raw.id === null || raw.id === '') {
    throw new Error('Shopify payload is missing id');
  }
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new Error('Shopify payload is missing name');
  }

  const phone =
    normalizeIndianPhone(raw.shipping_address?.phone) ??
    normalizeIndianPhone(raw.customer?.phone) ??
    normalizeIndianPhone(raw.billing_address?.phone);

  const customerName =
    raw.customer?.first_name?.trim() || raw.shipping_address?.first_name?.trim() || 'there';

  const amount = Math.round(Number(raw.total_price ?? 0));

  const lines: GstLine[] = (Array.isArray(raw.line_items) ? raw.line_items : []).map((item) => ({
    inclUnitPrice: Number(item?.price ?? 0),
    quantity: Number(item?.quantity ?? 0),
  }));

  const shopifyTaxTotal = round2(
    (Array.isArray(raw.tax_lines) ? raw.tax_lines : [])
      .reduce((sum, line) => sum + Number(line?.price ?? 0), 0),
  );

  return {
    orderNo: raw.name,
    orderId: String(raw.id),
    customerName,
    phone,
    amount: Number.isFinite(amount) ? amount : 0,
    isCod: detectCod(raw, codGatewayNames),
    itemsSummary: buildItemsSummary(raw),
    pincode: raw.shipping_address?.zip ?? '',
    provinceCode: raw.shipping_address?.province_code ?? null,
    provinceName: raw.shipping_address?.province ?? '',
    shippingCharged: Number(raw.total_shipping_price_set?.shop_money?.amount ?? 0),
    itemAmount: Number(raw.subtotal_price ?? 0),
    lines,
    shopifyTaxTotal,
  };
}
