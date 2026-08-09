/**
 * Carry wipeout: when the carry passed through to stakers reaches zero.
 *
 * The names in this module say "yield" because callers were written against
 * them and the exports are stable. Read "yield" as **the positive half of net
 * carry** and nothing more. Carry is signed, it is negative on three of the four
 * measured venue windows (`scenarios.ts`, `_DIRECTION.md` 8-1), and this module
 * exists precisely because the negative case is the one that has to be dated.
 *
 * The staker-side zero is a **different event from buffer depletion** and the
 * two are routinely confused. `risk-spec.md` 1.5 orders them:
 *
 * 1. **Staker carry reaches zero.** Carry turns negative, the staker reward
 *    index floors at zero, and the buffer covers the bleed. Stakers stop
 *    receiving. They have not lost principal.
 * 2. **Buffer depletion.** The buffer runs out, `b / f_d` days later. Only then
 *    does staker NAV decline, which is the `backing_only` stage.
 *
 * So the pass-through goes first and the backing goes second, and a caller that
 * reports only one of them is telling half the story. This module returns both
 * and says which arrives first.
 *
 * A note on what the staker-side zero means when there is a cushion. If carry
 * already accrued to stakers has not yet been distributed, a negative regime
 * eats that accrual before the index reaches zero. `daysToStakerYieldZero`
 * measures that window. With no accrued cushion the answer is zero days: there
 * is nothing left to pass through the moment carry turns negative.
 */

import {
  DAYS_PER_YEAR,
  MS_PER_DAY,
  assertFinite,
  assertFiniteNonNegative,
  hourlyToAnnualRate,
  hourlyToDailyRate,
} from "./units.js";

export interface YieldWipeoutInput {
  /**
   * Hourly funding rate accruing to the short, as a signed decimal. Negative
   * means the protocol pays. `null` when there is no observation, which produces
   * an insufficient-data result rather than a fabricated one.
   */
  readonly hourlyFundingRate: number | null;
  /** Hedge notional the funding rate applies to, in USD. */
  readonly hedgeNotionalUsd: number;
  /** Buffer balance in USD. Used for the buffer-depletion leg of the answer. */
  readonly bufferBalanceUsd: number;
  /**
   * Carry running alongside funding, as a signed simple annual rate on supply:
   * a collateral staking rate, for instance. Defaults to 0. This is the term
   * that can keep net carry positive while funding is negative. It is signed
   * too, and a borrow-fee leg such as Jupiter Perps enters here as a negative
   * number (`hedge-spec.md` 6, `hedge_cost`).
   */
  readonly otherAnnualizedCarryRate?: number;
  /** Supply that `otherAnnualizedCarryRate` applies to. Defaults to `hedgeNotionalUsd`. */
  readonly supplyUsd?: number;
  /**
   * Carry accrued to stakers but not yet distributed, in USD, >= 0. Defaults to
   * 0. This is the cushion a negative regime consumes before the reward index
   * reaches zero.
   */
  readonly accruedStakerCarryUsd?: number;
  /** Unix milliseconds this estimate is anchored to. Supplied because this function is pure. */
  readonly asOfMs?: number;
}

/** Which of the two events a regime reaches first. */
export type WipeoutEvent = "staker_yield_zero" | "buffer_depletion" | "simultaneous";

export interface YieldWipeoutEstimate {
  /** Always true. These are projections under stated assumptions, never measurements. */
  readonly isEstimate: true;
  /** True when the input did not support the estimate. */
  readonly insufficientData: boolean;
  /** Why the data was insufficient, or `null` when it was not. */
  readonly insufficientDataReason: string | null;
  /** True when net carry to stakers is negative under this regime. */
  readonly isNegativeCarry: boolean;
  /** Signed net carry per day in USD: funding plus other carry. */
  readonly dailyNetCarryUsd: number | null;
  /** Signed net carry as a simple annual rate on supply. */
  readonly annualizedNetCarryRate: number | null;
  /** Signed funding component as a simple annual rate. */
  readonly annualizedFundingRate: number | null;
  /**
   * Days until the accrued staker carry is fully offset and the reward index
   * reaches zero. `0` when there is no accrued cushion and carry is already
   * negative. `null` when carry is not negative, because the event does not
   * occur.
   */
  readonly daysToStakerYieldZero: number | null;
  /**
   * Days until the buffer is exhausted at the same regime, `B / daily drain`.
   * A different event from the line above and normally much later.
   */
  readonly daysToBufferDepletion: number | null;
  /** Unix milliseconds of the staker-yield-zero point, when `asOfMs` was supplied. */
  readonly stakerYieldZeroAtMs: number | null;
  /** Unix milliseconds of buffer depletion, when `asOfMs` was supplied. */
  readonly bufferDepletionAtMs: number | null;
  /** Which event arrives first, or `null` when neither occurs. */
  readonly firstEvent: WipeoutEvent | null;
  /** The assumptions this estimate stands on. Never empty. Safe to render verbatim. */
  readonly assumptions: readonly string[];
}

const WIPEOUT_ASSUMPTIONS: readonly string[] = [
  "Funding settles hourly, so a day is 24 intervals and a year is 24 * 365.25 = 8766 hours (_DIRECTION 8-1).",
  "Annualization is simple, not compounded.",
  "The funding rate is assumed to hold flat for the whole window. Real funding does not hold flat.",
  "Staker carry reaching zero and the buffer emptying are distinct events; the reward index floors at zero while the buffer still covers the bleed (risk-spec 1.5).",
  "The buffer is assumed to be the sole first-loss layer, with no new mint and no fee income arriving to refill it.",
  "Venue failure, auto-deleverage and liquidation of the hedge leg are separate hazards this estimate does not cover; see risk-spec 2 and 3.",
];

const NO_CUSHION_ASSUMPTION =
  "No accrued but undistributed staker carry was supplied, so the reward index is treated as reaching zero immediately once carry turns negative.";

/**
 * Estimate when staker carry reaches zero and, separately, when the buffer runs
 * out.
 *
 * Pure. It reads no clock, no network and no file; `asOfMs` is an input for
 * exactly that reason.
 *
 * Worked example. `hourlyFundingRate = -0.0000125` (-0.00125%/hr, the 2022
 * bear-market average restated hourly), `hedgeNotionalUsd = 100_000_000`,
 * `bufferBalanceUsd = 1_700_000` (1.7% of supply, the Ethena anchor), no other
 * carry and no accrued cushion:
 *
 * ```
 * dailyNetCarryUsd       = -0.0000125 * 24 * 100_000_000 = -30_000
 * annualizedNetCarryRate = -0.0000125 * 24 * 365.25      = -0.109575 (-10.9575%/yr)
 * daysToStakerYieldZero  = 0 / 30_000                    = 0
 * daysToBufferDepletion  = 1_700_000 / 30_000            = 56.67
 * firstEvent             = "staker_yield_zero"
 * ```
 *
 * The runway line has no year length in it and does not move with
 * `DAYS_PER_YEAR`; only the annualized line does.
 */
export function timeToYieldWipeout(input: YieldWipeoutInput): YieldWipeoutEstimate {
  assertFiniteNonNegative(input.hedgeNotionalUsd, "hedgeNotionalUsd");
  assertFiniteNonNegative(input.bufferBalanceUsd, "bufferBalanceUsd");
  const supplyUsd = input.supplyUsd ?? input.hedgeNotionalUsd;
  assertFiniteNonNegative(supplyUsd, "supplyUsd");
  const otherAnnualizedCarryRate = input.otherAnnualizedCarryRate ?? 0;
  assertFinite(otherAnnualizedCarryRate, "otherAnnualizedCarryRate");
  const accruedStakerCarryUsd = input.accruedStakerCarryUsd ?? 0;
  assertFiniteNonNegative(accruedStakerCarryUsd, "accruedStakerCarryUsd");
  if (input.asOfMs !== undefined) {
    assertFinite(input.asOfMs, "asOfMs");
  }

  const assumptions = [...WIPEOUT_ASSUMPTIONS];
  if (accruedStakerCarryUsd === 0) {
    assumptions.push(NO_CUSHION_ASSUMPTION);
  }
  if (input.supplyUsd === undefined) {
    assumptions.push("Supply is assumed equal to hedge notional (H ~= S) because no supply was supplied.");
  }

  if (input.hourlyFundingRate === null) {
    return {
      isEstimate: true,
      insufficientData: true,
      insufficientDataReason:
        "No funding rate observation was supplied, so net carry cannot be computed and neither event can be dated.",
      isNegativeCarry: false,
      dailyNetCarryUsd: null,
      annualizedNetCarryRate: null,
      annualizedFundingRate: null,
      daysToStakerYieldZero: null,
      daysToBufferDepletion: null,
      stakerYieldZeroAtMs: null,
      bufferDepletionAtMs: null,
      firstEvent: null,
      assumptions,
    };
  }

  assertFinite(input.hourlyFundingRate, "hourlyFundingRate");
  const annualizedFundingRate = hourlyToAnnualRate(input.hourlyFundingRate);
  const dailyFundingUsd = hourlyToDailyRate(input.hourlyFundingRate) * input.hedgeNotionalUsd;
  const dailyOtherCarryUsd = (otherAnnualizedCarryRate * supplyUsd) / DAYS_PER_YEAR;
  const dailyNetCarryUsd = dailyFundingUsd + dailyOtherCarryUsd;
  const annualizedNetCarryRate =
    supplyUsd > 0 ? (dailyNetCarryUsd * DAYS_PER_YEAR) / supplyUsd : null;

  const isNegativeCarry = dailyNetCarryUsd < 0;
  const dailyDrainUsd = isNegativeCarry ? -dailyNetCarryUsd : 0;

  const daysToStakerYieldZero = isNegativeCarry ? accruedStakerCarryUsd / dailyDrainUsd : null;
  const daysToBufferDepletion = isNegativeCarry ? input.bufferBalanceUsd / dailyDrainUsd : null;

  const firstEvent = pickFirstEvent(daysToStakerYieldZero, daysToBufferDepletion);

  const asOfMs = input.asOfMs;
  const stakerYieldZeroAtMs =
    asOfMs === undefined || daysToStakerYieldZero === null
      ? null
      : asOfMs + daysToStakerYieldZero * MS_PER_DAY;
  const bufferDepletionAtMs =
    asOfMs === undefined || daysToBufferDepletion === null
      ? null
      : asOfMs + daysToBufferDepletion * MS_PER_DAY;

  return {
    isEstimate: true,
    insufficientData: false,
    insufficientDataReason: null,
    isNegativeCarry,
    dailyNetCarryUsd,
    annualizedNetCarryRate,
    annualizedFundingRate,
    daysToStakerYieldZero,
    daysToBufferDepletion,
    stakerYieldZeroAtMs,
    bufferDepletionAtMs,
    firstEvent,
    assumptions,
  };
}

function pickFirstEvent(
  daysToStakerYieldZero: number | null,
  daysToBufferDepletion: number | null,
): WipeoutEvent | null {
  if (daysToStakerYieldZero === null && daysToBufferDepletion === null) {
    return null;
  }
  if (daysToBufferDepletion === null) {
    return "staker_yield_zero";
  }
  if (daysToStakerYieldZero === null) {
    return "buffer_depletion";
  }
  if (daysToStakerYieldZero < daysToBufferDepletion) {
    return "staker_yield_zero";
  }
  if (daysToBufferDepletion < daysToStakerYieldZero) {
    return "buffer_depletion";
  }
  return "simultaneous";
}
