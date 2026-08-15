import { normalizeIndianPhone } from './phone.js';

export interface ParsedOrder {
  orderNo: string;
  orderId: string;
  customerName: string;
  phone: string | null;
  amount: number;
  isCod: boolean;
  itemsSummary: string;
}

const SUMMARY_MAX = 180;

interface RawAddress {
  phone?: string | null;
  first_name?: string | null;
}

interface RawPayload {
  id?: unknown;
  name?: unknown;
  total_price?: unknown;
  financial_status?: unknown;
  payment_gateway_names?: unknown;
  customer?: { first_name?: string | null; phone?: string | null } | null;
  shipping_address?: RawAddress | null;
  billing_address?: RawAddress | null;
  line_items?: Array<{ title?: string | null; quantity?: number | null }> | null;
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

  return {
    orderNo: raw.name,
    orderId: String(raw.id),
    customerName,
    phone,
    amount: Number.isFinite(amount) ? amount : 0,
    isCod: detectCod(raw, codGatewayNames),
    itemsSummary: buildItemsSummary(raw),
  };
}
