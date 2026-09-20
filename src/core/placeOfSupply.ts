/**
 * ISO 3166-2:IN subdivision code → GST state code. Shopify sends the ISO code in
 * `shipping_address.province_code`, which is far more reliable than the free-text
 * `province` field.
 */
export const STATE_CODES: Record<string, string> = {
  JK: '01', HP: '02', PB: '03', CH: '04', UT: '05', HR: '06', DL: '07',
  RJ: '08', UP: '09', BR: '10', SK: '11', AR: '12', NL: '13', MN: '14',
  MZ: '15', TR: '16', ML: '17', AS: '18', WB: '19', JH: '20', OR: '21',
  CT: '22', MP: '23', GJ: '24', DH: '26', MH: '27', KA: '29', GA: '30',
  LD: '31', KL: '32', TN: '33', TG: '36', AN: '35', PY: '34', AP: '37',
  LA: '38',
};

export function stateCodeFor(provinceCode: string | null | undefined): string | null {
  if (!provinceCode) return null;
  return STATE_CODES[provinceCode.trim().toUpperCase()] ?? null;
}

export function isInterState(posCode: string, sellerStateCode: string): boolean {
  return posCode !== sellerStateCode;
}
