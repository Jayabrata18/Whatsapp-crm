import { round2 } from './gst.js';

/**
 * Splits `total` across `weights` pro rata, rounded to paise, with the last slice
 * carrying a non-zero weight absorbing the remainder so the parts sum to `total`
 * exactly — the same "last slice takes the drift" rule `computeGst` uses to
 * apportion shipping across rates.
 *
 * Discounts arrive as one figure for a whole order in two places (Shopify's
 * order-level `total_discounts`, and the hub's own early-payment COD-fee waiver),
 * and both have to land on individual lines before a per-piece GST slab can be
 * decided: the ₹2,500 threshold is tested against what the customer actually paid
 * for one piece, not against a pre-discount list price.
 *
 * A zero or negative weight gets nothing — it has no price to discount.
 */
export function apportion(weights: number[], total: number): number[] {
  const safe = weights.map((weight) => (Number.isFinite(weight) && weight > 0 ? weight : 0));
  const sum = safe.reduce((running, weight) => running + weight, 0);
  if (sum <= 0 || !Number.isFinite(total) || total <= 0) return weights.map(() => 0);

  const lastWeighted = safe.reduce((last, weight, index) => (weight > 0 ? index : last), -1);

  let allocated = 0;
  return safe.map((weight, index) => {
    if (weight === 0) return 0;
    if (index === lastWeighted) return round2(total - allocated);
    const slice = round2((total * weight) / sum);
    allocated = round2(allocated + slice);
    return slice;
  });
}
