export interface GstRates { thresholdInr: number; low: number; high: number; }
export interface GstLine { inclUnitPrice: number; quantity: number; }
export interface TaxPart { rate: number; taxable: number; tax: number; }
export interface GstBreakdown {
  goods: TaxPart[];
  shipping: TaxPart[];
  taxableTotal: number;
  taxTotal: number;
  roundOff: number;
  total: number;
}
export interface TaxSplit { cgst: number; sgst: number; igst: number; }

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function rateFor(inclUnitPrice: number, rates: GstRates): number {
  return inclUnitPrice <= rates.thresholdInr ? rates.low : rates.high;
}

function backOutTax(incl: number, rate: number): TaxPart {
  const taxable = round2(incl / (1 + rate / 100));
  return { rate, taxable, tax: round2(incl - taxable) };
}

export function computeGst(
  lines: GstLine[], shippingIncl: number, amountCharged: number, rates: GstRates,
): GstBreakdown {
  // Group by rate first so an order with three 5% items produces one 5% part.
  const inclByRate = new Map<number, number>();
  for (const line of lines) {
    const rate = rateFor(line.inclUnitPrice, rates);
    inclByRate.set(rate, (inclByRate.get(rate) ?? 0) + line.inclUnitPrice * line.quantity);
  }

  const goods = [...inclByRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, incl]) => backOutTax(incl, rate));

  // Shipping is a composite supply: it takes the principal supply's rate, and a
  // mixed-rate order apportions it pro-rata by taxable value.
  const goodsTaxable = goods.reduce((sum, p) => sum + p.taxable, 0);
  let shipping: TaxPart[] = [];
  if (shippingIncl > 0 && goods.length > 0) {
    let allocated = 0;
    shipping = goods.map((part, i) => {
      const isLast = i === goods.length - 1;
      // The last slice absorbs the rounding remainder so the parts sum to the charge.
      const slice = isLast
        ? round2(shippingIncl - allocated)
        : round2((shippingIncl * part.taxable) / goodsTaxable);
      allocated = round2(allocated + slice);
      return backOutTax(slice, part.rate);
    });
  }

  const parts = [...goods, ...shipping];
  const taxableTotal = round2(parts.reduce((s, p) => s + p.taxable, 0));
  const taxTotal = round2(parts.reduce((s, p) => s + p.tax, 0));

  // Per-line rounding guarantees drift. The round-off line makes the invoice total
  // equal the amount charged exactly — a ₹0.01 gap is a real reconciliation problem.
  const roundOff = round2(amountCharged - taxableTotal - taxTotal);

  return { goods, shipping, taxableTotal, taxTotal, roundOff, total: round2(amountCharged) };
}

export function splitTax(tax: number, interState: boolean): TaxSplit {
  if (interState) return { cgst: 0, sgst: 0, igst: round2(tax) };
  const cgst = round2(tax / 2);
  // The remainder, not a second rounding — halving an odd paisa must not lose it.
  return { cgst, sgst: round2(tax - cgst), igst: 0 };
}
