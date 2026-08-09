/**
 * Stress scenarios and the measured carry regimes, as data.
 *
 * Two families live here and they are not the same kind of thing:
 *
 * - **`MEASURED_CARRY_REGIMES`** are the venue's own published aggregates for
 *   SOL-PERP on 2026-08-09 (`_DIRECTION.md` 8-1). Three of the four windows are
 *   negative. This is the **current regime**, not a scenario, and it is what the
 *   default view should show.
 * - **`FUNDING_STRESS_SCENARIOS`** are the invented columns of the runway table:
 *   round numbers chosen to span a range, useful for reading sensitivity and for
 *   nothing else.
 *
 * The runway table is encoded here rather than restated in prose so a test can
 * hold the code to the published numbers, and so `/simulate` and the risk page
 * render the same table the spec does.
 *
 * Everything here is an **estimate** under the assumptions the spec states: a
 * full hedge (`H ~= S`), the buffer as the sole first-loss layer, no new mint,
 * and a funding rate that holds flat for the whole window. Real regimes do none
 * of those things.
 */

import { bufferRunwayDays, dailyToAnnualRate, hourlyToDailyRate } from "./units.js";

/**
 * Velocity (ex-Drift) Tier-B hourly funding cap, `0.125%/hr` as a decimal
 * (`research-notes.md` 1.3).
 *
 * Note the collision that makes this easy to misread: the cap is 0.125% per
 * **hour**, which is 3.0% per **day**. The `0.125%/day` column of the stress
 * table is a different, far milder scenario that happens to share the digits.
 */
export const TIER_B_HOURLY_FUNDING_CAP = 0.00125;

/** The Tier-B cap expressed as a daily cost fraction: `0.00125 * 24 = 0.03`. */
export const TIER_B_DAILY_FUNDING_CAP = hourlyToDailyRate(TIER_B_HOURLY_FUNDING_CAP);

/**
 * After the November-2022 FTX collapse, BTC perp funding stayed negative for
 * roughly 46 to 50 days before shorts capitulated (Phemex). Used as the "one
 * historical episode" yardstick for reading the runway table.
 *
 * It is a yardstick, not a bound. The measured 1-year SOL-PERP window is already
 * negative (`MEASURED_CARRY_REGIMES`), so the episode length that matters may be
 * longer than any buffer runway in the table.
 */
export const FTX_NEGATIVE_FUNDING_EPISODE_DAYS = { minDays: 46, maxDays: 50 } as const;

/**
 * Bear-market average funding, worse than about `-0.01%` per 8-hour interval
 * over an extended stretch (CryptoRank). Stored per 8h as the source quotes it;
 * convert with `perEightHourToHourlyRate`.
 */
export const BEAR_MARKET_PER_EIGHT_HOUR_RATE = -0.0001;

/**
 * `[ASSUMPTION]` The stress scenarios use BTC/ETH bear-market behaviour as a
 * proxy for SOL, because a primary-source multi-year SOL-PERP funding series was
 * not obtained at the needed granularity (`risk-spec.md` 1.2,
 * `research-notes.md` 5). SOL is more volatile than BTC, so its negative
 * episodes may be sharper. A dedicated pull of SOL-PERP funding history is a
 * prerequisite before any carry figure is advertised.
 */
export const SOL_PROXY_ASSUMPTION =
  "SOL funding stress is proxied from BTC and ETH bear-market behaviour; a primary-source SOL-PERP series has not been obtained yet (risk-spec 1.2).";

/** One column of the `risk-spec.md` 1.3 stress table. */
export interface FundingStressScenario {
  readonly id: string;
  /** Short English label, safe to render. */
  readonly label: string;
  /** `f_d`, the daily funding cost as a positive fraction of hedge notional. */
  readonly dailyCostFraction: number;
  /** `-f_d * 365.25`, the signed simple annual rate. Negative: the protocol pays. */
  readonly annualizedRate: number;
  /** Where the number comes from and what it is not. */
  readonly note: string;
}

/** One row of the `risk-spec.md` 1.3 stress table. */
export interface BufferSizeScenario {
  readonly id: string;
  readonly label: string;
  /** `b = B / S`, the buffer as a fraction of supply. */
  readonly bufferFraction: number;
  readonly note: string;
}

/**
 * The five invented funding columns of the runway table, in the spec's order.
 *
 * These are round numbers for reading sensitivity. For the regime the protocol
 * is actually in, use {@link MEASURED_CARRY_REGIMES}.
 */
export const FUNDING_STRESS_SCENARIOS: readonly FundingStressScenario[] = [
  {
    id: "mild",
    label: "Mild negative funding",
    dailyCostFraction: 0.00015,
    annualizedRate: -dailyToAnnualRate(0.00015),
    note: "About -5.5% per year. A shallow, persistent discount.",
  },
  {
    id: "moderate",
    label: "Moderate negative funding",
    dailyCostFraction: 0.0003,
    annualizedRate: -dailyToAnnualRate(0.0003),
    note: "About -11% per year. Matches the 2022 bear-market average of roughly -0.01% per 8h (risk-spec 1.2).",
  },
  {
    id: "severe",
    label: "Severe negative funding",
    dailyCostFraction: 0.0006,
    annualizedRate: -dailyToAnnualRate(0.0006),
    note: "About -22% per year. Twice the historical bear-market average.",
  },
  {
    id: "extreme",
    label: "Extreme negative funding",
    dailyCostFraction: 0.00125,
    annualizedRate: -dailyToAnnualRate(0.00125),
    note: "About -46% per year. Sharp deleveraging, sustained rather than a single spike.",
  },
  {
    id: "tier_b_cap",
    label: "Tier-B hourly cap",
    dailyCostFraction: TIER_B_DAILY_FUNDING_CAP,
    annualizedRate: -dailyToAnnualRate(TIER_B_DAILY_FUNDING_CAP),
    note: "Mathematical bound only: the venue's 0.125%/hr cap held for a full day. No market sustains the cap; it shows the worst-case bleed rate, not an expectation.",
  },
];

/** The four buffer rows of the runway table, in the spec's order. */
export const BUFFER_SIZE_SCENARIOS: readonly BufferSizeScenario[] = [
  {
    id: "b_100bps",
    label: "1.0% of supply",
    bufferFraction: 0.01,
    note: "Below the Ethena anchor.",
  },
  {
    id: "b_170bps",
    label: "1.7% of supply",
    bufferFraction: 0.017,
    note: "Ethena's empirical first-loss buffer as of June 2026 (research-notes 4).",
  },
  {
    id: "b_300bps",
    label: "3.0% of supply",
    bufferFraction: 0.03,
    note: "The POYZ target, buffer_target_bps = 300 (risk-spec 6). An assumption, not a proven safe level.",
  },
  {
    id: "b_500bps",
    label: "5.0% of supply",
    bufferFraction: 0.05,
    note: "Above target, shown to size the marginal value of a larger buffer.",
  },
];

/** One cell of the runway table. */
export interface RunwayTableCell {
  readonly bufferScenarioId: string;
  readonly fundingScenarioId: string;
  readonly bufferFraction: number;
  readonly dailyCostFraction: number;
  /** `b / f_d`, in days. `null` when there is no drain to run out of. */
  readonly runwayDays: number | null;
}

/**
 * Build a runway table for arbitrary rows and columns. `b / f_d`
 * (`risk-spec.md` 1.2).
 *
 * Pass {@link MEASURED_CARRY_REGIMES} as the columns to get the table for the
 * regime the protocol is in rather than for invented ones.
 */
export function buildRunwayTable(
  bufferScenarios: readonly BufferSizeScenario[] = BUFFER_SIZE_SCENARIOS,
  fundingScenarios: readonly FundingStressScenario[] = FUNDING_STRESS_SCENARIOS,
): readonly RunwayTableCell[] {
  const cells: RunwayTableCell[] = [];
  for (const buffer of bufferScenarios) {
    for (const funding of fundingScenarios) {
      cells.push({
        bufferScenarioId: buffer.id,
        fundingScenarioId: funding.id,
        bufferFraction: buffer.bufferFraction,
        dailyCostFraction: funding.dailyCostFraction,
        runwayDays: bufferRunwayDays(buffer.bufferFraction, funding.dailyCostFraction),
      });
    }
  }
  return cells;
}

/** The invented-column runway table itself, computed rather than transcribed. */
export const RISK_SPEC_RUNWAY_TABLE: readonly RunwayTableCell[] = buildRunwayTable();

/**
 * Live SOL-PERP funding measured on 2026-08-09 and recorded in `_DIRECTION.md`
 * 8-1. Hourly rates as decimal fractions, accruing to the short leg: negative
 * means POYZ pays.
 *
 * This is a **point-in-time snapshot, not live data**, and it is named with its
 * observation date so it cannot be mistaken for one. Anything rendered from it
 * must carry that date. For a current figure, read the venue API; this constant
 * exists so `/simulate` has a realistic default when no live read is available,
 * and so the negative-carry case is the default rather than the exception.
 */
export const SOL_PERP_FUNDING_SNAPSHOT_2026_08_09 = {
  observedAtIso: "2026-08-09",
  source: "_DIRECTION.md 8-1, venue-reported aggregates",
  hourlyRate24h: -0.00012013,
  hourlyRate7d: 0.00002704,
  hourlyRate30d: -0.00004937,
  hourlyRate1y: -0.00004086,
} as const;

/* ------------------------------------------------------------------------- */
/* The measured regime -- what the protocol is actually in                    */
/* ------------------------------------------------------------------------- */

/**
 * One aggregation window of measured venue carry.
 *
 * Unlike {@link FundingStressScenario}, the rates here are **signed**. Carry is
 * a two-sided quantity and one of the four measured windows is positive; a type
 * that only admits a cost would have to either drop that window or flip its
 * sign, and both would misreport the data.
 */
export interface MeasuredCarryRegime {
  readonly id: string;
  /** Short English label, safe to render. */
  readonly label: string;
  /** The aggregation window the venue published. */
  readonly window: "24h" | "7d" | "30d" | "1y";
  /** `f_h`, signed hourly carry to the short leg as a decimal fraction. */
  readonly hourlyRate: number;
  /** `f_h * 24`, signed. Negative means the protocol pays that fraction per day. */
  readonly dailyRate: number;
  /** `f_h * 24 * 365.25`, the signed simple annual rate. */
  readonly annualizedRate: number;
  /** True when the short leg pays under this regime. */
  readonly protocolPays: boolean;
  /** Where the number came from, including the observation date. */
  readonly source: string;
  readonly note: string;
}

function measuredRegime(
  id: string,
  label: string,
  window: MeasuredCarryRegime["window"],
  hourlyRate: number,
  note: string,
): MeasuredCarryRegime {
  return {
    id,
    label,
    window,
    hourlyRate,
    dailyRate: hourlyToDailyRate(hourlyRate),
    annualizedRate: dailyToAnnualRate(hourlyToDailyRate(hourlyRate)),
    protocolPays: hourlyRate < 0,
    source: `${SOL_PERP_FUNDING_SNAPSHOT_2026_08_09.source}, observed ${SOL_PERP_FUNDING_SNAPSHOT_2026_08_09.observedAtIso}`,
    note,
  };
}

/**
 * The four measured Velocity SOL-PERP carry regimes, ordered shortest window
 * first (`_DIRECTION.md` 8-1, observed 2026-08-09).
 *
 * ```
 * 24h  -0.012013 %/hr  ->  -105.3% APR   the short pays
 * 7d   +0.002704 %/hr  ->   +23.7% APR   the short receives
 * 30d  -0.004937 %/hr  ->   -43.3% APR   the short pays
 * 1y   -0.004086 %/hr  ->   -35.8% APR   the short pays
 * ```
 *
 * Three of four windows are negative, including the 1-year average. The
 * statement "a delta-neutral book collects funding" is not true of this venue at
 * this time, and neither this package nor anything rendered from it may imply
 * otherwise. Positive carry is the exception in the measured data, not the base
 * case.
 *
 * These are the venue's own aggregates. POYZ did not compute them from a series;
 * the only arithmetic applied is the annualization `* 24 * 365.25`.
 */
/**
 * The 1-year measured window, the baseline regime for buffer sizing and for the
 * carry gate. Negative: -0.004086%/hr, about -35.8% per year.
 */
export const BASELINE_CARRY_REGIME: MeasuredCarryRegime = measuredRegime(
  "measured_1y",
  "Measured 1y",
  "1y",
  SOL_PERP_FUNDING_SNAPSHOT_2026_08_09.hourlyRate1y,
  "One-year average and the baseline this package treats as the current regime. Negative.",
);

export const MEASURED_CARRY_REGIMES: readonly MeasuredCarryRegime[] = [
  measuredRegime(
    "measured_24h",
    "Measured 24h",
    "24h",
    SOL_PERP_FUNDING_SNAPSHOT_2026_08_09.hourlyRate24h,
    "Spot regime at the observation. The deepest negative of the four windows; a single day is not a trend, and it is shown because it is the rate a mint decided today would face.",
  ),
  measuredRegime(
    "measured_7d",
    "Measured 7d",
    "7d",
    SOL_PERP_FUNDING_SNAPSHOT_2026_08_09.hourlyRate7d,
    "The one positive window of the four. It is not the base case and must not be presented as the expected regime.",
  ),
  measuredRegime(
    "measured_30d",
    "Measured 30d",
    "30d",
    SOL_PERP_FUNDING_SNAPSHOT_2026_08_09.hourlyRate30d,
    "One-month average. Negative, and deeper than the one-year average.",
  ),
  BASELINE_CARRY_REGIME,
];

/**
 * Adapt a measured regime to the runway-table column shape.
 *
 * `dailyCostFraction` is the **cost** magnitude, so a positive-carry regime maps
 * to a negative cost and {@link bufferRunwayDays} returns `null` for it. That is
 * the correct answer: a regime that pays the buffer has no runway to run out of,
 * and a fabricated large number in that cell would be worse than an empty one.
 */
export function carryRegimeAsStressScenario(regime: MeasuredCarryRegime): FundingStressScenario {
  return {
    id: regime.id,
    label: regime.label,
    dailyCostFraction: -regime.dailyRate,
    annualizedRate: regime.annualizedRate,
    note: regime.note,
  };
}

/**
 * Buffer runway against the measured regimes rather than against invented ones.
 *
 * Worked by hand for the baseline cell, `b = 3%` against the 1-year regime:
 *
 * ```
 * f_h  = -0.00004086            (-0.004086 %/hr)
 * f_d  = 0.00004086 * 24        =  0.00098064   (0.098064 %/day)
 * days = 0.03 / 0.00098064      =  30.59        days
 * ```
 *
 * A 3% buffer -- above Ethena's empirical 1.7% -- buys about a month at the
 * one-year average rate. Weeks, not years. That is the argument for the carry
 * gate (`carry-gate.ts`): the buffer cannot be the whole answer.
 */
export const MEASURED_CARRY_RUNWAY_TABLE: readonly RunwayTableCell[] = buildRunwayTable(
  BUFFER_SIZE_SCENARIOS,
  MEASURED_CARRY_REGIMES.map(carryRegimeAsStressScenario),
);
