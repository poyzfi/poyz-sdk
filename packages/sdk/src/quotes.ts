/**
 * Quote arithmetic.
 *
 * Pure functions with no network access, so a UI can quote a mint or a
 * redemption while the wallet is still disconnected. These mirror the fee and
 * haircut model the program applies; they are a preview, and the value that
 * settles is whatever the program computes at the oracle price of that slot.
 */

const BPS_PER_UNIT = 10_000;
const HOURS_PER_YEAR = 365 * 24;

/** A collateral asset POYZ accepts. */
export interface CollateralAsset {
  /** Ticker used in logs and UI, for example "SOL". */
  readonly symbol: string;
  /** SPL mint address, base58. Native SOL uses the wrapped SOL mint. */
  readonly mint: string;
  readonly decimals: number;
  /**
   * Valuation haircut applied to the oracle price, in basis points.
   *
   * An LST that can trade below its redemption value is credited for less than
   * its mark, so the position is not issued against a price it cannot exit at.
   */
  readonly haircutBps: number;
}

export interface MintQuoteInput {
  readonly asset: CollateralAsset;
  /** Collateral deposited, in whole token units. */
  readonly collateralAmount: number;
  /** Oracle price of one whole token, in USD. */
  readonly collateralPriceUsd: number;
  /** Issuance fee, in basis points of the haircut collateral value. */
  readonly mintFeeBps: number;
}

export interface MintQuote {
  readonly collateralValueUsd: number;
  readonly haircutUsd: number;
  readonly feeUsd: number;
  /** Synthetic dollars issued, in USD. */
  readonly syntheticDollarsOut: number;
  /** Total cost as a share of the marked collateral value, 0..1. */
  readonly totalCostRatio: number;
}

export interface RedeemQuoteInput {
  readonly asset: CollateralAsset;
  /** Synthetic dollars burned, in USD. */
  readonly syntheticDollarsIn: number;
  readonly collateralPriceUsd: number;
  /** Redemption fee, in basis points. */
  readonly redeemFeeBps: number;
}

export interface RedeemQuote {
  readonly grossValueUsd: number;
  readonly feeUsd: number;
  readonly netValueUsd: number;
  /** Collateral returned, in whole token units. */
  readonly collateralOut: number;
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite number greater than or equal to zero`);
  }
}

function assertBps(value: number, label: string): void {
  assertFiniteNonNegative(value, label);
  if (value > BPS_PER_UNIT) {
    throw new RangeError(`${label} must not exceed 10000`);
  }
}

function assertPositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a finite number greater than zero`);
  }
}

/**
 * Convert a funding rate quoted per interval into an annualized decimal.
 *
 * Simple annualization, not compounded: funding is settled and swept rather
 * than reinvested into the same position, so compounding would overstate it.
 *
 * @param ratePerInterval Signed rate for one funding interval, as a decimal.
 * @param intervalHours Length of that interval in hours, for example 1 or 8.
 * @throws RangeError on a malformed input.
 */
export function annualizeFundingRate(ratePerInterval: number, intervalHours: number): number {
  if (!Number.isFinite(ratePerInterval)) {
    throw new RangeError("ratePerInterval must be a finite number");
  }
  assertPositive(intervalHours, "intervalHours");
  return ratePerInterval * (HOURS_PER_YEAR / intervalHours);
}

/**
 * Quote a mint.
 *
 * The collateral is marked at the oracle price, reduced by the asset haircut,
 * then charged the issuance fee. What is left is issued as synthetic dollars.
 *
 * @throws RangeError on a malformed input.
 */
export function quoteMint(input: MintQuoteInput): MintQuote {
  assertFiniteNonNegative(input.collateralAmount, "collateralAmount");
  assertPositive(input.collateralPriceUsd, "collateralPriceUsd");
  assertBps(input.asset.haircutBps, "haircutBps");
  assertBps(input.mintFeeBps, "mintFeeBps");

  const collateralValueUsd = input.collateralAmount * input.collateralPriceUsd;
  const haircutUsd = (collateralValueUsd * input.asset.haircutBps) / BPS_PER_UNIT;
  const netCollateralUsd = collateralValueUsd - haircutUsd;
  const feeUsd = (netCollateralUsd * input.mintFeeBps) / BPS_PER_UNIT;
  const syntheticDollarsOut = netCollateralUsd - feeUsd;

  return {
    collateralValueUsd,
    haircutUsd,
    feeUsd,
    syntheticDollarsOut,
    totalCostRatio: collateralValueUsd > 0 ? (haircutUsd + feeUsd) / collateralValueUsd : 0,
  };
}

/**
 * Quote a redemption.
 *
 * Synthetic dollars burn one for one against USD of collateral value, the
 * redemption fee is taken, and the remainder is returned in collateral at the
 * oracle price. No haircut on the way out; it was charged at issuance.
 *
 * @throws RangeError on a malformed input.
 */
export function quoteRedeem(input: RedeemQuoteInput): RedeemQuote {
  assertFiniteNonNegative(input.syntheticDollarsIn, "syntheticDollarsIn");
  assertPositive(input.collateralPriceUsd, "collateralPriceUsd");
  assertBps(input.redeemFeeBps, "redeemFeeBps");

  const grossValueUsd = input.syntheticDollarsIn;
  const feeUsd = (grossValueUsd * input.redeemFeeBps) / BPS_PER_UNIT;
  const netValueUsd = grossValueUsd - feeUsd;

  return {
    grossValueUsd,
    feeUsd,
    netValueUsd,
    collateralOut: netValueUsd / input.collateralPriceUsd,
  };
}
