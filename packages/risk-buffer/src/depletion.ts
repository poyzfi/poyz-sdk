/**
 * Buffer depletion: how long the buffer lasts under a stated negative-funding
 * regime.
 *
 * The formula is `risk-spec.md` 1.2, and nothing here is more than that formula
 * plus its guards:
 *
 * ```
 * carry per hour = f_h * H
 * carry per day  = f_h * 24 * H                 (funding settles hourly)
 * annualized     = f_h * 24 * 365.25 * H        (simple; _DIRECTION.md 8-1)
 * runway (days)  = B / (|f_h| * 24 * H) = b / f_d
 * ```
 *
 * Note which line the year length touches. Only the annualized figure moves with
 * `DAYS_PER_YEAR`; the runway is a daily-basis division and is the same number
 * on a 365-day and a 365.25-day year.
 *
 * A runway is not a safety margin. `risk-spec.md` 1.3 is explicit that no buffer
 * outlasts an indefinite negative regime; the buffer buys time to deleverage and
 * the playbook has to start acting long before it empties. On the measured venue
 * data the negative regime is the current one, not a stress case
 * (`scenarios.ts`, `_DIRECTION.md` 8-1).
 */

import {
  DEFAULT_BUFFER_TARGET_BPS,
  coverageFractionOfTarget,
  coverageRatio,
  type BufferState,
} from "./accounting.js";
import { selectBufferStage, type BufferStage, type PlaybookThresholds } from "./playbook.js";
import {
  DAYS_PER_YEAR,
  MS_PER_DAY,
  assertFinite,
  assertFiniteNonNegative,
  bpsToFraction,
  hourlyToAnnualRate,
  hourlyToDailyRate,
} from "./units.js";

/**
 * A funding regime to project the buffer against.
 *
 * This is an input scenario supplied by the caller, not a forecast produced by
 * this package. Feed it observed rates, a stress rate, or both, and compare.
 */
export interface NegativeFundingScenario {
  /**
   * Annualized funding rate accruing to the short side, as a decimal.
   * Negative means the protocol pays. `-0.15` is 15 percent per year paid out.
   */
  readonly annualizedFundingRate: number;
  /** Hedge notional exposed to that rate, in USD. */
  readonly hedgedNotionalUsd: number;
  /** Fixed operating drain per day, in USD, >= 0. */
  readonly dailyOperatingCostUsd: number;
}

export interface BufferProjection {
  /** Signed daily flow, USD. Positive grows the buffer, negative drains it. */
  readonly dailyNetFlowUsd: number;
  /** Daily outflow, USD, >= 0. Zero when the buffer is not draining. */
  readonly dailyDrainUsd: number;
  /** Days until the balance reaches zero. `null` when it is not draining. */
  readonly daysToDepletion: number | null;
  /** Unix milliseconds of depletion. `null` when it is not draining. */
  readonly depletesAtMs: number | null;
  /** Buffer balance as a share of covered supply at the time of projection. */
  readonly coverageRatio: number;
}

/**
 * Project the buffer forward under one funding scenario.
 *
 * The projection assumes the scenario holds flat for its whole duration, which
 * real funding does not do. It answers a bounded question: at this rate, for how
 * long. Treat the output as a stress measurement, not a prediction, and re-run it
 * whenever the observed rate moves.
 *
 * @param nowMs Unix milliseconds the projection starts from.
 * @throws RangeError on a malformed state or scenario.
 */
export function projectBufferDepletion(
  state: BufferState,
  scenario: NegativeFundingScenario,
  nowMs: number,
): BufferProjection {
  assertFiniteNonNegative(state.balanceUsd, "balanceUsd");
  assertFinite(scenario.annualizedFundingRate, "annualizedFundingRate");
  assertFiniteNonNegative(scenario.hedgedNotionalUsd, "hedgedNotionalUsd");
  assertFiniteNonNegative(scenario.dailyOperatingCostUsd, "dailyOperatingCostUsd");
  assertFinite(nowMs, "nowMs");

  const dailyFundingUsd =
    (scenario.annualizedFundingRate * scenario.hedgedNotionalUsd) / DAYS_PER_YEAR;
  const dailyNetFlowUsd = dailyFundingUsd - scenario.dailyOperatingCostUsd;
  const dailyDrainUsd = dailyNetFlowUsd < 0 ? -dailyNetFlowUsd : 0;

  const daysToDepletion = dailyDrainUsd > 0 ? state.balanceUsd / dailyDrainUsd : null;
  const depletesAtMs = daysToDepletion === null ? null : nowMs + daysToDepletion * MS_PER_DAY;

  return {
    dailyNetFlowUsd,
    dailyDrainUsd,
    daysToDepletion,
    depletesAtMs,
    coverageRatio: coverageRatio(state),
  };
}

/**
 * Buffer contribution needed to hold a target runway under a scenario.
 *
 * Returns 0 when the buffer is not draining or already has the runway.
 *
 * @throws RangeError when `targetDays` is not a finite value greater than zero.
 */
export function requiredTopUpUsd(
  state: BufferState,
  projection: BufferProjection,
  targetDays: number,
): number {
  if (!Number.isFinite(targetDays) || targetDays <= 0) {
    throw new RangeError("targetDays must be a finite number greater than zero");
  }
  if (projection.dailyDrainUsd <= 0) {
    return 0;
  }
  const requiredBalanceUsd = projection.dailyDrainUsd * targetDays;
  return Math.max(0, requiredBalanceUsd - state.balanceUsd);
}

/**
 * Input to {@link estimateBufferDepletion}.
 *
 * Rates are hourly because that is the interval funding settles on
 * (`risk-spec.md` 1.2). Passing an 8-hour or annual figure here without
 * converting it is the interval mistake `units.ts` documents; use
 * `perEightHourToHourlyRate` or `annualToHourlyRate` first.
 */
export interface BufferDepletionInput {
  /** Buffer balance in USD, >= 0. */
  readonly bufferBalanceUsd: number;
  /** Supply the buffer stands behind, in USD. */
  readonly supplyUsd: number;
  /**
   * Hourly funding rate accruing to the short, as a signed decimal. Negative
   * means the protocol pays. `null` when there is no funding observation, which
   * produces an insufficient-data result rather than a fabricated one.
   */
  readonly hourlyFundingRate: number | null;
  /** Hedge notional in USD. Defaults to `supplyUsd`, the full hedge `H ~= S`. */
  readonly hedgeNotionalUsd?: number;
  /** Non-funding drain per day in USD, >= 0. Defaults to 0. */
  readonly dailyOperatingCostUsd?: number;
  /** Target buffer as basis points of supply. Defaults to 300 (`risk-spec.md` 6). */
  readonly bufferTargetBps?: number;
  /**
   * Unix milliseconds this estimate is anchored to, used only to date
   * `depletesAtMs`. Supplied by the caller because this function is pure and
   * does not read the clock.
   */
  readonly asOfMs?: number;
  /** Stage triggers. Defaults to the `risk-spec.md` 1.5 values. */
  readonly thresholds?: PlaybookThresholds;
}

/**
 * Result of {@link estimateBufferDepletion}.
 *
 * Every numeric field is `null` when it cannot be computed from the input. There
 * is no fallback number anywhere in this type: a caller that gets `null` must
 * render nothing for that field.
 */
export interface BufferDepletionEstimate {
  /** Always true. These are projections under stated assumptions, never measurements. */
  readonly isEstimate: true;
  /** True when the input did not support a runway figure. */
  readonly insufficientData: boolean;
  /** Why the data was insufficient, or `null` when it was not. */
  readonly insufficientDataReason: string | null;
  /** True when the regime drains the buffer. False means there is nothing to run out of. */
  readonly isDraining: boolean;
  /** `f_d = |f_h| * 24`, the daily cost as a fraction of hedge notional. `0` when not draining. */
  readonly dailyCostFraction: number | null;
  /** Daily funding cost in USD, >= 0. `0` when not draining. */
  readonly dailyFundingCostUsd: number | null;
  /** Signed daily flow through the buffer in USD, funding minus operating cost. */
  readonly dailyNetFlowUsd: number | null;
  /** `f_h * 8766`, the simple annual rate. Signed, and negative in the current regime. */
  readonly annualizedFundingRate: number | null;
  /** `b = B / S`, the buffer as a fraction of supply. */
  readonly bufferFraction: number | null;
  /** Buffer balance as a fraction of its target, the `risk-spec.md` 1.5 trigger quantity. */
  readonly coverageFractionOfTarget: number | null;
  /** `b / f_d`, the runway in days. `null` when the buffer is not draining. */
  readonly runwayDays: number | null;
  /** Unix milliseconds the buffer empties. `null` without `asOfMs` or without a runway. */
  readonly depletesAtMs: number | null;
  /** Stage implied by coverage against target. `null` when coverage cannot be computed. */
  readonly stage: BufferStage | null;
  /** The assumptions this estimate stands on. Never empty. Safe to render verbatim. */
  readonly assumptions: readonly string[];
}

const BASE_ASSUMPTIONS: readonly string[] = [
  "Funding settles hourly, so a day is 24 intervals and a year is 24 * 365.25 = 8766 hours (_DIRECTION 8-1).",
  "Annualization is simple, not compounded; the carry is not assumed to be reinvested into the hedge.",
  "The funding rate is assumed to hold flat for the whole window. Real funding does not hold flat, and a regime that deepens shortens the runway.",
  "The buffer is assumed to be the sole first-loss layer and no new mint arrives to dilute or refill it (risk-spec 1.3).",
  "Venue failure, auto-deleverage, oracle deviation and liquidation of the hedge leg are separate hazards that this runway does not cover; see risk-spec 2 and 3.",
];

const HEDGE_EQUALS_SUPPLY_ASSUMPTION =
  "Hedge notional is assumed equal to supply (H ~= S) because no hedge notional was supplied.";

/**
 * Estimate how long the buffer covers a negative-funding regime.
 *
 * Pure. It reads no clock, no network and no file; `asOfMs` is an input for
 * exactly that reason.
 *
 * Reproduces the `risk-spec.md` 1.3 stress table: with `b = 1.7%` of supply and
 * `f_d = 0.030%` per day, `runwayDays` is `0.017 / 0.0003 = 56.67`. At the
 * measured 1-year regime (`f_h = -0.004086%/hr`, `f_d = 0.098064%/day`) a 3%
 * buffer gives `0.03 / 0.00098064 = 30.59` days.
 *
 * When `hourlyFundingRate` is `null`, or when the regime does not drain the
 * buffer, the runway is `null` rather than infinite. There is no number to show
 * and showing one would be an invention.
 */
export function estimateBufferDepletion(input: BufferDepletionInput): BufferDepletionEstimate {
  assertFiniteNonNegative(input.bufferBalanceUsd, "bufferBalanceUsd");
  assertFiniteNonNegative(input.supplyUsd, "supplyUsd");

  const hedgeNotionalUsd = input.hedgeNotionalUsd ?? input.supplyUsd;
  assertFiniteNonNegative(hedgeNotionalUsd, "hedgeNotionalUsd");
  const dailyOperatingCostUsd = input.dailyOperatingCostUsd ?? 0;
  assertFiniteNonNegative(dailyOperatingCostUsd, "dailyOperatingCostUsd");
  const bufferTargetBps = input.bufferTargetBps ?? DEFAULT_BUFFER_TARGET_BPS;
  assertFiniteNonNegative(bufferTargetBps, "bufferTargetBps");
  if (input.asOfMs !== undefined) {
    assertFinite(input.asOfMs, "asOfMs");
  }

  const assumptions = [...BASE_ASSUMPTIONS];
  if (input.hedgeNotionalUsd === undefined) {
    assumptions.unshift(HEDGE_EQUALS_SUPPLY_ASSUMPTION);
  }
  if (dailyOperatingCostUsd > 0) {
    assumptions.push(
      "A fixed non-funding operating drain is included and is assumed constant per day.",
    );
  }

  const state: BufferState = {
    balanceUsd: input.bufferBalanceUsd,
    coveredSupplyUsd: input.supplyUsd,
    targetCoverageRatio: bpsToFraction(bufferTargetBps),
  };
  const fractionOfTarget = coverageFractionOfTarget(state);
  const stage =
    fractionOfTarget === null ? null : selectBufferStage(fractionOfTarget, input.thresholds);

  if (input.hourlyFundingRate === null) {
    return {
      isEstimate: true,
      insufficientData: true,
      insufficientDataReason:
        "No funding rate observation was supplied, so there is no drain rate and no runway to report.",
      isDraining: false,
      dailyCostFraction: null,
      dailyFundingCostUsd: null,
      dailyNetFlowUsd: null,
      annualizedFundingRate: null,
      bufferFraction: input.supplyUsd > 0 ? input.bufferBalanceUsd / input.supplyUsd : null,
      coverageFractionOfTarget: fractionOfTarget,
      runwayDays: null,
      depletesAtMs: null,
      stage,
      assumptions,
    };
  }

  assertFinite(input.hourlyFundingRate, "hourlyFundingRate");
  const annualizedFundingRate = hourlyToAnnualRate(input.hourlyFundingRate);
  const dailyRate = hourlyToDailyRate(input.hourlyFundingRate);
  const dailyFundingUsd = dailyRate * hedgeNotionalUsd;
  const dailyNetFlowUsd = dailyFundingUsd - dailyOperatingCostUsd;
  const dailyDrainUsd = dailyNetFlowUsd < 0 ? -dailyNetFlowUsd : 0;
  const isDraining = dailyDrainUsd > 0;

  const bufferFraction = input.supplyUsd > 0 ? input.bufferBalanceUsd / input.supplyUsd : null;

  // Runway is computed from the USD drain rather than from `b / f_d` so that a
  // fixed operating cost and a hedge notional other than supply are honoured.
  // With `dailyOperatingCostUsd = 0` and `H = S` the two are identical, which is
  // what the risk-spec 1.3 stress-table reproduction test asserts. Both paths are
  // daily-basis, so neither depends on DAYS_PER_YEAR.
  const runwayDays = isDraining ? input.bufferBalanceUsd / dailyDrainUsd : null;
  const depletesAtMs =
    runwayDays === null || input.asOfMs === undefined
      ? null
      : input.asOfMs + runwayDays * MS_PER_DAY;

  return {
    isEstimate: true,
    insufficientData: false,
    insufficientDataReason: null,
    isDraining,
    dailyCostFraction: hedgeNotionalUsd > 0 ? dailyDrainUsd / hedgeNotionalUsd : 0,
    dailyFundingCostUsd: dailyDrainUsd,
    dailyNetFlowUsd,
    annualizedFundingRate,
    bufferFraction,
    coverageFractionOfTarget: fractionOfTarget,
    runwayDays,
    depletesAtMs,
    stage,
    assumptions,
  };
}
