import { loadConfig } from './config.js';
import { log } from './logger.js';
import { createApp } from './server.js';
import { createSheetsApi, GoogleSheetStore } from './adapters/googleSheetStore.js';
import { GraphWhatsAppClient } from './adapters/whatsapp.js';
import { CashfreeClient } from './adapters/cashfree.js';
import { ShopifyAdminClient } from './adapters/shopifyAdmin.js';
import { OrderIntakeService } from './services/orderIntake.js';
import { ConfirmationService } from './services/confirmation.js';
import { PaymentService } from './services/payment.js';
import { createShopifyRouter } from './routes/shopify.js';
import { createMetaRouter } from './routes/meta.js';
import { createCashfreeRouter } from './routes/cashfree.js';

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

const payments = new CashfreeClient({
  appId: config.cashfreeAppId,
  secretKey: config.cashfreeSecretKey,
  env: config.cashfreeEnv,
});

const confirmation = new ConfirmationService({
  store,
  whatsapp,
  payments,
  templateLang: config.templateLang,
  linkExpiryHours: 24,
});

const tagger = new ShopifyAdminClient({
  storeDomain: config.shopifyStoreDomain,
  adminToken: config.shopifyAdminToken,
});

const payment = new PaymentService({ store, tagger });

const app = createApp({
  routers: [
    createShopifyRouter({ intake, webhookSecret: config.shopifyWebhookSecret }),
    createMetaRouter({
      confirmation,
      appSecret: config.metaAppSecret,
      verifyToken: config.metaVerifyToken,
    }),
    createCashfreeRouter({ payment, secretKey: config.cashfreeSecretKey }),
  ],
});

app.listen(config.port, () => {
  log('info', 'hub started', { port: config.port });
});
