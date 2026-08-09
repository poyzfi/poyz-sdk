/**
 * @poyz/risk-buffer
 *
 * Insurance buffer accounting and the negative-funding playbook for the POYZ
 * synthetic dollar.
 *
 * Carry accrues to the short leg some of the time and is paid by it the rest of
 * the time. On the venue's own aggregates for SOL-PERP, measured 2026-08-09,
 * three of four windows are negative -- including the one-year average at about
 * -35.8% APR (`scenarios.ts`, `_DIRECTION.md` 8-1). **A delta-neutral book on
 * this venue pays carry today.** Negative carry is the current regime and the
 * default case this package is written around, not an edge case bolted onto a
 * positive one.
 *
 * In that regime the outflow has to come from somewhere. The buffer is that
 * somewhere, and it is a buffer, not a promise: no buffer outlasts an indefinite
 * negative regime, and at the target 3% it covers about a month at the measured
 * one-year rate. What the buffer buys is time to deleverage. The structural
 * answer is `carry-gate.ts`, which refuses new mint below the floor.
 *
 * Scope: types and pure calculations only. No network calls, no clock reads, no
 * transfers, no governance actions. Every function here is deterministic and
 * takes the current time as an argument when it needs one, so the same input
 * always produces the same output and `apps/service` can call it inside a
 * request handler without side effects.
 *
 * Reference documents, and the sections each module reproduces:
 *
 * | module | reproduces |
 * |---|---|
 * | `units.ts` | `_DIRECTION.md` 8-1 interval and annualization math (`* 24 * 365.25`) |
 * | `accounting.ts` | `risk-spec.md` 6, `architecture.md` 11 buffer flows and target |
 * | `depletion.ts` | `risk-spec.md` 1.2 and 1.3 runway |
 * | `wipeout.ts` | `risk-spec.md` 1.5 ordering of carry loss before backing loss |
 * | `playbook.ts` | `risk-spec.md` 1.5 five-stage playbook |
 * | `scenarios.ts` | `risk-spec.md` 1.3 stress table plus the `_DIRECTION.md` 8-1 measured regimes |
 * | `carry-gate.ts` | `_DIRECTION.md` 8-1 decision 3, `risk-spec.md` 1.4 mint gate |
 */

export {
  DAYS_PER_YEAR,
  HOURS_PER_DAY,
  HOURS_PER_EIGHT_HOUR_INTERVAL,
  HOURS_PER_YEAR,
  HOURS_PER_YEAR_JULIAN,
  MS_PER_DAY,
  ONE_BPS,
  annualToHourlyRate,
  assertFinite,
  assertFiniteNonNegative,
  bpsToFraction,
  bufferRunwayDays,
  dailyToAnnualRate,
  fractionToBps,
  hourlyToAnnualRate,
  hourlyToDailyRate,
  perEightHourToHourlyRate,
} from "./units.js";

export {
  DEFAULT_BUFFER_TARGET_BPS,
  ETHENA_ANCHOR_BUFFER_BPS,
  ZERO_BUFFER_INFLOWS,
  ZERO_BUFFER_OUTFLOWS,
  applyBufferFlows,
  bufferNetFlowUsd,
  bufferStateFromBps,
  bufferTargetUsd,
  canDrawFromBuffer,
  coverageFractionOfTarget,
  coverageRatio,
  coverageShortfallUsd,
  dailyFeeAccrualUsd,
  feeUsd,
  topUpToTargetUsd,
  totalInflowUsd,
  totalOutflowUsd,
  type BufferDrawDecision,
  type BufferDrawPurpose,
  type BufferDrawRequest,
  type BufferFlowResult,
  type BufferInflows,
  type BufferOutflows,
  type BufferState,
} from "./accounting.js";

export {
  estimateBufferDepletion,
  projectBufferDepletion,
  requiredTopUpUsd,
  type BufferDepletionEstimate,
  type BufferDepletionInput,
  type BufferProjection,
  type NegativeFundingScenario,
} from "./depletion.js";

export {
  timeToYieldWipeout,
  type WipeoutEvent,
  type YieldWipeoutEstimate,
  type YieldWipeoutInput,
} from "./wipeout.js";

export {
  BUFFER_STAGE_ORDER,
  DEFAULT_BUFFER_STAGE_HYSTERESIS,
  DEFAULT_PLAYBOOK_ACTION_PARAMETERS,
  DEFAULT_PLAYBOOK_THRESHOLDS,
  bufferStageSeverityRank,
  bufferStageUpperBound,
  negativeFundingPlaybook,
  negativeFundingPlaybookLadder,
  nextStage,
  selectBufferStage,
  selectPlaybookStage,
  toBufferStage,
  type BufferStage,
  type BufferStageHysteresis,
  type LegacyPlaybookStage,
  type PlaybookActionParameters,
  type PlaybookStage,
  type PlaybookStep,
  type PlaybookThresholds,
} from "./playbook.js";

export {
  BASELINE_CARRY_REGIME,
  BEAR_MARKET_PER_EIGHT_HOUR_RATE,
  BUFFER_SIZE_SCENARIOS,
  FTX_NEGATIVE_FUNDING_EPISODE_DAYS,
  FUNDING_STRESS_SCENARIOS,
  MEASURED_CARRY_REGIMES,
  MEASURED_CARRY_RUNWAY_TABLE,
  RISK_SPEC_RUNWAY_TABLE,
  SOL_PERP_FUNDING_SNAPSHOT_2026_08_09,
  SOL_PROXY_ASSUMPTION,
  TIER_B_DAILY_FUNDING_CAP,
  TIER_B_HOURLY_FUNDING_CAP,
  buildRunwayTable,
  carryRegimeAsStressScenario,
  type BufferSizeScenario,
  type FundingStressScenario,
  type MeasuredCarryRegime,
  type RunwayTableCell,
} from "./scenarios.js";

export {
  DEFAULT_CARRY_GATE_CONFIG,
  carryFloorAnnualRate,
  carryFloorDailyRate,
  carryGateAllowsMintBps,
  carryObservationToDailyRate,
  carryRateToDailyBps,
  evaluateCarryGate,
  type CarryGateConfig,
  type CarryGateDecision,
  type CarryGateEvaluation,
  type CarryGateInput,
  type CarryGateReason,
  type CarryObservation,
} from "./carry-gate.js";
