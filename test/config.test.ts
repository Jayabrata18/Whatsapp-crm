import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const baseEnv = {
  META_ACCESS_TOKEN: 'tok',
  META_PHONE_NUMBER_ID: '123',
  META_WABA_ID: '456',
  META_VERIFY_TOKEN: 'verify',
  META_APP_SECRET: 'secret',
  SHOPIFY_WEBHOOK_SECRET: 'shopsecret',
  SHOPIFY_STORE_DOMAIN: 'urbnmyth.myshopify.com',
  SHOPIFY_ADMIN_TOKEN: 'shpat_x',
  SHOPIFY_LOCATION_ID: 'gid://shopify/Location/9',
  CASHFREE_APP_ID: 'cfid',
  CASHFREE_SECRET_KEY: 'cfsecret',
  CASHFREE_ENV: 'TEST',
  SHEET_ID: 'sheet123',
  DASHBOARD_TOKEN: 'dash',
  SELLER_LEGAL_NAME: 'Urbnmyth Apparel LLP',
  SELLER_ADDRESS: '123 Park Street, Kolkata, West Bengal 700016',
  SELLER_GSTIN: '19AAAAA0000A1Z5',
  DEFAULT_HSN: '6109',
  SHADOWFAX_BASE_URL: 'https://api.shadowfax.in',
  SHADOWFAX_API_KEY: 'sfkey',
  SHADOWFAX_WEBHOOK_SECRET: 'sfwebhooksecret',
  INTERNAL_TASK_TOKEN: 'a-long-enough-secret',
  JUDGEME_REVIEW_URL: 'https://judge.me/reviews/new',
};

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const config = loadConfig(baseEnv);
    expect(config.codFeeInr).toBe(50);
    expect(config.port).toBe(8080);
    expect(config.templateLang).toBe('en');
    expect(config.codGatewayNames).toEqual(['cash on delivery', 'cod']);
  });

  it('parses COD_FEE_INR and COD_GATEWAY_NAMES overrides', () => {
    const config = loadConfig({
      ...baseEnv,
      COD_FEE_INR: '75',
      COD_GATEWAY_NAMES: 'Cash on Delivery (COD), Pay on Delivery',
    });
    expect(config.codFeeInr).toBe(75);
    expect(config.codGatewayNames).toEqual(['cash on delivery (cod)', 'pay on delivery']);
  });

  it('throws naming the missing variable', () => {
    const { META_ACCESS_TOKEN, ...missing } = baseEnv;
    void META_ACCESS_TOKEN;
    expect(() => loadConfig(missing)).toThrow(/META_ACCESS_TOKEN/);
  });

  it('rejects a non-numeric COD_FEE_INR', () => {
    expect(() => loadConfig({ ...baseEnv, COD_FEE_INR: 'fifty' })).toThrow(/COD_FEE_INR/);
  });

  it('loads Stage 1 business rules with defaults', () => {
    const cfg = loadConfig({ ...baseEnv, SELLER_GSTIN: '19AAAAA0000A1Z5' });
    expect(cfg.gstSlabThresholdInr).toBe(2500);
    expect(cfg.gstRateLow).toBe(5);
    expect(cfg.gstRateHigh).toBe(18);
    expect(cfg.sellerStateCode).toBe('19');
    expect(cfg.platformFeePct).toBe(5);
    expect(cfg.ratingDelayDays).toBe(3);
    expect(cfg.payEarlyEnabled).toBe(false);
  });

  it('rejects a GSTIN of the wrong length', () => {
    expect(() => loadConfig({ ...baseEnv, SELLER_GSTIN: 'nope' })).toThrow(/SELLER_GSTIN/);
  });
});
