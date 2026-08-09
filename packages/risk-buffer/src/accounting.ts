/**
 * Risk-buffer accounting.
 *
 * The buffer is a program-owned vault that absorbs first losses before
 * collateral backing is touched (`architecture.md` 11). Money flows **in** from
 * `mint_fee_bps`, `redeem_fee_bps`, keeper slashings and a retained share of
 * positive-carry epochs; it flows **out** to cover negative carry, residual
 * unwind slippage and auto-deleverage losses (`risk-spec.md` 6, `hedge-spec.md`
 * 6).
 *
 * Two accounting facts drive everything downstream:
 *
 * 1. The buffer cannot go negative. When an outflow exceeds the balance, the
 *    residual does not vanish, it reaches backing and staker NAV. This module
 *    reports that residual as `uncoveredUsd` instead of clamping it away
 *    silently.
 * 2. Buffer health is measured against `buffer_target_bps`, not against supply.
 *    `risk-spec.md` 1.5 triggers on the fraction of target.
 */

import type { BufferStage } from "./playbook.js";
import { assertFinite, assertFiniteNonNegative, bpsToFraction } from "./units.js";

/**
 * `[ASSUMPTION]` Target buffer size, 300 bps of supply (`risk-spec.md` 6).
 *
 * Chosen above Ethena's empirical level because the auto-deleverage tail
 * (`risk-spec.md` 2.2) can consume several percent of notional in a single
 * event. It is a starting target to be re-derived from live funding data, not a
 * proven safe level.
 */
export const DEFAULT_BUFFER_TARGET_BPS = 300;

/**
 * Ethena's empirical first-loss buffer, about 1.7% of supply as of June 2026
 * (`research-notes.md` 4). Kept as the comparison anchor for the
 * `risk-spec.md` 1.4 runway table, not as a recommendation.
 */
export const ETHENA_ANCHOR_BUFFER_BPS = 170;

/** Current state of the insurance buffer. */
export interface BufferState {
  /** Assets held in the buffer, in USD. */
  readonly balanceUsd: number;
  /** Synthetic dollar supply the buffer stands behind, in USD. */
  readonly coveredSupplyUsd: number;
  /** Target buffer balance as a share of covered supply, 0..1. */
  readonly targetCoverageRatio: number;
}

/** Build a `BufferState` from a `buffer_target_bps` style parameter. */
export function bufferStateFromBps(
  balanceUsd: number,
  coveredSupplyUsd: number,
  targetBps: number = DEFAULT_BUFFER_TARGET_BPS,
): BufferState {
  assertFiniteNonNegative(balanceUsd, "balanceUsd");
  assertFiniteNonNegative(coveredSupplyUsd, "coveredSupplyUsd");
  assertFiniteNonNegative(targetBps, "targetBps");
  return {
    balanceUsd,
    coveredSupplyUsd,
    targetCoverageRatio: bpsToFraction(targetBps),
  };
}

/**
 * Buffer balance as a share of the supply it covers.
 *
 * Returns `Infinity` when there is a balance but nothing outstanding to cover,
 * and `1` when both are zero. Callers rendering this to a UI should special-case
 * the non-finite result rather than printing it.
 */
export function coverageRatio(state: BufferState): number {
  assertFiniteNonNegative(state.balanceUsd, "balanceUsd");
  assertFiniteNonNegative(state.coveredSupplyUsd, "coveredSupplyUsd");
  if (state.coveredSupplyUsd === 0) {
    return state.balanceUsd > 0 ? Number.POSITIVE_INFINITY : 1;
  }
  return state.balanceUsd / state.coveredSupplyUsd;
}

/** Target buffer balance in USD: `coveredSupplyUsd * targetCoverageRatio`. */
export function bufferTargetUsd(state: BufferState): number {
  assertFiniteNonNegative(state.coveredSupplyUsd, "coveredSupplyUsd");
  assertFiniteNonNegative(state.targetCoverageRatio, "targetCoverageRatio");
  return state.coveredSupplyUsd * state.targetCoverageRatio;
}

/** How far the buffer is from its target balance, in USD. Negative means a surplus. */
export function coverageShortfallUsd(state: BufferState): number {
  assertFiniteNonNegative(state.targetCoverageRatio, "targetCoverageRatio");
  const targetBalanceUsd = state.coveredSupplyUsd * state.targetCoverageRatio;
  return targetBalanceUsd - state.balanceUsd;
}

/**
 * Buffer balance as a fraction of its target. `1` is exactly on target.
 *
 * This is the quantity the `risk-spec.md` 1.5 stage triggers are written
 * against.
 *
 * Returns `null` when the target is zero or the covered supply is zero, because
 * "fraction of target" has no value there. That is an insufficient-data signal:
 * render nothing rather than a placeholder number.
 */
export function coverageFractionOfTarget(state: BufferState): number | null {
  assertFiniteNonNegative(state.balanceUsd, "balanceUsd");
  const targetUsd = bufferTargetUsd(state);
  if (!(targetUsd > 0)) {
    return null;
  }
  return state.balanceUsd / targetUsd;
}

/**
 * Money into the buffer over an epoch, in USD (`risk-spec.md` 6,
 * `architecture.md` 11).
 */
export interface BufferInflows {
  /** `mint_fee_bps` collected on new issuance. */
  readonly mintFeesUsd: number;
  /** `redeem_fee_bps` collected on redemption. */
  readonly redeemFeesUsd: number;
  /** Keeper bonds slashed for missed or bad rebalances. */
  readonly keeperSlashingsUsd: number;
  /** Retained share of positive-carry epochs, the portion not passed to stakers. */
  readonly positiveCarryShareUsd: number;
}

/** Money out of the buffer over an epoch, in USD (`risk-spec.md` 1.5, 2.2, 4.2). */
export interface BufferOutflows {
  /** Negative carry covered so the reward index floors at zero instead of going negative. */
  readonly negativeCarryCoveredUsd: number;
  /** Unwind slippage beyond what `redeem_fee_bps` priced in. */
  readonly unwindSlippageCoveredUsd: number;
  /** Losses from an auto-deleveraged hedge leg and the re-hedge at the new price. */
  readonly adlLossCoveredUsd: number;
}

export const ZERO_BUFFER_INFLOWS: BufferInflows = {
  mintFeesUsd: 0,
  redeemFeesUsd: 0,
  keeperSlashingsUsd: 0,
  positiveCarryShareUsd: 0,
};

export const ZERO_BUFFER_OUTFLOWS: BufferOutflows = {
  negativeCarryCoveredUsd: 0,
  unwindSlippageCoveredUsd: 0,
  adlLossCoveredUsd: 0,
};

/** Fee in USD on a notional amount at a basis-point rate. */
export function feeUsd(notionalUsd: number, bps: number): number {
  assertFiniteNonNegative(notionalUsd, "notionalUsd");
  assertFiniteNonNegative(bps, "bps");
  return notionalUsd * bpsToFraction(bps);
}

export function totalInflowUsd(inflows: BufferInflows): number {
  assertFiniteNonNegative(inflows.mintFeesUsd, "mintFeesUsd");
  assertFiniteNonNegative(inflows.redeemFeesUsd, "redeemFeesUsd");
  assertFiniteNonNegative(inflows.keeperSlashingsUsd, "keeperSlashingsUsd");
  assertFiniteNonNegative(inflows.positiveCarryShareUsd, "positiveCarryShareUsd");
  return (
    inflows.mintFeesUsd +
    inflows.redeemFeesUsd +
    inflows.keeperSlashingsUsd +
    inflows.positiveCarryShareUsd
  );
}

export function totalOutflowUsd(outflows: BufferOutflows): number {
  assertFiniteNonNegative(outflows.negativeCarryCoveredUsd, "negativeCarryCoveredUsd");
  assertFiniteNonNegative(outflows.unwindSlippageCoveredUsd, "unwindSlippageCoveredUsd");
  assertFiniteNonNegative(outflows.adlLossCoveredUsd, "adlLossCoveredUsd");
  return (
    outflows.negativeCarryCoveredUsd +
    outflows.unwindSlippageCoveredUsd +
    outflows.adlLossCoveredUsd
  );
}

/** Signed net flow for an epoch. Positive grows the buffer. */
export function bufferNetFlowUsd(inflows: BufferInflows, outflows: BufferOutflows): number {
  return totalInflowUsd(inflows) - totalOutflowUsd(outflows);
}

export interface BufferFlowResult {
  /** Buffer state after the epoch. The balance is floored at zero. */
  readonly state: BufferState;
  /** Signed net flow applied, USD. */
  readonly netFlowUsd: number;
  /**
   * Outflow the buffer could not cover, USD.
   *
   * This is not a rounding artifact. It is the amount that reaches backing and
   * staker NAV, which is the `backing_only` failure mode of `risk-spec.md` 1.5.
   * Surface it; do not discard it.
   */
  readonly uncoveredUsd: number;
}

/**
 * Apply one epoch of flows to the buffer.
 *
 * `coveredSupplyUsd` and `targetCoverageRatio` are carried through unchanged;
 * supply moves through mint and redeem, which is not this function's business.
 */
export function applyBufferFlows(
  state: BufferState,
  inflows: BufferInflows,
  outflows: BufferOutflows,
): BufferFlowResult {
  assertFiniteNonNegative(state.balanceUsd, "balanceUsd");
  const netFlowUsd = bufferNetFlowUsd(inflows, outflows);
  const rawBalance = state.balanceUsd + netFlowUsd;
  const balanceUsd = Math.max(0, rawBalance);
  return {
    state: { ...state, balanceUsd },
    netFlowUsd,
    uncoveredUsd: rawBalance < 0 ? -rawBalance : 0,
  };
}

/** Why the buffer is being drawn on. */
export type BufferDrawPurpose =
  /** Negative funding carry for the epoch (`risk-spec.md` 1.5). */
  | "negative_carry"
  /** Residual unwind slippage beyond the redeem fee (`risk-spec.md` 4.2). */
  | "unwind_slippage"
  /** Auto-deleverage loss and the emergency re-hedge (`risk-spec.md` 2.2). */
  | "adl_loss"
  /** Standby margin so the short can be reopened or topped up (`risk-spec.md` 3). */
  | "hedge_margin_topup"
  /** Anything else. Not a first-loss purpose. */
  | "discretionary";

export interface BufferDrawRequest {
  readonly amountUsd: number;
  readonly purpose: BufferDrawPurpose;
}

export interface BufferDrawDecision {
  readonly allowed: boolean;
  /** How much of the request the buffer may fund, USD. Zero when not allowed. */
  readonly allowedAmountUsd: number;
  /** The part of the request the buffer will not fund, USD. */
  readonly deniedAmountUsd: number;
  /** Why, in the words the status API and risk page can use verbatim. */
  readonly reason: string;
}

const FIRST_LOSS_PURPOSES: ReadonlySet<BufferDrawPurpose> = new Set<BufferDrawPurpose>([
  "negative_carry",
  "unwind_slippage",
  "adl_loss",
]);

/**
 * Whether the buffer may fund a draw, given the stage it is in.
 *
 * This is where the playbook triggers meet the ledger. First-loss purposes are
 * exactly what the buffer exists for and are funded at every stage up to the
 * available balance. Hedge margin top-ups are funded until the buffer is empty,
 * because losing the hedge during a rally is worse than spending the last of the
 * buffer (`risk-spec.md` 3). Discretionary draws are funded only while the
 * buffer is `healthy`, and only down to target, so the buffer cannot be quietly
 * drained ahead of a stress event (`architecture.md` 11).
 */
export function canDrawFromBuffer(
  state: BufferState,
  request: BufferDrawRequest,
  stage: BufferStage,
): BufferDrawDecision {
  assertFiniteNonNegative(request.amountUsd, "amountUsd");
  assertFiniteNonNegative(state.balanceUsd, "balanceUsd");

  const deny = (reason: string): BufferDrawDecision => ({
    allowed: false,
    allowedAmountUsd: 0,
    deniedAmountUsd: request.amountUsd,
    reason,
  });

  const grant = (amountUsd: number, reason: string): BufferDrawDecision => ({
    allowed: amountUsd > 0,
    allowedAmountUsd: amountUsd,
    deniedAmountUsd: request.amountUsd - amountUsd,
    reason,
  });

  if (state.balanceUsd <= 0) {
    return deny(
      "Buffer is exhausted. The loss passes through to backing and staker NAV; see the backing-only stage.",
    );
  }

  if (FIRST_LOSS_PURPOSES.has(request.purpose)) {
    const amount = Math.min(request.amountUsd, state.balanceUsd);
    return grant(
      amount,
      amount < request.amountUsd
        ? "Funded up to the available balance. The remainder passes through to backing and staker NAV."
        : "First-loss draw. This is what the buffer is held for.",
    );
  }

  if (request.purpose === "hedge_margin_topup") {
    const amount = Math.min(request.amountUsd, state.balanceUsd);
    return grant(
      amount,
      amount < request.amountUsd
        ? "Funded up to the available balance. Margin short of this leaves the hedge exposed to liquidation."
        : "Margin top-up keeps the short open; losing the hedge costs more than the draw.",
    );
  }

  if (stage !== "healthy") {
    return deny(
      "Discretionary draws are blocked while the buffer is below the healthy trigger.",
    );
  }

  const surplusUsd = state.balanceUsd - bufferTargetUsd(state);
  if (surplusUsd <= 0) {
    return deny("Discretionary draws are blocked while the buffer is at or below target.");
  }
  const amount = Math.min(request.amountUsd, surplusUsd);
  return grant(
    amount,
    amount < request.amountUsd
      ? "Funded from the surplus above target only."
      : "Funded from the surplus above target.",
  );
}

/**
 * Buffer contribution needed to bring the balance back to target, in USD.
 * Zero when the buffer is at or above target.
 */
export function topUpToTargetUsd(state: BufferState): number {
  return Math.max(0, coverageShortfallUsd(state));
}

/**
 * Rate at which fees refill the buffer, in USD per day, given daily mint and
 * redeem volume. Useful for asking whether fee income outruns the bleed.
 */
export function dailyFeeAccrualUsd(
  dailyMintVolumeUsd: number,
  mintFeeBps: number,
  dailyRedeemVolumeUsd: number,
  redeemFeeBps: number,
): number {
  assertFinite(dailyMintVolumeUsd, "dailyMintVolumeUsd");
  assertFinite(dailyRedeemVolumeUsd, "dailyRedeemVolumeUsd");
  return feeUsd(dailyMintVolumeUsd, mintFeeBps) + feeUsd(dailyRedeemVolumeUsd, redeemFeeBps);
}
