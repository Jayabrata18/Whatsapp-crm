import { loadConfig } from './config.js';
import { log } from './logger.js';
import { createApp } from './server.js';
import { createSheetsApi, GoogleSheetStore } from './adapters/googleSheetStore.js';
import { GraphWhatsAppClient } from './adapters/whatsapp.js';
import { CashfreeClient } from './adapters/cashfree.js';
import { ShopifyAdminClient } from './adapters/shopifyAdmin.js';
import { ShadowfaxClient } from './adapters/shadowfax.js';
import { PdfKitRenderer } from './adapters/invoicePdf.js';
import { OrderIntakeService } from './services/orderIntake.js';
import { ConfirmationService } from './services/confirmation.js';
import { CancellationService } from './services/cancellation.js';
import { RatingService } from './services/rating.js';
import { PaymentService } from './services/payment.js';
import { ShipmentSyncService } from './services/shipmentSync.js';
import { EffectService } from './services/effects.js';
import { InvoicingService } from './services/invoicing.js';
import { DeliveryService } from './services/delivery.js';
import { RtoService } from './services/rto.js';
import { ReportingService } from './services/reporting.js';
import { createShopifyRouter } from './routes/shopify.js';
import { createMetaRouter } from './routes/meta.js';
import { createCashfreeRouter } from './routes/cashfree.js';
import { createShadowfaxRouter } from './routes/shadowfax.js';
import { createInternalRouter } from './routes/internal.js';
import { createApiRouter } from './routes/api.js';
import { createDashboardRouter } from './routes/dashboard.js';

const config = loadConfig(process.env);

const store = new GoogleSheetStore(await createSheetsApi(), config.sheetId);

const whatsapp = new GraphWhatsAppClient({
  accessToken: config.metaAccessToken,
  phoneNumberId: config.metaPhoneNumberId,
});

const rates = {
  thresholdInr: config.gstSlabThresholdInr,
  low: config.gstRateLow,
  high: config.gstRateHigh,
};

const intake = new OrderIntakeService({
  store,
  whatsapp,
  codFeeInr: config.codFeeInr,
  codGatewayNames: config.codGatewayNames,
  templateLang: config.templateLang,
  rates,
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

const tracker = new ShadowfaxClient({
  baseUrl: config.shadowfaxBaseUrl,
  apiKey: config.shadowfaxApiKey,
});

const invoicing = new InvoicingService({
  store,
  renderer: new PdfKitRenderer(),
  whatsapp,
  seller: {
    legalName: config.sellerLegalName,
    address: config.sellerAddress,
    gstin: config.sellerGstin,
    stateCode: config.sellerStateCode,
  },
  hsn: config.defaultHsn,
  rates,
  seriesPrefix: config.invoiceSeriesPrefix,
  templateLang: config.templateLang,
});

const delivery = new DeliveryService({
  store,
  shopify: tagger,
  invoicing,
  rates,
  platformFeePct: config.platformFeePct,
});

const rto = new RtoService({
  store,
  shopify: tagger,
  whatsapp,
  templateLang: config.templateLang,
  locationId: config.shopifyLocationId,
});

// The effect queue is the single dispatch point every delivery-outcome side effect
// runs through. A typo in one of these keys against what `ShipmentSyncService`
// actually enqueues (`'delivered'`, `'rto_initiated'`, `'rto_returned'` — see
// EFFECT_FOR in shipmentSync.ts) would silently disable that whole flow: an unknown
// `kind` is marked FAILED immediately rather than retried.
const effects = new EffectService({
  store,
  handlers: {
    delivered: async (p) => delivery.onDelivered((p as { orderNo: string }).orderNo),
    rto_initiated: async (p) => rto.onRtoInitiated((p as { orderNo: string }).orderNo),
    rto_returned: async (p) => rto.onRtoReturned((p as { orderNo: string }).orderNo),
  },
});

const shipmentSync = new ShipmentSyncService({ store, effects, tracker });

const reporting = new ReportingService({ store, sellerStateCode: config.sellerStateCode });

const app = createApp({
  routers: [
    createShopifyRouter({
      intake,
      shipmentSync,
      store,
      webhookSecret: config.shopifyWebhookSecret,
    }),
    createMetaRouter({
      confirmation,
      rating,
      appSecret: config.metaAppSecret,
      verifyToken: config.metaVerifyToken,
    }),
    createCashfreeRouter({ payment, secretKey: config.cashfreeSecretKey }),
    createShadowfaxRouter({ shipmentSync, webhookSecret: config.shadowfaxWebhookSecret }),
    createInternalRouter({
      shipmentSync,
      effects,
      rating,
      reporting,
      taskToken: config.internalTaskToken,
    }),
    createApiRouter({ store, dashboardToken: config.dashboardToken }),
    createDashboardRouter(),
  ],
});

app.listen(config.port, () => {
  log('info', 'hub started', { port: config.port });
});
