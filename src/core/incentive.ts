export interface Pricing {
  /** What the customer pays on the early-payment link, in whole rupees. */
  payable: number;
  /** The COD fee actually waived. Zero when no waiver applies. */
  codFee: number;
}

/**
 * The one incentive rule: pay online now, skip the COD fee.
 *
 * The `amount <= codFeeInr` guard matters — a payment link for zero or a
 * negative amount is rejected by Cashfree and would strand the order in
 * CONFIRMED with no link. On a tiny order the customer simply pays full price,
 * which is the correct commercial answer anyway.
 */
export function computePricing(amount: number, isCod: boolean, codFeeInr: number): Pricing {
  if (!isCod || codFeeInr <= 0 || amount <= codFeeInr) {
    return { payable: amount, codFee: 0 };
  }
  return { payable: amount - codFeeInr, codFee: codFeeInr };
}
