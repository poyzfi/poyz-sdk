/**
 * Funding simulation.
 *
 * Answers a bounded question: hold this notional for this many days at this
 * funding rate, and what happens -- including when the rate is negative and the
 * position pays instead of earning. Nothing here is a forecast. The rate is an
 * input the caller supplies, and the result carries a disclaimer that travels
 * with it so a UI cannot present the output as a projection of what will happen.
 *
 * The buffer arithmetic is not reimplemented: it calls
 * `packages/risk-buffer`, which is the single definition of buffer runway and
 * of the negative funding playbook. That package is compiled into this bundle,
 * so `@poyz/sdk` has no `@poyz/*` runtime dependency.
 */

import {
  DEFAULT_PLAYBOOK_THRESHOLDS,
  negativeFundingPlaybook,
  projectBufferDepletion,
  selectPlaybookStage,
} from "@poyz/risk-buffer";

const DAYS_PER_YEAR = 365;

/** Defensive posture implied by a scenario. Mirrors the risk-buffer stages. */
export type PoyzPlaybookStage = "nominal" | "watch" | "throttle" | "unwind";

export interface FundingScenarioInput {
  /**
   * Annualized funding rate accruing to the short side, as a decimal.
   * Negative means the protocol pays. `-0.15` is 15 percent per year paid out.
   */
  readonly annualizedRate: number;
  /** Insurance buffer balance, USD. Omit to skip the buffer projection. */
  readonly bufferBalanceUsd?: number;
  /** Synthetic dollar supply the buffer stands behind, USD. */
  readonly coveredSupplyUsd?: number;
  /** Fixed operating drain per day, USD. */
  readonly dailyOperatingCostUsd?: number;
}

export interface FundingSimulationInput {
  /** Notional held, USD. */
  readonly amountUsd: number;
  /** Holding period in days. */
  readonly days: number;
  readonly fundingScenario: FundingScenarioInput;
  /** Clock reading for the projection. Defaults to now. */
  readonly nowMs?: number;
}

export interface FundingBufferProjection {
  readonly coverageRatio: number;
  readonly dailyNetFlowUsd: number;
  readonly dailyDrainUsd: number;
  readonly daysToDepletion: number | null;
  readonly depletesAtMs: number | null;
  readonly stage: PoyzPlaybookStage;
  readonly actions: readonly string[];
  readonly restrictIssuance: boolean;
  readonly reduceHedgeNotional: boolean;
  /** True when the buffer runs out inside the simulated holding period. */
  readonly depletesWithinPeriod: boolean;
}

export interface FundingSimulationResult {
  readonly amountUsd: number;
  readonly days: number;
  readonly annualizedRate: number;
  /** Funding over the period, USD. Negative when the position pays. */
  readonly grossFundingUsd: number;
  readonly dailyFundingUsd: number;
  /** Notional plus accrued funding at the end of the period, USD. */
  readonly endingValueUsd: number;
  /** Period return on the notional, as a decimal. */
  readonly periodReturn: number;
  readonly isNegativeRegime: boolean;
  /** Null when no buffer balance was supplied. */
  readonly buffer: FundingBufferProjection | null;
  readonly disclaimer: string;
}

export const FUNDING_SIMULATION_DISCLAIMER =
  "Scenario arithmetic, not a projection. The rate is an input held flat for the whole period, which " +
  "real funding does not do: it is a market rate that moves and can stay negative, in which case the " +
  "position pays funding and the buffer is drawn down. Venue failure, liquidation and hedge slippage " +
  "are not modelled here.";

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number`);
  }
}

function assertPositive(value: number, label: string): void {
  assertFinite(value, label);
  if (value <= 0) {
    throw new RangeError(`${label} must be greater than zero`);
  }
}

function assertNonNegative(value: number, label: string): void {
  assertFinite(value, label);
  if (value < 0) {
    throw new RangeError(`${label} must be greater than or equal to zero`);
  }
}

/**
 * Run a funding scenario.
 *
 * Funding is accrued simply, not compounded: it is settled and swept rather
 * than reinvested into the same position, so compounding it would overstate the
 * result.
 *
 * @throws RangeError on a malformed input.
 */
export function simulateFunding(input: FundingSimulationInput): FundingSimulationResult {
  assertNonNegative(input.amountUsd, "amountUsd");
  assertPositive(input.days, "days");
  assertFinite(input.fundingScenario.annualizedRate, "annualizedRate");

  const rate = input.fundingScenario.annualizedRate;
  const dailyFundingUsd = (rate * input.amountUsd) / DAYS_PER_YEAR;
  const grossFundingUsd = dailyFundingUsd * input.days;

  const bufferBalanceUsd = input.fundingScenario.bufferBalanceUsd;
  let buffer: FundingBufferProjection | null = null;

  if (bufferBalanceUsd !== undefined) {
    assertNonNegative(bufferBalanceUsd, "bufferBalanceUsd");
    const coveredSupplyUsd = input.fundingScenario.coveredSupplyUsd ?? input.amountUsd;
    assertNonNegative(coveredSupplyUsd, "coveredSupplyUsd");
    const dailyOperatingCostUsd = input.fundingScenario.dailyOperatingCostUsd ?? 0;
    assertNonNegative(dailyOperatingCostUsd, "dailyOperatingCostUsd");
    const nowMs = input.nowMs ?? Date.now();

    const state = {
      balanceUsd: bufferBalanceUsd,
      coveredSupplyUsd,
      targetCoverageRatio: DEFAULT_PLAYBOOK_THRESHOLDS.watchCoverageRatio,
    };
    const projection = projectBufferDepletion(
      state,
      {
        annualizedFundingRate: rate,
        hedgedNotionalUsd: input.amountUsd,
        dailyOperatingCostUsd,
      },
      nowMs,
    );
    const stage = selectPlaybookStage(projection);
    const step = negativeFundingPlaybook(stage);

    buffer = {
      coverageRatio: projection.coverageRatio,
      dailyNetFlowUsd: projection.dailyNetFlowUsd,
      dailyDrainUsd: projection.dailyDrainUsd,
      daysToDepletion: projection.daysToDepletion,
      depletesAtMs: projection.depletesAtMs,
      stage,
      actions: step.actions,
      restrictIssuance: step.restrictIssuance,
      reduceHedgeNotional: step.reduceHedgeNotional,
      depletesWithinPeriod:
        projection.daysToDepletion !== null && projection.daysToDepletion <= input.days,
    };
  }

  return {
    amountUsd: input.amountUsd,
    days: input.days,
    annualizedRate: rate,
    grossFundingUsd,
    dailyFundingUsd,
    endingValueUsd: input.amountUsd + grossFundingUsd,
    periodReturn: input.amountUsd > 0 ? grossFundingUsd / input.amountUsd : 0,
    isNegativeRegime: rate < 0,
    buffer,
    disclaimer: FUNDING_SIMULATION_DISCLAIMER,
  };
}
