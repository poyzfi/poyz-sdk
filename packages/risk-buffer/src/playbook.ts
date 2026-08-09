/**
 * The negative-funding playbook.
 *
 * `risk-spec.md` 1.5 defines five buffer regimes and the actions each one
 * triggers. The regimes are read off the buffer's balance **as a fraction of its
 * target**, not as a fraction of supply: a 1.5% buffer is healthy against a 1.7%
 * target and severely drained against a 3% target, and the stage machine has to
 * say so.
 *
 * Escalation is a protocol state, not a discretionary hope. Each stage carries a
 * machine-readable action set (`pauseMint`, `mintFeeBpsDelta`,
 * `hedgeReductionBps`, `redeemIncentiveBps`, `disclosureRequired`) so a keeper
 * can act on it without parsing prose, plus the prose itself so the same wording
 * reaches the keeper log, the status API and the public risk page without being
 * softened on the way out.
 */

import type { BufferProjection } from "./depletion.js";
import { assertFinite } from "./units.js";

/**
 * Buffer regime, from `risk-spec.md` 1.5. Ordered worst-first when read top to
 * bottom.
 *
 * - `backing_only`  Buffer exhausted. Staker NAV declines; redemption is honored
 *   at the oracle NAV of remaining collateral. This is the failure mode.
 * - `halt_unwind`   Below 25% of target. Mint halted, controlled unwind,
 *   governance decision point.
 * - `reduce`        25% to 50% of target. Actively deleverage; new mint paused.
 * - `draining`      50% to 75% of target. Raise mint fee, trim the worst-funding
 *   venue, raise the redemption incentive.
 * - `healthy`       Above 75% of target. The buffer absorbs the bleed and the
 *   staker reward index floors at zero.
 *
 * "Healthy" describes the buffer, not the regime. The regime this enum exists
 * for is negative funding, in which the protocol is paying.
 */
export type BufferStage =
  | "backing_only"
  | "halt_unwind"
  | "reduce"
  | "draining"
  | "healthy";

/**
 * The four-stage vocabulary this package shipped before `risk-spec.md` 1.5 was
 * written.
 *
 * @deprecated Use {@link BufferStage}. Retained so existing callers keep
 * compiling; `negativeFundingPlaybook` accepts either vocabulary.
 */
export type LegacyPlaybookStage = "nominal" | "watch" | "throttle" | "unwind";

/**
 * @deprecated Alias of {@link LegacyPlaybookStage}. The current five-stage
 * vocabulary is {@link BufferStage}.
 */
export type PlaybookStage = LegacyPlaybookStage;

/**
 * Stage order, most severe first. Index doubles as a severity rank: a lower
 * index is a more defensive posture.
 */
export const BUFFER_STAGE_ORDER: readonly BufferStage[] = [
  "backing_only",
  "halt_unwind",
  "reduce",
  "draining",
  "healthy",
];

/**
 * Trigger thresholds.
 *
 * The four `*FractionOfTarget` fields are the `risk-spec.md` 1.5 triggers and
 * default to 75 / 50 / 25 / 0 percent of `buffer_target_bps`. They are optional
 * only so that callers which built a `PlaybookThresholds` literal against the
 * older four-stage selector keep compiling; when omitted the defaults below are
 * used.
 *
 * The `*CoverageRatio` and `*Days` fields belong to the deprecated four-stage
 * selector and are measured against **supply**, not against target. They are a
 * different scale and are not interchangeable with the fraction-of-target
 * fields.
 */
export interface PlaybookThresholds {
  /**
   * Coverage at or below this enters `watch`.
   * @deprecated Four-stage selector only.
   */
  readonly watchCoverageRatio: number;
  /**
   * Coverage at or below this enters `throttle`.
   * @deprecated Four-stage selector only.
   */
  readonly throttleCoverageRatio: number;
  /**
   * Coverage at or below this enters `unwind`.
   * @deprecated Four-stage selector only.
   */
  readonly unwindCoverageRatio: number;
  /**
   * Runway at or below this many days enters `watch`.
   * @deprecated Four-stage selector only.
   */
  readonly watchDays: number;
  /**
   * Runway at or below this many days enters `throttle`.
   * @deprecated Four-stage selector only.
   */
  readonly throttleDays: number;
  /**
   * Runway at or below this many days enters `unwind`.
   * @deprecated Four-stage selector only.
   */
  readonly unwindDays: number;

  /** Strictly above this fraction of target is `healthy`. Default `0.75`. */
  readonly healthyFractionOfTarget?: number;
  /** Above this fraction of target, and at or below `healthyFractionOfTarget`, is `draining`. Default `0.50`. */
  readonly drainingFractionOfTarget?: number;
  /** At or above this fraction of target, and at or below `drainingFractionOfTarget`, is `reduce`. Default `0.25`. */
  readonly reduceFractionOfTarget?: number;
  /** At or below this fraction of target is `backing_only`. Default `0`. */
  readonly backingOnlyFractionOfTarget?: number;
}

/**
 * Starting policy parameters, not measured values.
 *
 * The fraction-of-target triggers are the `risk-spec.md` 1.5 table. The
 * four-stage coverage and runway fields are the deliberately conservative
 * defaults this package shipped with. Every deployment is expected to set these
 * explicitly rather than inherit them silently.
 */
export const DEFAULT_PLAYBOOK_THRESHOLDS: PlaybookThresholds = {
  watchCoverageRatio: 0.02,
  throttleCoverageRatio: 0.01,
  unwindCoverageRatio: 0.005,
  watchDays: 90,
  throttleDays: 30,
  unwindDays: 7,
  healthyFractionOfTarget: 0.75,
  drainingFractionOfTarget: 0.5,
  reduceFractionOfTarget: 0.25,
  backingOnlyFractionOfTarget: 0,
};

interface ResolvedStageThresholds {
  readonly healthy: number;
  readonly draining: number;
  readonly reduce: number;
  readonly backingOnly: number;
}

function resolveStageThresholds(thresholds: PlaybookThresholds): ResolvedStageThresholds {
  const resolved: ResolvedStageThresholds = {
    healthy: thresholds.healthyFractionOfTarget ?? 0.75,
    draining: thresholds.drainingFractionOfTarget ?? 0.5,
    reduce: thresholds.reduceFractionOfTarget ?? 0.25,
    backingOnly: thresholds.backingOnlyFractionOfTarget ?? 0,
  };
  assertFinite(resolved.healthy, "healthyFractionOfTarget");
  assertFinite(resolved.draining, "drainingFractionOfTarget");
  assertFinite(resolved.reduce, "reduceFractionOfTarget");
  assertFinite(resolved.backingOnly, "backingOnlyFractionOfTarget");
  if (
    !(
      resolved.backingOnly <= resolved.reduce &&
      resolved.reduce <= resolved.draining &&
      resolved.draining <= resolved.healthy
    )
  ) {
    throw new RangeError(
      "stage thresholds must be ordered backingOnly <= reduce <= draining <= healthy",
    );
  }
  return resolved;
}

/**
 * Magnitudes of the stage actions.
 *
 * `[ASSUMPTION]` These are starting policy parameters chosen to be
 * proportionate to the stage, not values derived from live data. They are
 * exposed so governance sets them explicitly. `risk-spec.md` 1.5 states the
 * *direction* of each action (raise the mint fee, trim the hedge, raise the
 * redemption incentive); the sizes here are ours.
 */
export interface PlaybookActionParameters {
  /** Added to `mint_fee_bps` while `draining`. */
  readonly drainingMintFeeBpsDelta: number;
  /** Added to `mint_fee_bps` while `reduce`. Mint is paused at this stage, so this applies only if the pause is lifted. */
  readonly reduceMintFeeBpsDelta: number;
  /** Share of hedge notional to trim while `draining`, in bps of notional. */
  readonly drainingHedgeReductionBps: number;
  /** Share of hedge notional to trim while `reduce`, in bps of notional. */
  readonly reduceHedgeReductionBps: number;
  /** Share of hedge notional to trim while unwinding. `10000` is a full unwind to an unhedged posture. */
  readonly haltHedgeReductionBps: number;
  /** Redemption incentive while `draining`, in bps. */
  readonly drainingRedeemIncentiveBps: number;
  /** Redemption incentive while `reduce`, in bps. */
  readonly reduceRedeemIncentiveBps: number;
  /** Redemption incentive while `halt_unwind`, in bps. */
  readonly haltRedeemIncentiveBps: number;
}

export const DEFAULT_PLAYBOOK_ACTION_PARAMETERS: PlaybookActionParameters = {
  drainingMintFeeBpsDelta: 25,
  reduceMintFeeBpsDelta: 50,
  drainingHedgeReductionBps: 500,
  reduceHedgeReductionBps: 2500,
  haltHedgeReductionBps: 10_000,
  drainingRedeemIncentiveBps: 10,
  reduceRedeemIncentiveBps: 25,
  haltRedeemIncentiveBps: 50,
};

/**
 * The action set for one stage: machine-readable knobs plus the operator prose.
 *
 * `stage` carries the five-stage vocabulary of `risk-spec.md` 1.5. `legacyStage`
 * carries the nearest name from the retired four-stage vocabulary for callers
 * that have not migrated.
 */
export interface PlaybookStep {
  readonly stage: BufferStage;
  /** @deprecated Nearest four-stage name. `backing_only` maps to `unwind`. */
  readonly legacyStage: LegacyPlaybookStage;
  /** Regime label from `risk-spec.md` 1.5, in the spec's own words. */
  readonly regime: string;
  /** Ordered actions for this stage. */
  readonly actions: readonly string[];
  /** Mint is halted at this stage. */
  readonly pauseMint: boolean;
  /** Basis points to add to `mint_fee_bps` at this stage. */
  readonly mintFeeBpsDelta: number;
  /** Basis points of hedge notional to remove at this stage. `10000` is a full unwind. */
  readonly hedgeReductionBps: number;
  /** Basis points of redemption incentive to apply at this stage. */
  readonly redeemIncentiveBps: number;
  /** This stage requires an explicit public disclosure beyond the routine metrics. */
  readonly disclosureRequired: boolean;
  /** The staker reward index floors at zero rather than accruing negative at this stage. */
  readonly stakerRewardIndexFloorAtZero: boolean;
  /** Staked holders are subordinated and their NAV declines at this stage. */
  readonly stakerNavSubordinated: boolean;
  /** Reaching this stage is a governance decision point. */
  readonly governanceDecisionPoint: boolean;
  /** Cutting the hedge here reintroduces directional exposure that must be disclosed before it is taken on. */
  readonly reintroducesDirectionalExposure: boolean;
  /**
   * Whether new issuance is constrained at this stage.
   * @deprecated Read `pauseMint` and `mintFeeBpsDelta` instead.
   */
  readonly restrictIssuance: boolean;
  /**
   * Whether hedge notional is actively reduced at this stage.
   * @deprecated Read `hedgeReductionBps` instead.
   */
  readonly reduceHedgeNotional: boolean;
}

const LEGACY_TO_BUFFER_STAGE: Readonly<Record<LegacyPlaybookStage, BufferStage>> = {
  nominal: "healthy",
  watch: "draining",
  throttle: "reduce",
  unwind: "halt_unwind",
};

const BUFFER_TO_LEGACY_STAGE: Readonly<Record<BufferStage, LegacyPlaybookStage>> = {
  healthy: "nominal",
  draining: "watch",
  reduce: "throttle",
  halt_unwind: "unwind",
  backing_only: "unwind",
};

function isLegacyStage(stage: BufferStage | LegacyPlaybookStage): stage is LegacyPlaybookStage {
  return Object.hasOwn(LEGACY_TO_BUFFER_STAGE, stage);
}

/** Normalize either vocabulary to the five-stage one. */
export function toBufferStage(stage: BufferStage | LegacyPlaybookStage): BufferStage {
  return isLegacyStage(stage) ? LEGACY_TO_BUFFER_STAGE[stage] : stage;
}

/**
 * Severity rank of a stage. Lower is more defensive. `backing_only` is `0`.
 */
export function bufferStageSeverityRank(stage: BufferStage): number {
  return BUFFER_STAGE_ORDER.indexOf(stage);
}

/**
 * Select the stage implied by the buffer's balance as a fraction of its target.
 *
 * Boundary handling, fixed here and in the tests so it cannot drift:
 *
 * | fraction of target | stage          | why |
 * |---|---|---|
 * | exactly `0.75`     | `draining`     | `risk-spec.md` 1.5 writes healthy as `> 75%`, so 75% is not healthy; the `50-75%` band claims it. |
 * | exactly `0.50`     | `reduce`       | The spec writes both `50-75%` and `25-50%` inclusively, so 50% is genuinely ambiguous. The tie goes to the more defensive stage. |
 * | exactly `0.25`     | `reduce`       | The spec writes halt as `< 25%` and reduce as `25-50%`, so 25% is unambiguously `reduce`. This is the one boundary where the more defensive stage does **not** win, and it is the spec's own wording. |
 * | exactly `0`        | `backing_only` | The spec assigns `0%` its own row. |
 *
 * A negative fraction is clamped to zero; a buffer cannot hold less than
 * nothing, and anything past zero is already backing impairment.
 */
export function selectBufferStage(
  fractionOfTarget: number,
  thresholds: PlaybookThresholds = DEFAULT_PLAYBOOK_THRESHOLDS,
): BufferStage {
  assertFinite(fractionOfTarget, "fractionOfTarget");
  const t = resolveStageThresholds(thresholds);
  const fraction = Math.max(0, fractionOfTarget);

  if (fraction <= t.backingOnly) {
    return "backing_only";
  }
  if (fraction < t.reduce) {
    return "halt_unwind";
  }
  if (fraction <= t.draining) {
    return "reduce";
  }
  if (fraction <= t.healthy) {
    return "draining";
  }
  return "healthy";
}

/**
 * Upper edge of a stage's band, as a fraction of target. `null` for `healthy`,
 * which has no upper edge.
 */
export function bufferStageUpperBound(
  stage: BufferStage,
  thresholds: PlaybookThresholds = DEFAULT_PLAYBOOK_THRESHOLDS,
): number | null {
  const t = resolveStageThresholds(thresholds);
  switch (stage) {
    case "backing_only":
      return t.backingOnly;
    case "halt_unwind":
      return t.reduce;
    case "reduce":
      return t.draining;
    case "draining":
      return t.healthy;
    case "healthy":
      return null;
  }
}

/** Hysteresis policy for stage transitions. */
export interface BufferStageHysteresis {
  /**
   * How far above a stage's upper edge the buffer must recover before that
   * stage is left in the easing direction, as a fraction of target. `0.05` is
   * five points of target coverage.
   */
  readonly easingMarginFractionOfTarget: number;
  /**
   * How many stages may be eased in a single transition. `1` forces recovery to
   * be walked back one stage at a time.
   */
  readonly maxEaseStepsPerTransition: number;
}

/**
 * `[ASSUMPTION]` Starting hysteresis policy. Five points of target coverage is
 * wide enough that a buffer oscillating around a trigger does not flip stages,
 * and narrow enough that a genuine recovery is recognized within one refill.
 */
export const DEFAULT_BUFFER_STAGE_HYSTERESIS: BufferStageHysteresis = {
  easingMarginFractionOfTarget: 0.05,
  maxEaseStepsPerTransition: 1,
};

/**
 * History-dependent stage transition.
 *
 * Escalation is immediate and may skip stages: if the buffer falls straight from
 * healthy to 10% of target, the protocol goes straight to `halt_unwind`. Easing
 * is deliberately slow. The buffer must recover past the current stage's upper
 * edge by `easingMarginFractionOfTarget` before the stage is relaxed at all, and
 * then only by `maxEaseStepsPerTransition` stages. A buffer oscillating around a
 * trigger therefore stays in the more defensive posture.
 *
 * Pure: the caller supplies the current stage, so there is no hidden state.
 */
export function nextStage(
  current: BufferStage,
  fractionOfTarget: number,
  thresholds: PlaybookThresholds = DEFAULT_PLAYBOOK_THRESHOLDS,
  hysteresis: BufferStageHysteresis = DEFAULT_BUFFER_STAGE_HYSTERESIS,
): BufferStage {
  assertFinite(fractionOfTarget, "fractionOfTarget");
  assertFinite(hysteresis.easingMarginFractionOfTarget, "easingMarginFractionOfTarget");
  if (
    !Number.isInteger(hysteresis.maxEaseStepsPerTransition) ||
    hysteresis.maxEaseStepsPerTransition < 1
  ) {
    throw new RangeError("maxEaseStepsPerTransition must be an integer greater than or equal to 1");
  }

  const raw = selectBufferStage(fractionOfTarget, thresholds);
  const rawRank = bufferStageSeverityRank(raw);
  const currentRank = bufferStageSeverityRank(current);

  // Tightening, or no change: apply immediately and without a margin. A draining
  // buffer is not a place to be conservative about acting.
  if (rawRank <= currentRank) {
    return raw;
  }

  const upperBound = bufferStageUpperBound(current, thresholds);
  if (upperBound === null) {
    return raw;
  }
  if (Math.max(0, fractionOfTarget) <= upperBound + hysteresis.easingMarginFractionOfTarget) {
    return current;
  }

  const easedRank = Math.min(rawRank, currentRank + hysteresis.maxEaseStepsPerTransition);
  return BUFFER_STAGE_ORDER[easedRank] ?? raw;
}

function stageFromCoverage(ratio: number, thresholds: PlaybookThresholds): LegacyPlaybookStage {
  if (ratio <= thresholds.unwindCoverageRatio) {
    return "unwind";
  }
  if (ratio <= thresholds.throttleCoverageRatio) {
    return "throttle";
  }
  if (ratio <= thresholds.watchCoverageRatio) {
    return "watch";
  }
  return "nominal";
}

function stageFromRunway(
  daysToDepletion: number | null,
  thresholds: PlaybookThresholds,
): LegacyPlaybookStage {
  if (daysToDepletion === null) {
    return "nominal";
  }
  if (daysToDepletion <= thresholds.unwindDays) {
    return "unwind";
  }
  if (daysToDepletion <= thresholds.throttleDays) {
    return "throttle";
  }
  if (daysToDepletion <= thresholds.watchDays) {
    return "watch";
  }
  return "nominal";
}

const LEGACY_STAGE_SEVERITY: Readonly<Record<LegacyPlaybookStage, number>> = {
  nominal: 0,
  watch: 1,
  throttle: 2,
  unwind: 3,
};

/**
 * Pick the four-stage posture implied by a projection, from coverage of supply
 * and runway in days, more severe of the two winning.
 *
 * @deprecated `risk-spec.md` 1.5 defines five stages triggered by the buffer's
 * fraction of target, not by coverage of supply. Use {@link selectBufferStage}
 * with {@link import("./accounting.js").coverageFractionOfTarget}. Retained so
 * existing callers keep working.
 */
export function selectPlaybookStage(
  projection: BufferProjection,
  thresholds: PlaybookThresholds = DEFAULT_PLAYBOOK_THRESHOLDS,
): LegacyPlaybookStage {
  const byCoverage = stageFromCoverage(projection.coverageRatio, thresholds);
  const byRunway = stageFromRunway(projection.daysToDepletion, thresholds);
  return LEGACY_STAGE_SEVERITY[byCoverage] >= LEGACY_STAGE_SEVERITY[byRunway] ? byCoverage : byRunway;
}

/**
 * The negative-funding playbook for a stage (`risk-spec.md` 1.5).
 *
 * Accepts either the five-stage vocabulary or the retired four-stage one and
 * always answers in the five-stage one.
 *
 * The prose is written as operator instructions so the same text can be
 * surfaced in the keeper log, the status API and the public risk page. The
 * `backing_only` text in particular states the failure plainly; softening it
 * would be the thing `risk-spec.md` exists to prevent.
 */
export function negativeFundingPlaybook(
  stage: BufferStage | LegacyPlaybookStage,
  parameters: PlaybookActionParameters = DEFAULT_PLAYBOOK_ACTION_PARAMETERS,
): PlaybookStep {
  const resolved = toBufferStage(stage);
  const legacyStage = BUFFER_TO_LEGACY_STAGE[resolved];

  switch (resolved) {
    case "healthy":
      return finalize({
        stage: resolved,
        legacyStage,
        regime: "Negative funding, buffer healthy",
        actions: [
          "The buffer covers the negative carry; the staker reward index floors at zero rather than accruing negative.",
          "Sweep protocol fees and the retained share of positive-carry epochs into the buffer until it reaches target.",
          "Publish coverage against target, observed net carry and the projected runway in days.",
          "Re-run the runway estimate against a stressed funding rate, not only the observed one.",
        ],
        pauseMint: false,
        mintFeeBpsDelta: 0,
        hedgeReductionBps: 0,
        redeemIncentiveBps: 0,
        disclosureRequired: false,
        stakerRewardIndexFloorAtZero: true,
        stakerNavSubordinated: false,
        governanceDecisionPoint: false,
        reintroducesDirectionalExposure: false,
      });
    case "draining":
      return finalize({
        stage: resolved,
        legacyStage,
        regime: "Buffer draining",
        actions: [
          "Raise mint_fee_bps to slow hedge-hungry new issuance.",
          "Trim hedge notional on the worst-funding venue, within the per-venue concentration cap.",
          "Raise the redemption incentive to shrink supply.",
          "Publish the buffer draw rate alongside coverage against target.",
        ],
        pauseMint: false,
        mintFeeBpsDelta: parameters.drainingMintFeeBpsDelta,
        hedgeReductionBps: parameters.drainingHedgeReductionBps,
        redeemIncentiveBps: parameters.drainingRedeemIncentiveBps,
        disclosureRequired: true,
        stakerRewardIndexFloorAtZero: true,
        stakerNavSubordinated: false,
        governanceDecisionPoint: false,
        reintroducesDirectionalExposure: true,
      });
    case "reduce":
      return finalize({
        stage: resolved,
        legacyStage,
        regime: "Deleverage",
        actions: [
          "Actively deleverage: cut hedge notional, which lowers the funding cost and reintroduces bounded directional exposure.",
          "Disclose the size of that directional exposure before it is taken on.",
          "Pause new mint.",
          "Keep redemption open and rate-limited by available venue depth.",
        ],
        pauseMint: true,
        mintFeeBpsDelta: parameters.reduceMintFeeBpsDelta,
        hedgeReductionBps: parameters.reduceHedgeReductionBps,
        redeemIncentiveBps: parameters.reduceRedeemIncentiveBps,
        disclosureRequired: true,
        stakerRewardIndexFloorAtZero: true,
        stakerNavSubordinated: false,
        governanceDecisionPoint: false,
        reintroducesDirectionalExposure: true,
      });
    case "halt_unwind":
      return finalize({
        stage: resolved,
        legacyStage,
        regime: "Halt and unwind",
        actions: [
          "Halt mint entirely.",
          "Queue redemption and encourage it; prioritise it over every other outflow.",
          "Unwind under control toward a lower-leverage or fully collateralized posture. Fully collateralized carries no funding cost and full directional exposure; that trade is the point of this stage.",
          "Escalate to a governance decision point and publish the state, the remaining buffer balance and the realized loss to date.",
        ],
        pauseMint: true,
        mintFeeBpsDelta: 0,
        hedgeReductionBps: parameters.haltHedgeReductionBps,
        redeemIncentiveBps: parameters.haltRedeemIncentiveBps,
        disclosureRequired: true,
        stakerRewardIndexFloorAtZero: true,
        stakerNavSubordinated: false,
        governanceDecisionPoint: true,
        reintroducesDirectionalExposure: true,
      });
    case "backing_only":
      return finalize({
        stage: resolved,
        legacyStage,
        regime: "Backing only",
        actions: [
          "The buffer is exhausted. Staked holders are subordinated and their NAV declines first.",
          "Honor redemption at the oracle NAV of the remaining collateral, which can be below one dollar.",
          "Disclose the impairment, its size and its cause in full.",
          "This is the failure mode. It is stated plainly rather than hidden.",
        ],
        pauseMint: true,
        mintFeeBpsDelta: 0,
        hedgeReductionBps: parameters.haltHedgeReductionBps,
        redeemIncentiveBps: 0,
        disclosureRequired: true,
        stakerRewardIndexFloorAtZero: false,
        stakerNavSubordinated: true,
        governanceDecisionPoint: true,
        reintroducesDirectionalExposure: true,
      });
  }
}

type PlaybookStepCore = Omit<PlaybookStep, "restrictIssuance" | "reduceHedgeNotional">;

/**
 * Derive the two deprecated booleans from the machine-readable knobs, so they
 * can never disagree with them.
 */
function finalize(core: PlaybookStepCore): PlaybookStep {
  return {
    ...core,
    restrictIssuance: core.pauseMint || core.mintFeeBpsDelta > 0,
    reduceHedgeNotional: core.hedgeReductionBps > 0,
  };
}

/** The full playbook, most severe first. Useful for rendering the escalation ladder. */
export function negativeFundingPlaybookLadder(
  parameters: PlaybookActionParameters = DEFAULT_PLAYBOOK_ACTION_PARAMETERS,
): readonly PlaybookStep[] {
  return BUFFER_STAGE_ORDER.map((stage) => negativeFundingPlaybook(stage, parameters));
}
