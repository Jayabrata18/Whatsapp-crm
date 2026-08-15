import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyShopifyHmac,
  verifyMetaSignature,
  verifyCashfreeSignature,
} from '../../src/core/signatures.js';

const body = Buffer.from('{"id":123,"name":"#1042"}');
const secret = 'shhh';

describe('verifyShopifyHmac', () => {
  const valid = createHmac('sha256', secret).update(body).digest('base64');

  it('accepts a correct base64 signature', () => {
    expect(verifyShopifyHmac(body, valid, secret)).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifyShopifyHmac(Buffer.from('{"id":999}'), valid, secret)).toBe(false);
  });

  it('rejects the wrong secret', () => {
    expect(verifyShopifyHmac(body, valid, 'wrong')).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyShopifyHmac(body, undefined, secret)).toBe(false);
  });

  it('rejects a truncated signature without throwing', () => {
    expect(verifyShopifyHmac(body, valid.slice(0, 10), secret)).toBe(false);
  });
});

describe('verifyMetaSignature', () => {
  const digest = createHmac('sha256', secret).update(body).digest('hex');
  const valid = `sha256=${digest}`;

  it('accepts a correct sha256= prefixed signature', () => {
    expect(verifyMetaSignature(body, valid, secret)).toBe(true);
  });

  it('rejects a signature missing the sha256= prefix', () => {
    expect(verifyMetaSignature(body, digest, secret)).toBe(false);
  });

  it('rejects a tampered body', () => {
    expect(verifyMetaSignature(Buffer.from('{"id":999}'), valid, secret)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyMetaSignature(body, undefined, secret)).toBe(false);
  });
});

describe('verifyCashfreeSignature', () => {
  const timestamp = '1755300000';
  const valid = createHmac('sha256', secret)
    .update(timestamp + body.toString('utf8'))
    .digest('base64');

  it('accepts a correct timestamp+body signature', () => {
    expect(verifyCashfreeSignature(body, valid, timestamp, secret)).toBe(true);
  });

  it('rejects a different timestamp', () => {
    expect(verifyCashfreeSignature(body, valid, '1755399999', secret)).toBe(false);
  });

  it('rejects a missing timestamp', () => {
    expect(verifyCashfreeSignature(body, valid, undefined, secret)).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(verifyCashfreeSignature(body, undefined, timestamp, secret)).toBe(false);
  });
});
