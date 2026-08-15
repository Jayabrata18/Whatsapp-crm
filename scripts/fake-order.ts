/**
 * Posts a correctly signed fake Shopify order webhook at a running hub.
 * Use this to exercise the full Phase 1 path without placing a real order.
 *
 * Usage: npm run send:fake-order -- http://localhost:8080 919876543210
 */
import { createHmac } from 'node:crypto';

const hubUrl = process.argv[2];
const phone = process.argv[3];
const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

if (!hubUrl || !phone || !secret) {
  console.error('Usage: npm run send:fake-order -- http://localhost:8080 919876543210');
  console.error('SHOPIFY_WEBHOOK_SECRET must be set in the environment.');
  process.exit(1);
}

const orderNumber = Math.floor(1000 + Math.random() * 9000);

const payload = {
  id: Date.now(),
  name: `#TEST${orderNumber}`,
  total_price: '1899.00',
  financial_status: 'pending',
  payment_gateway_names: ['Cash on Delivery (COD)'],
  customer: { first_name: 'Test', last_name: 'Buyer', phone: null },
  shipping_address: { phone, first_name: 'Test' },
  billing_address: { phone: null },
  line_items: [
    { title: 'Oversized Tee — Black', quantity: 2 },
    { title: 'Cargo Pants — Olive', quantity: 1 },
  ],
};

const body = JSON.stringify(payload);
const signature = createHmac('sha256', secret).update(Buffer.from(body)).digest('base64');

const res = await fetch(`${hubUrl}/webhook/shopify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': signature },
  body,
});

console.log(`${res.status} ${await res.text()}`);
console.log(`Order ${payload.name} — check WhatsApp on ${phone} and the dashboard.`);
