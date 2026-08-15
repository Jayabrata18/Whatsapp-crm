import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const valid = {
  META_ACCESS_TOKEN: 'tok',
  META_PHONE_NUMBER_ID: '123',
  META_WABA_ID: '456',
  META_VERIFY_TOKEN: 'verify',
  META_APP_SECRET: 'secret',
  SHOPIFY_WEBHOOK_SECRET: 'shopsecret',
  SHOPIFY_STORE_DOMAIN: 'urbnmyth.myshopify.com',
  SHOPIFY_ADMIN_TOKEN: 'shpat_x',
  CASHFREE_APP_ID: 'cfid',
  CASHFREE_SECRET_KEY: 'cfsecret',
  CASHFREE_ENV: 'TEST',
  SHEET_ID: 'sheet123',
  DASHBOARD_TOKEN: 'dash',
};

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const config = loadConfig(valid);
    expect(config.codFeeInr).toBe(50);
    expect(config.port).toBe(8080);
    expect(config.templateLang).toBe('en');
    expect(config.codGatewayNames).toEqual(['cash on delivery', 'cod']);
  });

  it('parses COD_FEE_INR and COD_GATEWAY_NAMES overrides', () => {
    const config = loadConfig({
      ...valid,
      COD_FEE_INR: '75',
      COD_GATEWAY_NAMES: 'Cash on Delivery (COD), Pay on Delivery',
    });
    expect(config.codFeeInr).toBe(75);
    expect(config.codGatewayNames).toEqual(['cash on delivery (cod)', 'pay on delivery']);
  });

  it('throws naming the missing variable', () => {
    const { META_ACCESS_TOKEN, ...missing } = valid;
    void META_ACCESS_TOKEN;
    expect(() => loadConfig(missing)).toThrow(/META_ACCESS_TOKEN/);
  });

  it('rejects a non-numeric COD_FEE_INR', () => {
    expect(() => loadConfig({ ...valid, COD_FEE_INR: 'fifty' })).toThrow(/COD_FEE_INR/);
  });
});
