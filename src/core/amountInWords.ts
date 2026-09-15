const UNITS = [
  'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];

const TENS = [
  '', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety',
];

/** Renders 0-99 in words. */
function twoDigits(n: number): string {
  if (n < 20) return UNITS[n] as string;
  const tens = TENS[Math.floor(n / 10)] as string;
  const rest = n % 10;
  return rest === 0 ? tens : `${tens} ${UNITS[rest] as string}`;
}

/** Renders 0-999 in words. */
function threeDigits(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds > 0) parts.push(`${UNITS[hundreds] as string} Hundred`);
  if (rest > 0) parts.push(twoDigits(rest));
  return parts.join(' ');
}

/**
 * Renders a non-negative integer number of rupees in words using the Indian
 * numbering system (crore / lakh / thousand / hundred), not the Western one
 * (million / billion). Grouping from the right: 2, 2, 2, 3 digits — so
 * 12345678 splits as 1,23,45,678 → "One Crore Twenty Three Lakh Forty Five
 * Thousand Six Hundred Seventy Eight".
 */
function integerRupeesInWords(n: number): string {
  if (n === 0) return 'Zero';

  const crore = Math.floor(n / 1_00_00_000);
  const afterCrore = n % 1_00_00_000;
  const lakh = Math.floor(afterCrore / 1_00_000);
  const afterLakh = afterCrore % 1_00_000;
  const thousand = Math.floor(afterLakh / 1_000);
  const hundreds = afterLakh % 1_000;

  const parts: string[] = [];
  if (crore > 0) parts.push(`${threeDigits(crore)} Crore`);
  if (lakh > 0) parts.push(`${threeDigits(lakh)} Lakh`);
  if (thousand > 0) parts.push(`${threeDigits(thousand)} Thousand`);
  if (hundreds > 0) parts.push(threeDigits(hundreds));

  return parts.join(' ');
}

/**
 * Renders an INR amount in words for a GST tax invoice, using Indian
 * numbering (lakh/crore) and stating paise separately when present, e.g.
 * "One Thousand Eight Hundred Ninety Nine Rupees and Fifty Paise Only".
 */
export function rupeesInWords(amount: number): string {
  const rounded = Math.round(amount * 100);
  const rupees = Math.floor(rounded / 100);
  const paise = rounded % 100;

  const rupeesWords = `${integerRupeesInWords(rupees)} Rupees`;
  if (paise === 0) return `${rupeesWords} Only`;

  return `${rupeesWords} and ${integerRupeesInWords(paise)} Paise Only`;
}
