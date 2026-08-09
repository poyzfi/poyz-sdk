import { describe, expect, it } from "vitest";

import {
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
  type BufferState,
} from "./accounting.js";

const SUPPLY_USD = 100_000_000;

describe("buffer target", () => {
  it("defaults to 300 bps of supply, the risk-spec 6 target", () => {
    expect(DEFAULT_BUFFER_TARGET_BPS).toBe(300);
    const state = bufferStateFromBps(0, SUPPLY_USD);
    expect(state.targetCoverageRatio).toBeCloseTo(0.03, 12);
    expect(bufferTargetUsd(state)).toBeCloseTo(3_000_000, 6);
  });

  it("keeps the Ethena anchor of 170 bps as a separate comparison point", () => {
    expect(ETHENA_ANCHOR_BUFFER_BPS).toBe(170);
    expect(ETHENA_ANCHOR_BUFFER_BPS).toBeLessThan(DEFAULT_BUFFER_TARGET_BPS);
  });
});

describe("coverage", () => {
  const state = bufferStateFromBps(1_700_000, SUPPLY_USD, DEFAULT_BUFFER_TARGET_BPS);

  it("reports coverage of supply and coverage of target separately", () => {
    expect(coverageRatio(state)).toBeCloseTo(0.017, 12);
    expect(coverageFractionOfTarget(state)).toBeCloseTo(0.566_666_7, 6);
  });

  it("reports the shortfall to target in USD", () => {
    expect(coverageShortfallUsd(state)).toBeCloseTo(1_300_000, 6);
    expect(topUpToTargetUsd(state)).toBeCloseTo(1_300_000, 6);
  });

  it("reports a surplus as a negative shortfall and no top-up", () => {
    const funded = bufferStateFromBps(4_000_000, SUPPLY_USD);
    expect(coverageShortfallUsd(funded)).toBeCloseTo(-1_000_000, 6);
    expect(topUpToTargetUsd(funded)).toBe(0);
  });

  it("returns null coverage of target when there is no target to measure against", () => {
    expect(coverageFractionOfTarget(bufferStateFromBps(1_000, SUPPLY_USD, 0))).toBeNull();
    expect(coverageFractionOfTarget(bufferStateFromBps(1_000, 0, 300))).toBeNull();
  });

  it("special-cases coverage of supply when nothing is outstanding", () => {
    expect(coverageRatio(bufferStateFromBps(1_000, 0))).toBe(Number.POSITIVE_INFINITY);
    expect(coverageRatio(bufferStateFromBps(0, 0))).toBe(1);
  });
});

describe("buffer flows", () => {
  const state = bufferStateFromBps(1_000_000, SUPPLY_USD);

  it("nets fees, slashings and the retained carry share against covered losses", () => {
    const netFlowUsd = bufferNetFlowUsd(
      {
        mintFeesUsd: 40_000,
        redeemFeesUsd: 15_000,
        keeperSlashingsUsd: 5_000,
        positiveCarryShareUsd: 20_000,
      },
      {
        negativeCarryCoveredUsd: 30_000,
        unwindSlippageCoveredUsd: 10_000,
        adlLossCoveredUsd: 0,
      },
    );
    expect(netFlowUsd).toBeCloseTo(40_000, 6);
  });

  it("applies a net inflow to the balance", () => {
    const result = applyBufferFlows(
      state,
      { ...ZERO_BUFFER_INFLOWS, mintFeesUsd: 50_000 },
      ZERO_BUFFER_OUTFLOWS,
    );
    expect(result.state.balanceUsd).toBeCloseTo(1_050_000, 6);
    expect(result.uncoveredUsd).toBe(0);
  });

  it("floors the balance at zero and reports the loss that reaches backing", () => {
    // An ADL event larger than the buffer. risk-spec 2.2 sizes this at several
    // percent of notional, which is exactly the case a 1% buffer does not cover.
    const result = applyBufferFlows(state, ZERO_BUFFER_INFLOWS, {
      ...ZERO_BUFFER_OUTFLOWS,
      adlLossCoveredUsd: 3_000_000,
    });
    expect(result.state.balanceUsd).toBe(0);
    expect(result.netFlowUsd).toBeCloseTo(-3_000_000, 6);
    expect(result.uncoveredUsd).toBeCloseTo(2_000_000, 6);
  });

  it("carries supply and target through unchanged", () => {
    const result = applyBufferFlows(state, ZERO_BUFFER_INFLOWS, ZERO_BUFFER_OUTFLOWS);
    expect(result.state.coveredSupplyUsd).toBe(state.coveredSupplyUsd);
    expect(result.state.targetCoverageRatio).toBe(state.targetCoverageRatio);
  });

  it("does not mutate the state it is given", () => {
    const snapshot: BufferState = { ...state };
    applyBufferFlows(state, { ...ZERO_BUFFER_INFLOWS, mintFeesUsd: 1 }, ZERO_BUFFER_OUTFLOWS);
    expect(state).toEqual(snapshot);
  });
});

describe("fee accrual", () => {
  it("computes a bps fee on a notional", () => {
    expect(feeUsd(1_000_000, 10)).toBeCloseTo(1_000, 9);
  });

  it("sums the daily mint and redeem fee income", () => {
    // 2M minted at 10 bps plus 1M redeemed at 15 bps.
    expect(dailyFeeAccrualUsd(2_000_000, 10, 1_000_000, 15)).toBeCloseTo(3_500, 6);
  });

  it("shows when fee income does not outrun a negative funding bleed", () => {
    // 30,000/day of bleed against 3,500/day of fees: the buffer still drains.
    expect(dailyFeeAccrualUsd(2_000_000, 10, 1_000_000, 15)).toBeLessThan(30_000);
  });
});

describe("draw conditions link the ledger to the playbook triggers", () => {
  const state = bufferStateFromBps(1_000_000, SUPPLY_USD);

  it("funds first-loss purposes at every stage", () => {
    for (const stage of ["healthy", "draining", "reduce", "halt_unwind"] as const) {
      const decision = canDrawFromBuffer(
        state,
        { amountUsd: 100_000, purpose: "negative_carry" },
        stage,
      );
      expect(decision.allowed).toBe(true);
      expect(decision.allowedAmountUsd).toBeCloseTo(100_000, 6);
    }
  });

  it("funds a first-loss draw only up to the balance and names the residual", () => {
    const decision = canDrawFromBuffer(
      state,
      { amountUsd: 2_500_000, purpose: "adl_loss" },
      "reduce",
    );
    expect(decision.allowedAmountUsd).toBeCloseTo(1_000_000, 6);
    expect(decision.deniedAmountUsd).toBeCloseTo(1_500_000, 6);
    expect(decision.reason).toContain("backing and staker NAV");
  });

  it("blocks every draw once the buffer is exhausted", () => {
    const empty = bufferStateFromBps(0, SUPPLY_USD);
    const decision = canDrawFromBuffer(
      empty,
      { amountUsd: 1, purpose: "negative_carry" },
      "backing_only",
    );
    expect(decision.allowed).toBe(false);
    expect(decision.allowedAmountUsd).toBe(0);
  });

  it("funds a hedge margin top-up while any balance remains", () => {
    const decision = canDrawFromBuffer(
      state,
      { amountUsd: 200_000, purpose: "hedge_margin_topup" },
      "halt_unwind",
    );
    expect(decision.allowed).toBe(true);
  });

  it("blocks a discretionary draw below the healthy trigger", () => {
    const decision = canDrawFromBuffer(
      state,
      { amountUsd: 1, purpose: "discretionary" },
      "draining",
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("healthy trigger");
  });

  it("blocks a discretionary draw that would take the buffer below target", () => {
    const atTarget = bufferStateFromBps(3_000_000, SUPPLY_USD);
    expect(
      canDrawFromBuffer(atTarget, { amountUsd: 1, purpose: "discretionary" }, "healthy").allowed,
    ).toBe(false);

    const surplus = bufferStateFromBps(3_500_000, SUPPLY_USD);
    const decision = canDrawFromBuffer(
      surplus,
      { amountUsd: 800_000, purpose: "discretionary" },
      "healthy",
    );
    expect(decision.allowed).toBe(true);
    expect(decision.allowedAmountUsd).toBeCloseTo(500_000, 6);
    expect(decision.deniedAmountUsd).toBeCloseTo(300_000, 6);
  });
});
