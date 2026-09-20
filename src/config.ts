import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  META_ACCESS_TOKEN: z.string().min(1),
  META_PHONE_NUMBER_ID: z.string().min(1),
  META_WABA_ID: z.string().min(1),
  META_VERIFY_TOKEN: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  SHOPIFY_WEBHOOK_SECRET: z.string().min(1),
  SHOPIFY_STORE_DOMAIN: z.string().min(1),
  SHOPIFY_ADMIN_TOKEN: z.string().min(1),
  /** Single fulfillment location `RtoService.onRtoReturned` posts restock adjustments against. */
  SHOPIFY_LOCATION_ID: z.string().min(1),
  CASHFREE_APP_ID: z.string().optional().default(''),
  CASHFREE_SECRET_KEY: z.string().optional().default(''),
  CASHFREE_ENV: z.enum(['TEST', 'PROD']).optional().default('TEST'),
  SHEET_ID: z.string().min(1),
  DASHBOARD_TOKEN: z.string().min(1),
  COD_FEE_INR: z.coerce.number().int().nonnegative().default(50),
  COD_GATEWAY_NAMES: z.string().default('cash on delivery,cod'),
  TEMPLATE_LANG: z.string().default('en'),
  SHADOWFAX_BASE_URL: z.string().url(),
  SHADOWFAX_API_KEY: z.string().min(1),
  SHADOWFAX_WEBHOOK_SECRET: z.string().min(1),
  SELLER_LEGAL_NAME: z.string().min(1),
  SELLER_ADDRESS: z.string().min(1),
  SELLER_GSTIN: z.string().length(15),
  SELLER_STATE_CODE: z.string().length(2).default('19'),
  DEFAULT_HSN: z.string().min(4),
  GST_SLAB_THRESHOLD_INR: z.coerce.number().positive().default(2500),
  GST_RATE_LOW: z.coerce.number().nonnegative().default(5),
  GST_RATE_HIGH: z.coerce.number().nonnegative().default(18),
  INVOICE_SERIES_PREFIX: z.string().min(1).default('UM'),
  PLATFORM_FEE_PCT: z.coerce.number().nonnegative().default(5),
  CORPORATE_TAX_PCT: z.coerce.number().nonnegative().default(25),
  PAY_EARLY_ENABLED: z.enum(['true', 'false']).default('false'),
  RATING_DELAY_DAYS: z.coerce.number().int().positive().default(3),
  JUDGEME_REVIEW_URL: z.string().url(),
  INTERNAL_TASK_TOKEN: z.string().min(16),
}).superRefine((env, ctx) => {
  // The first two digits of a GSTIN ARE the state code. If the two disagree, every
  // invoice prints one state's GSTIN while declaring supplies from another, and every
  // intra/inter-state decision is taken against the wrong home state — a systematic
  // filing error that produces no error message anywhere. Cheapest possible place to
  // catch it is before the process finishes starting.
  if (env.SELLER_GSTIN.slice(0, 2) !== env.SELLER_STATE_CODE) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SELLER_GSTIN'],
      message:
        `must begin with SELLER_STATE_CODE (${env.SELLER_STATE_CODE}), ` +
        `but begins with ${env.SELLER_GSTIN.slice(0, 2)}`,
    });
  }
});

export interface Config {
  port: number;
  metaAccessToken: string;
  metaPhoneNumberId: string;
  metaWabaId: string;
  metaVerifyToken: string;
  metaAppSecret: string;
  shopifyWebhookSecret: string;
  shopifyStoreDomain: string;
  shopifyAdminToken: string;
  shopifyLocationId: string;
  cashfreeAppId: string;
  cashfreeSecretKey: string;
  cashfreeEnv: 'TEST' | 'PROD';
  sheetId: string;
  dashboardToken: string;
  codFeeInr: number;
  codGatewayNames: string[];
  templateLang: string;
  shadowfaxBaseUrl: string;
  shadowfaxApiKey: string;
  shadowfaxWebhookSecret: string;
  sellerLegalName: string;
  sellerAddress: string;
  sellerGstin: string;
  sellerStateCode: string;
  defaultHsn: string;
  gstSlabThresholdInr: number;
  gstRateLow: number;
  gstRateHigh: number;
  invoiceSeriesPrefix: string;
  platformFeePct: number;
  corporateTaxPct: number;
  payEarlyEnabled: boolean;
  ratingDelayDays: number;
  judgemeReviewUrl: string;
  internalTaskToken: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration — ${details}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    metaAccessToken: e.META_ACCESS_TOKEN,
    metaPhoneNumberId: e.META_PHONE_NUMBER_ID,
    metaWabaId: e.META_WABA_ID,
    metaVerifyToken: e.META_VERIFY_TOKEN,
    metaAppSecret: e.META_APP_SECRET,
    shopifyWebhookSecret: e.SHOPIFY_WEBHOOK_SECRET,
    shopifyStoreDomain: e.SHOPIFY_STORE_DOMAIN,
    shopifyAdminToken: e.SHOPIFY_ADMIN_TOKEN,
    shopifyLocationId: e.SHOPIFY_LOCATION_ID,
    cashfreeAppId: e.CASHFREE_APP_ID,
    cashfreeSecretKey: e.CASHFREE_SECRET_KEY,
    cashfreeEnv: e.CASHFREE_ENV,
    sheetId: e.SHEET_ID,
    dashboardToken: e.DASHBOARD_TOKEN,
    codFeeInr: e.COD_FEE_INR,
    codGatewayNames: e.COD_GATEWAY_NAMES.split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
    templateLang: e.TEMPLATE_LANG,
    shadowfaxBaseUrl: e.SHADOWFAX_BASE_URL,
    shadowfaxApiKey: e.SHADOWFAX_API_KEY,
    shadowfaxWebhookSecret: e.SHADOWFAX_WEBHOOK_SECRET,
    sellerLegalName: e.SELLER_LEGAL_NAME,
    sellerAddress: e.SELLER_ADDRESS,
    sellerGstin: e.SELLER_GSTIN,
    sellerStateCode: e.SELLER_STATE_CODE,
    defaultHsn: e.DEFAULT_HSN,
    gstSlabThresholdInr: e.GST_SLAB_THRESHOLD_INR,
    gstRateLow: e.GST_RATE_LOW,
    gstRateHigh: e.GST_RATE_HIGH,
    invoiceSeriesPrefix: e.INVOICE_SERIES_PREFIX,
    platformFeePct: e.PLATFORM_FEE_PCT,
    corporateTaxPct: e.CORPORATE_TAX_PCT,
    payEarlyEnabled: e.PAY_EARLY_ENABLED === 'true',
    ratingDelayDays: e.RATING_DELAY_DAYS,
    judgemeReviewUrl: e.JUDGEME_REVIEW_URL,
    internalTaskToken: e.INTERNAL_TASK_TOKEN,
  };
}
