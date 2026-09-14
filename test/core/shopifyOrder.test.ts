import { describe, it, expect } from 'vitest';
import { parseShopifyOrder } from '../../src/core/shopifyOrder.js';
import { shopifyOrderPayload } from '../fixtures/shopifyOrder.js';

const COD_NAMES = ['cash on delivery', 'cod'];

describe('parseShopifyOrder', () => {
  it('parses a COD order end to end', () => {
    const order = parseShopifyOrder(shopifyOrderPayload(), COD_NAMES);
    expect(order).toEqual({
      orderNo: '#1042',
      orderId: '5544332211',
      customerName: 'Aarav',
      phone: '919876543210',
      amount: 1899,
      isCod: true,
      itemsSummary: 'Oversized Tee — Black x2, Cargo Pants — Olive x1',
      pincode: '700001',
      provinceCode: 'WB',
      provinceName: 'West Bengal',
      shippingCharged: 0,
      itemAmount: 1899,
      lines: [
        { inclUnitPrice: 600, quantity: 2 },
        { inclUnitPrice: 699, quantity: 1 },
      ],
      shopifyTaxTotal: 0,
    });
  });

  it('detects COD by substring match, case-insensitively', () => {
    const payload = shopifyOrderPayload({ payment_gateway_names: ['COD'] });
    expect(parseShopifyOrder(payload, COD_NAMES).isCod).toBe(true);
  });

  it('treats a prepaid gateway as not COD', () => {
    const payload = shopifyOrderPayload({
      payment_gateway_names: ['Razorpay Secure'],
      financial_status: 'paid',
    });
    expect(parseShopifyOrder(payload, COD_NAMES).isCod).toBe(false);
  });

  it('falls back to financial_status when the gateway list is empty', () => {
    const payload = shopifyOrderPayload({ payment_gateway_names: [], financial_status: 'pending' });
    expect(parseShopifyOrder(payload, COD_NAMES).isCod).toBe(true);
  });

  it('is not COD when the gateway list is empty and the order is paid', () => {
    const payload = shopifyOrderPayload({ payment_gateway_names: [], financial_status: 'paid' });
    expect(parseShopifyOrder(payload, COD_NAMES).isCod).toBe(false);
  });

  it('falls back from shipping to customer to billing phone', () => {
    const shippingMissing = shopifyOrderPayload({
      shipping_address: { phone: null },
      customer: { first_name: 'Aarav', phone: '9812345678' },
    });
    expect(parseShopifyOrder(shippingMissing, COD_NAMES).phone).toBe('919812345678');

    const onlyBilling = shopifyOrderPayload({
      shipping_address: { phone: null },
      customer: { first_name: 'Aarav', phone: null },
      billing_address: { phone: '08812345678' },
    });
    expect(parseShopifyOrder(onlyBilling, COD_NAMES).phone).toBe('918812345678');
  });

  it('returns a null phone when every candidate is unusable', () => {
    const payload = shopifyOrderPayload({
      shipping_address: { phone: '12345' },
      customer: { first_name: 'Aarav', phone: null },
      billing_address: { phone: null },
    });
    expect(parseShopifyOrder(payload, COD_NAMES).phone).toBeNull();
  });

  it('falls back to a generic name when the customer has none', () => {
    const payload = shopifyOrderPayload({
      customer: { first_name: null, phone: null },
      shipping_address: { phone: '9876543210', first_name: null },
    });
    expect(parseShopifyOrder(payload, COD_NAMES).customerName).toBe('there');
  });

  it('prefers the shipping address name when the customer record has none', () => {
    const payload = shopifyOrderPayload({ customer: { first_name: null, phone: null } });
    expect(parseShopifyOrder(payload, COD_NAMES).customerName).toBe('Aarav');
  });

  it('truncates a long items summary to 180 characters', () => {
    const line_items = Array.from({ length: 30 }, (_, i) => ({
      title: `Very Long Product Name Number ${i}`,
      quantity: 1,
    }));
    const summary = parseShopifyOrder(shopifyOrderPayload({ line_items }), COD_NAMES).itemsSummary;
    expect(summary.length).toBeLessThanOrEqual(180);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('rounds the total to whole rupees', () => {
    const payload = shopifyOrderPayload({ total_price: '1899.60' });
    expect(parseShopifyOrder(payload, COD_NAMES).amount).toBe(1900);
  });

  it('throws when the payload has no id', () => {
    expect(() => parseShopifyOrder({ name: '#1042' }, COD_NAMES)).toThrow(/id/);
  });

  it('throws when the payload has no name', () => {
    expect(() => parseShopifyOrder({ id: 1 }, COD_NAMES)).toThrow(/name/);
  });
});
