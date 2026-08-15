/**
 * Phase 0 exit test. Sends the pre-approved `hello_world` template to a phone
 * number, proving the access token, phone number id, and Meta account all work.
 *
 * Usage: npm run send:hello -- 919876543210
 */
import { loadConfig } from '../src/config.js';
import { GraphWhatsAppClient } from '../src/adapters/whatsapp.js';

const to = process.argv[2];
if (!to) {
  console.error('Usage: npm run send:hello -- 919876543210');
  process.exit(1);
}

const config = loadConfig(process.env);
const client = new GraphWhatsAppClient({
  accessToken: config.metaAccessToken,
  phoneNumberId: config.metaPhoneNumberId,
});

const { wamid } = await client.sendTemplate({
  to,
  template: 'hello_world',
  languageCode: 'en_US',
  bodyParams: [],
});

console.log(`Sent. wamid=${wamid}`);
console.log('Check the phone. If nothing arrives within a minute, check WhatsApp Manager > Insights.');
