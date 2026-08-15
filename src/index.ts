import { loadConfig } from './config.js';
import { log } from './logger.js';
import { createApp } from './server.js';
import { createSheetsApi, GoogleSheetStore } from './adapters/googleSheetStore.js';
import { GraphWhatsAppClient } from './adapters/whatsapp.js';
import { OrderIntakeService } from './services/orderIntake.js';
import { createShopifyRouter } from './routes/shopify.js';

const config = loadConfig(process.env);

const store = new GoogleSheetStore(await createSheetsApi(), config.sheetId);

const whatsapp = new GraphWhatsAppClient({
  accessToken: config.metaAccessToken,
  phoneNumberId: config.metaPhoneNumberId,
});

const intake = new OrderIntakeService({
  store,
  whatsapp,
  codFeeInr: config.codFeeInr,
  codGatewayNames: config.codGatewayNames,
  templateLang: config.templateLang,
});

const app = createApp({
  routers: [createShopifyRouter({ intake, webhookSecret: config.shopifyWebhookSecret })],
});

app.listen(config.port, () => {
  log('info', 'hub started', { port: config.port });
});
