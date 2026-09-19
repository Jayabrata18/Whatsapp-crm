import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * `timingSafeEqual` throws when the buffers differ in length, which is both a
 * length oracle and a crash risk on malformed input. Length is checked first
 * and returns false rather than throwing.
 *
 * Exported so any bearer-token style comparison (the Shadowfax webhook token,
 * the internal scheduler task token) reuses the same constant-time compare as
 * the Meta/Shopify/Cashfree signature checks below, rather than each call site
 * growing its own copy of this exact same length-check-then-timingSafeEqual shape.
 */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function verifyShopifyHmac(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
  return safeCompare(header, expected);
}

export function verifyMetaSignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeCompare(header.slice('sha256='.length), expected);
}

export function verifyCashfreeSignature(
  rawBody: Buffer,
  header: string | undefined,
  timestamp: string | undefined,
  secret: string,
): boolean {
  if (!header || !timestamp) return false;
  const expected = createHmac('sha256', secret)
    .update(timestamp + rawBody.toString('utf8'))
    .digest('base64');
  return safeCompare(header, expected);
}
