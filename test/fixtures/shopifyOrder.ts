export function shopifyOrderPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 5544332211,
    name: '#1042',
    total_price: '1899.00',
    subtotal_price: '1899.00',
    financial_status: 'pending',
    payment_gateway_names: ['Cash on Delivery (COD)'],
    customer: { first_name: 'Aarav', last_name: 'Sharma', phone: null },
    shipping_address: {
      phone: '+91 98765 43210',
      first_name: 'Aarav',
      zip: '700001',
      province_code: 'WB',
      province: 'West Bengal',
    },
    billing_address: { phone: null },
    line_items: [
      { title: 'Oversized Tee — Black', quantity: 2, price: '600.00' },
      { title: 'Cargo Pants — Olive', quantity: 1, price: '699.00' },
    ],
    total_shipping_price_set: { shop_money: { amount: '0.00' } },
    ...overrides,
  };
}
