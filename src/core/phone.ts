const INDIAN_MOBILE = /^[6-9]\d{9}$/;

/**
 * Any real-world Indian phone shape -> `91XXXXXXXXXX`, or null when it cannot
 * be a valid Indian mobile number. Landlines and foreign numbers are rejected:
 * sending a template to one costs money and hurts the number's quality rating.
 */
export function normalizeIndianPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return null;

  // Strip an international dialling prefix: 0091... or 00...
  if (digits.startsWith('00')) digits = digits.slice(2);

  if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  if (!INDIAN_MOBILE.test(digits)) return null;
  return `91${digits}`;
}
