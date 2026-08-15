export function shopifyOrderPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 5544332211,
    name: '#1042',
    total_price: '1899.00',
    financial_status: 'pending',
    payment_gateway_names: ['Cash on Delivery (COD)'],
    customer: { first_name: 'Aarav', last_name: 'Sharma', phone: null },
    shipping_address: { phone: '+91 98765 43210', first_name: 'Aarav' },
    billing_address: { phone: null },
    line_items: [
      { title: 'Oversized Tee — Black', quantity: 2 },
      { title: 'Cargo Pants — Olive', quantity: 1 },
    ],
    ...overrides,
  };
}
