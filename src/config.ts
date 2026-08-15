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
  CASHFREE_APP_ID: z.string().min(1),
  CASHFREE_SECRET_KEY: z.string().min(1),
  CASHFREE_ENV: z.enum(['TEST', 'PROD']),
  SHEET_ID: z.string().min(1),
  DASHBOARD_TOKEN: z.string().min(1),
  COD_FEE_INR: z.coerce.number().int().nonnegative().default(50),
  COD_GATEWAY_NAMES: z.string().default('cash on delivery,cod'),
  TEMPLATE_LANG: z.string().default('en'),
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
  cashfreeAppId: string;
  cashfreeSecretKey: string;
  cashfreeEnv: 'TEST' | 'PROD';
  sheetId: string;
  dashboardToken: string;
  codFeeInr: number;
  codGatewayNames: string[];
  templateLang: string;
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
  };
}
