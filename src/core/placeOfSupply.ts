/**
 * ISO 3166-2:IN subdivision code → GST state code. Shopify sends the ISO code in
 * `shipping_address.province_code`, which is far more reliable than the free-text
 * `province` field.
 *
 * Four states are carried under both spellings. The ISO codes are `UT`, `OR`, `CT`
 * and `TG`, but Shopify's own province list for India has been seen using the common
 * Indian-postal abbreviations `UK`, `OD`, `CG` and `TS` instead. Which one arrives is
 * not something this codebase controls, and the cost of being wrong is not a blank
 * field — `stateCodeFor` would return null, the order would be flagged unresolved, and
 * an entire state's orders would stop invoicing. Accepting both spellings is a two-line
 * insurance policy against that.
 */
export const STATE_CODES: Record<string, string> = {
  JK: '01', HP: '02', PB: '03', CH: '04', HR: '06', DL: '07',
  RJ: '08', UP: '09', BR: '10', SK: '11', AR: '12', NL: '13', MN: '14',
  MZ: '15', TR: '16', ML: '17', AS: '18', WB: '19', JH: '20',
  MP: '23', GJ: '24', DH: '26', MH: '27', KA: '29', GA: '30',
  LD: '31', KL: '32', TN: '33', AN: '35', PY: '34', AP: '37',
  LA: '38',
  // Uttarakhand, Odisha, Chhattisgarh, Telangana — ISO code first, Shopify's alternate second.
  UT: '05', UK: '05',
  OR: '21', OD: '21',
  CT: '22', CG: '22',
  TG: '36', TS: '36',
};

export function stateCodeFor(provinceCode: string | null | undefined): string | null {
  if (!provinceCode) return null;
  return STATE_CODES[provinceCode.trim().toUpperCase()] ?? null;
}

export function isInterState(posCode: string, sellerStateCode: string): boolean {
  return posCode !== sellerStateCode;
}
