/**
 * `carry_gate`: refuse new mint when net carry is below the floor.
 *
 * This is a **protocol behaviour, not a disclosure**. `_DIRECTION.md` 8-1
 * decision 3 and `risk-spec.md` 1.4 put it this way: minting into a negative
 * carry regime adds hedge notional that bleeds the buffer, so the program
 * reverts `mint` unless EWMA net carry is at or above `carry_floor`. POYZ does
 * not print when printing does not pay. That is the differentiator; a paragraph
 * on a risk page is not.
 *
 * The floor is derived, not picked:
 *
 * ```
 * carry_floor(daily)  = -(b / min_runway_days)
 * carry_floor(annual) = carry_floor(daily) * 365.25
 * ```
 *
 * with `b = B / S` the buffer as a fraction of supply. Read it backwards and it
 * is the definition of the runway: at exactly the floor, `b / |f_d|` is exactly
 * `min_runway_days`. Any regime the gate admits leaves at least that many days
 * of buffer at the observed rate. The floor tightens by itself as the buffer
 * drains -- `b` falls, the floor rises toward zero -- so no separate ratchet is
 * needed.
 *
 * Worked at the POYZ target buffer (`b = 3%`, `min_runway_days = 30`):
 *
 * ```
 * floor(daily)  = -(0.03 / 30)      = -0.001        (-0.1%/day)
 * floor(annual) = -0.001 * 365.25   = -0.36525      (-36.525%/yr)
 * ```
 *
 * Against the measured venue windows (`scenarios.ts`, `_DIRECTION.md` 8-1):
 *
 * ```
 * 24h  -105.3% APR   blocked
 * 7d    +23.7% APR   allowed
 * 30d   -43.3% APR   blocked
 * 1y    -35.8% APR   allowed, by 0.7 points of headroom
 * ```
 *
 * Three of the four measured windows are negative and two of them are blocked.
 * The gate is not a tail-risk device; on this data it is load-bearing today.
 *
 * **On-chain agreement.** The program compares integers and does not divide.
 * Multiplying both sides of `f_daily >= -(b / d)` by `d` gives
 * `f_daily * d >= -b`, which in basis points is
 * `net_carry_daily_bps * min_runway_days >= -buffer_bps`. That comparison is
 * {@link carryGateAllowsMintBps} and it is exact in `i64`. The floating-point
 * path in this file exists so an off-chain caller can show the floor and the
 * headroom; a test pins the two against each other so they cannot drift.
 *
 * Pure: no clock, no network. `asOfMs` is an input like everywhere else in this
 * package.
 */

import {
  DAYS_PER_YEAR,
  HOURS_PER_DAY,
  ONE_BPS,
  assertFinite,
  assertFiniteNonNegative,
  bufferRunwayDays,
  hourlyToDailyRate,
} from "./units.js";

/**
 * A net-carry observation together with the interval it is quoted on.
 *
 * The basis is a required tag rather than an assumption because reading an
 * 8-hour or annual figure as an hourly one is the single most common error in
 * funding math (`units.ts`), and here it would decide whether the protocol is
 * allowed to mint.
 *
 * `rate` is signed and is net carry, not gross funding: gross funding less
 * hedge cost, the `net_carry` line of `hedge-spec.md` 6. It is negative in the
 * current regime.
 */
export type CarryObservation =
  | { readonly basis: "hourly"; readonly rate: number }
  | { readonly basis: "daily"; readonly rate: number }
  | { readonly basis: "annual"; readonly rate: number };

/** Tunable parameters of the gate. */
export interface CarryGateConfig {
  /**
   * Days of buffer runway the floor must leave at the gated carry.
   *
   * Default 30. Basis: `risk-spec.md` 1.5 puts the first deleveraging action at
   * 50-75% of buffer target and a full mint pause at 25-50%, and the keeper
   * needs enough time to unwind into a book whose measured open interest is a
   * few thousand dollars (`research-notes.md` 1.3). A month is the shortest
   * window in which a deliberate unwind is plausible at that depth. It is a
   * starting parameter to re-derive against live unwind data, not a proven
   * safe value.
   */
  readonly minRunwayDays: number;
  /**
   * Extra headroom, as an annual rate, required to re-open the gate once it has
   * closed. Applies only when `previouslyBlocked` is passed as `true`.
   *
   * **Default 0, meaning no hysteresis.** The reason is arithmetic rather than
   * taste: at `b = 3%` and `minRunwayDays = 30` the floor is -36.525%/yr and
   * the measured 1-year regime is -35.818%/yr, so the baseline sits just
   * 0.707 points inside the floor. Any margin above about 70 bps/yr would flip
   * the baseline regime from allowed to blocked on the re-open path, which is a
   * policy decision with real consequences for supply and not something to
   * inherit from a default. An operator who wants hysteresis must choose the
   * number and own it.
   */
  readonly reopenMarginAnnualRate: number;
}

export const DEFAULT_CARRY_GATE_CONFIG: CarryGateConfig = {
  minRunwayDays: 30,
  reopenMarginAnnualRate: 0,
};

export interface CarryGateInput {
  /**
   * Current net carry, typically the EWMA the program keeps. `null` when there
   * is no observation, which blocks the mint rather than assuming a rate.
   */
  readonly netCarry: CarryObservation | null;
  /**
   * `b = B / S`, the buffer as a fraction of supply. `null` when supply is zero
   * or the buffer has not been read, which blocks the mint.
   */
  readonly bufferFraction: number | null;
  /**
   * Whether the gate was already closed. Only consulted when
   * `reopenMarginAnnualRate` is non-zero.
   */
  readonly previouslyBlocked?: boolean;
  /** Overrides merged over {@link DEFAULT_CARRY_GATE_CONFIG}. */
  readonly config?: Partial<CarryGateConfig>;
  /** Unix milliseconds this evaluation is anchored to. Echoed back, never read from a clock. */
  readonly asOfMs?: number;
}

/** What the gate decided. */
export type CarryGateDecision = "allow_mint" | "block_mint";

/** Machine-readable ground for the decision. */
export type CarryGateReason =
  | "carry_at_or_above_floor"
  | "carry_below_floor"
  | "carry_below_reopen_margin"
  | "no_carry_observation"
  | "no_buffer_measurement";

export interface CarryGateEvaluation {
  readonly decision: CarryGateDecision;
  /** `true` exactly when `decision` is `allow_mint`. Convenience for call sites. */
  readonly mintAllowed: boolean;
  readonly reason: CarryGateReason;
  /** One English sentence stating the ground. Safe to render verbatim. */
  readonly reasonText: string;
  /** True when the gate blocked because an input was missing rather than because carry was low. */
  readonly insufficientData: boolean;
  /** The observation restated per hour. Signed. `null` without an observation. */
  readonly netCarryHourlyRate: number | null;
  /** The observation restated per day. Signed. */
  readonly netCarryDailyRate: number | null;
  /** The observation restated per year, `* 24 * 365.25`. Signed. */
  readonly netCarryAnnualRate: number | null;
  /** `-(b / min_runway_days)`, the daily floor. `null` without a buffer measurement. */
  readonly carryFloorDailyRate: number | null;
  /** The same floor annualized. */
  readonly carryFloorAnnualRate: number | null;
  /**
   * `carry - floor`, annualized. Positive is headroom above the floor, negative
   * is the distance the regime would have to improve to re-open the gate.
   */
  readonly headroomAnnualRate: number | null;
  /**
   * `b / |f_d|`, the runway the observed carry implies at the current buffer.
   * `null` when carry is not negative, because there is no drain to run out of.
   * An estimate under the `depletion.ts` assumptions.
   */
  readonly impliedRunwayDays: number | null;
  readonly bufferFraction: number | null;
  readonly minRunwayDays: number;
  /** Echo of the caller's `asOfMs`, or `null` when none was supplied. */
  readonly asOfMs: number | null;
  /** The assumptions this decision stands on. Never empty. Safe to render verbatim. */
  readonly assumptions: readonly string[];
}

const GATE_ASSUMPTIONS: readonly string[] = [
  "The floor is derived from the buffer, not chosen: carry_floor(daily) = -(buffer / min_runway_days), so an admitted regime leaves at least min_runway_days of buffer at the observed rate (risk-spec 1.4).",
  "Annualization is simple and uses 24 * 365.25 = 8766 hours (_DIRECTION 8-1).",
  "The observed carry is assumed to hold flat over the runway it implies. Real carry does not hold flat, and a deepening regime shortens that runway.",
  "The buffer is assumed to be the sole first-loss layer, with a full hedge (H ~= S) and no new mint arriving to refill it.",
  "Venue failure, auto-deleverage, oracle deviation and liquidation of the hedge leg are separate hazards the gate does not address; see risk-spec 2 and 3.",
];

const NO_OBSERVATION_ASSUMPTION =
  "The gate fails closed: without a carry observation the mint is refused rather than admitted on an assumed rate.";

function resolveConfig(overrides: Partial<CarryGateConfig> | undefined): CarryGateConfig {
  const config = { ...DEFAULT_CARRY_GATE_CONFIG, ...overrides };
  assertFinite(config.reopenMarginAnnualRate, "reopenMarginAnnualRate");
  if (config.reopenMarginAnnualRate < 0) {
    throw new RangeError("reopenMarginAnnualRate must be greater than or equal to zero");
  }
  if (!Number.isFinite(config.minRunwayDays) || config.minRunwayDays <= 0) {
    throw new RangeError("minRunwayDays must be a finite number greater than zero");
  }
  return config;
}

/** Restate a tagged observation as a signed daily rate. */
export function carryObservationToDailyRate(observation: CarryObservation): number {
  assertFinite(observation.rate, "netCarry.rate");
  switch (observation.basis) {
    case "hourly":
      return hourlyToDailyRate(observation.rate);
    case "daily":
      return observation.rate;
    case "annual":
      return observation.rate / DAYS_PER_YEAR;
  }
}

/**
 * `carry_floor(daily) = -(b / min_runway_days)`.
 *
 * Always less than or equal to zero. At `b = 0` it is exactly zero: an empty
 * buffer admits no negative carry at all, which is the correct terminal
 * behaviour rather than an edge case to special-case.
 *
 * @throws RangeError on a negative or non-finite buffer, or a non-positive
 * runway requirement.
 */
export function carryFloorDailyRate(bufferFraction: number, minRunwayDays: number): number {
  assertFiniteNonNegative(bufferFraction, "bufferFraction");
  if (!Number.isFinite(minRunwayDays) || minRunwayDays <= 0) {
    throw new RangeError("minRunwayDays must be a finite number greater than zero");
  }
  return -(bufferFraction / minRunwayDays);
}

/** The same floor as a simple annual rate, `* 365.25`. */
export function carryFloorAnnualRate(bufferFraction: number, minRunwayDays: number): number {
  return carryFloorDailyRate(bufferFraction, minRunwayDays) * DAYS_PER_YEAR;
}

/**
 * The integer form of the gate, in basis points, as the program evaluates it.
 *
 * `net_carry_daily_bps * min_runway_days >= -buffer_bps`. No division and no
 * float, so an `i64` implementation on-chain and this line agree bit for bit.
 *
 * The floating-point path ({@link evaluateCarryGate}) is the same inequality
 * divided through by `min_runway_days`; a test holds the two together.
 *
 * @throws RangeError when an argument is not a finite integer, when the buffer
 * is negative, or when the runway requirement is not positive.
 */
export function carryGateAllowsMintBps(
  netCarryDailyBps: number,
  bufferBps: number,
  minRunwayDays: number,
): boolean {
  if (!Number.isInteger(netCarryDailyBps)) {
    throw new RangeError("netCarryDailyBps must be an integer");
  }
  if (!Number.isInteger(bufferBps) || bufferBps < 0) {
    throw new RangeError("bufferBps must be an integer greater than or equal to zero");
  }
  if (!Number.isInteger(minRunwayDays) || minRunwayDays <= 0) {
    throw new RangeError("minRunwayDays must be an integer greater than zero");
  }
  return netCarryDailyBps * minRunwayDays >= -bufferBps;
}

/**
 * Decide whether the protocol may mint under the observed carry.
 *
 * Pure. Reads no clock, no network and no file.
 *
 * Worked example, the measured 1-year regime at the target buffer:
 *
 * ```
 * netCarry            = { basis: "hourly", rate: -0.00004086 }
 * bufferFraction      = 0.03
 * minRunwayDays       = 30
 *
 * netCarryDailyRate   = -0.00004086 * 24       = -0.00098064
 * netCarryAnnualRate  = -0.00098064 * 365.25   = -0.35817876   (-35.82%/yr)
 * carryFloorDailyRate = -(0.03 / 30)           = -0.001
 * carryFloorAnnualRate= -0.001 * 365.25        = -0.36525      (-36.525%/yr)
 * headroomAnnualRate  = -0.35817876 + 0.36525  = +0.00707124   (+0.71 points)
 * impliedRunwayDays   = 0.03 / 0.00098064      = 30.59
 * decision            = "allow_mint"
 * ```
 *
 * The 30-day and 24-hour windows fail the same comparison and block.
 *
 * @throws RangeError on a malformed input or configuration.
 */
export function evaluateCarryGate(input: CarryGateInput): CarryGateEvaluation {
  const config = resolveConfig(input.config);
  if (input.asOfMs !== undefined) {
    assertFinite(input.asOfMs, "asOfMs");
  }
  const asOfMs = input.asOfMs ?? null;

  if (input.bufferFraction !== null) {
    assertFiniteNonNegative(input.bufferFraction, "bufferFraction");
  }

  const assumptions = [...GATE_ASSUMPTIONS];

  if (input.bufferFraction === null) {
    return {
      decision: "block_mint",
      mintAllowed: false,
      reason: "no_buffer_measurement",
      reasonText:
        "The buffer share of supply could not be measured, so the carry floor is undefined and new mint is refused.",
      insufficientData: true,
      netCarryHourlyRate: null,
      netCarryDailyRate: null,
      netCarryAnnualRate: null,
      carryFloorDailyRate: null,
      carryFloorAnnualRate: null,
      headroomAnnualRate: null,
      impliedRunwayDays: null,
      bufferFraction: null,
      minRunwayDays: config.minRunwayDays,
      asOfMs,
      assumptions: [...assumptions, NO_OBSERVATION_ASSUMPTION],
    };
  }

  const floorDaily = carryFloorDailyRate(input.bufferFraction, config.minRunwayDays);
  const floorAnnual = floorDaily * DAYS_PER_YEAR;

  if (input.netCarry === null) {
    return {
      decision: "block_mint",
      mintAllowed: false,
      reason: "no_carry_observation",
      reasonText:
        "No net carry observation was supplied, so the gate cannot be cleared and new mint is refused.",
      insufficientData: true,
      netCarryHourlyRate: null,
      netCarryDailyRate: null,
      netCarryAnnualRate: null,
      carryFloorDailyRate: floorDaily,
      carryFloorAnnualRate: floorAnnual,
      headroomAnnualRate: null,
      impliedRunwayDays: null,
      bufferFraction: input.bufferFraction,
      minRunwayDays: config.minRunwayDays,
      asOfMs,
      assumptions: [...assumptions, NO_OBSERVATION_ASSUMPTION],
    };
  }

  const dailyRate = carryObservationToDailyRate(input.netCarry);
  const annualRate = dailyRate * DAYS_PER_YEAR;
  const hourlyRate = dailyRate / HOURS_PER_DAY;
  const headroomAnnualRate = annualRate - floorAnnual;
  const impliedRunwayDays =
    dailyRate < 0 ? bufferRunwayDays(input.bufferFraction, -dailyRate) : null;

  const clearsFloor = dailyRate >= floorDaily;
  const requiresMargin = config.reopenMarginAnnualRate > 0 && input.previouslyBlocked === true;
  const clearsReopenMargin = annualRate >= floorAnnual + config.reopenMarginAnnualRate;

  if (requiresMargin) {
    assumptions.push(
      "The gate was already closed, so re-opening requires the configured margin above the floor on top of clearing it.",
    );
  }

  if (!clearsFloor) {
    return {
      decision: "block_mint",
      mintAllowed: false,
      reason: "carry_below_floor",
      reasonText: `Net carry of ${formatAnnualPercent(annualRate)} per year is below the carry floor of ${formatAnnualPercent(floorAnnual)} per year, so new mint is refused: minting here would shorten the buffer runway past ${config.minRunwayDays} days.`,
      insufficientData: false,
      netCarryHourlyRate: hourlyRate,
      netCarryDailyRate: dailyRate,
      netCarryAnnualRate: annualRate,
      carryFloorDailyRate: floorDaily,
      carryFloorAnnualRate: floorAnnual,
      headroomAnnualRate,
      impliedRunwayDays,
      bufferFraction: input.bufferFraction,
      minRunwayDays: config.minRunwayDays,
      asOfMs,
      assumptions,
    };
  }

  if (requiresMargin && !clearsReopenMargin) {
    return {
      decision: "block_mint",
      mintAllowed: false,
      reason: "carry_below_reopen_margin",
      reasonText: `Net carry of ${formatAnnualPercent(annualRate)} per year clears the carry floor of ${formatAnnualPercent(floorAnnual)} per year but not the ${formatAnnualPercent(config.reopenMarginAnnualRate)} margin required to re-open a closed gate, so new mint stays refused.`,
      insufficientData: false,
      netCarryHourlyRate: hourlyRate,
      netCarryDailyRate: dailyRate,
      netCarryAnnualRate: annualRate,
      carryFloorDailyRate: floorDaily,
      carryFloorAnnualRate: floorAnnual,
      headroomAnnualRate,
      impliedRunwayDays,
      bufferFraction: input.bufferFraction,
      minRunwayDays: config.minRunwayDays,
      asOfMs,
      assumptions,
    };
  }

  return {
    decision: "allow_mint",
    mintAllowed: true,
    reason: "carry_at_or_above_floor",
    reasonText: `Net carry of ${formatAnnualPercent(annualRate)} per year is at or above the carry floor of ${formatAnnualPercent(floorAnnual)} per year, which leaves at least ${config.minRunwayDays} days of buffer runway at the observed rate.`,
    insufficientData: false,
    netCarryHourlyRate: hourlyRate,
    netCarryDailyRate: dailyRate,
    netCarryAnnualRate: annualRate,
    carryFloorDailyRate: floorDaily,
    carryFloorAnnualRate: floorAnnual,
    headroomAnnualRate,
    impliedRunwayDays,
    bufferFraction: input.bufferFraction,
    minRunwayDays: config.minRunwayDays,
    asOfMs,
    assumptions,
  };
}

/**
 * Signed percent with two decimals, for the reason sentence only. Display
 * rounding; never fed back into a comparison.
 */
function formatAnnualPercent(rate: number): string {
  const percent = rate * 100;
  const rounded = percent.toFixed(2);
  return `${percent > 0 ? "+" : ""}${rounded}%`;
}

/**
 * A signed daily rate as integer basis points, for the on-chain comparison in
 * {@link carryGateAllowsMintBps}.
 *
 * Rounds toward negative infinity, so a negative carry is rounded to a slightly
 * larger cost and a positive carry to a slightly smaller gain. Both directions
 * make the gate marginally stricter, which is the direction a sub-basis-point
 * residual should fall in when it decides whether the protocol may issue.
 */
export function carryRateToDailyBps(dailyRate: number): number {
  assertFinite(dailyRate, "dailyRate");
  return Math.floor(dailyRate / ONE_BPS);
}
