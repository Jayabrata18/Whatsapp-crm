import { loadConfig } from './config.js';
import { log } from './logger.js';
import { createApp } from './server.js';
import { createSheetsApi, GoogleSheetStore } from './adapters/googleSheetStore.js';
import { GraphWhatsAppClient } from './adapters/whatsapp.js';
import { CashfreeClient } from './adapters/cashfree.js';
import { ShopifyAdminClient } from './adapters/shopifyAdmin.js';
import { OrderIntakeService } from './services/orderIntake.js';
import { ConfirmationService } from './services/confirmation.js';
import { CancellationService } from './services/cancellation.js';
import { RatingService } from './services/rating.js';
import { PaymentService } from './services/payment.js';
import { createShopifyRouter } from './routes/shopify.js';
import { createMetaRouter } from './routes/meta.js';
import { createCashfreeRouter } from './routes/cashfree.js';
import { createApiRouter } from './routes/api.js';
import { createDashboardRouter } from './routes/dashboard.js';

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
  rates: {
    thresholdInr: config.gstSlabThresholdInr,
    low: config.gstRateLow,
    high: config.gstRateHigh,
  },
  corporateTaxPct: config.corporateTaxPct,
});

const payments = new CashfreeClient({
  appId: config.cashfreeAppId,
  secretKey: config.cashfreeSecretKey,
  env: config.cashfreeEnv,
});

const tagger = new ShopifyAdminClient({
  storeDomain: config.shopifyStoreDomain,
  adminToken: config.shopifyAdminToken,
});

const cancellation = new CancellationService({
  store,
  shopify: tagger,
  whatsapp,
  templateLang: config.templateLang,
});

const confirmation = new ConfirmationService({
  store,
  whatsapp,
  payments,
  cancellation,
  templateLang: config.templateLang,
  linkExpiryHours: 24,
  payEarlyEnabled: config.payEarlyEnabled,
});

const payment = new PaymentService({ store, tagger });

const rating = new RatingService({
  store,
  whatsapp,
  templateLang: config.templateLang,
  ratingDelayDays: config.ratingDelayDays,
  judgemeReviewUrl: config.judgemeReviewUrl,
});

const app = createApp({
  routers: [
    createShopifyRouter({ intake, webhookSecret: config.shopifyWebhookSecret }),
    createMetaRouter({
      confirmation,
      rating,
      appSecret: config.metaAppSecret,
      verifyToken: config.metaVerifyToken,
    }),
    createCashfreeRouter({ payment, secretKey: config.cashfreeSecretKey }),
    createApiRouter({ store, dashboardToken: config.dashboardToken }),
    createDashboardRouter(),
  ],
});

app.listen(config.port, () => {
  log('info', 'hub started', { port: config.port });
});
