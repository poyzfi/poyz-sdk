import { describe, expect, it } from "vitest";

import {
  BUFFER_STAGE_ORDER,
  DEFAULT_BUFFER_STAGE_HYSTERESIS,
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
  type PlaybookThresholds,
} from "./playbook.js";

describe("five-stage playbook boundaries (risk-spec 1.5)", () => {
  it("orders the stages worst first", () => {
    expect(BUFFER_STAGE_ORDER).toEqual([
      "backing_only",
      "halt_unwind",
      "reduce",
      "draining",
      "healthy",
    ]);
    expect(bufferStageSeverityRank("backing_only")).toBe(0);
    expect(bufferStageSeverityRank("healthy")).toBe(4);
  });

  it("defaults the triggers to 75 / 50 / 25 / 0 percent of target", () => {
    expect(DEFAULT_PLAYBOOK_THRESHOLDS.healthyFractionOfTarget).toBe(0.75);
    expect(DEFAULT_PLAYBOOK_THRESHOLDS.drainingFractionOfTarget).toBe(0.5);
    expect(DEFAULT_PLAYBOOK_THRESHOLDS.reduceFractionOfTarget).toBe(0.25);
    expect(DEFAULT_PLAYBOOK_THRESHOLDS.backingOnlyFractionOfTarget).toBe(0);
  });

  it("puts a comfortably funded buffer in healthy", () => {
    expect(selectBufferStage(1.2)).toBe("healthy");
    expect(selectBufferStage(1)).toBe("healthy");
    expect(selectBufferStage(0.9)).toBe("healthy");
  });

  // Exactly 75%. risk-spec 1.5 writes healthy as "> 75%", so 75% is not healthy
  // and the "50-75%" band claims it.
  it("puts exactly 75.0% of target in draining, not healthy", () => {
    expect(selectBufferStage(0.75)).toBe("draining");
    expect(selectBufferStage(0.7501)).toBe("healthy");
    expect(selectBufferStage(0.7499)).toBe("draining");
  });

  // Exactly 50%. The spec writes both "50-75%" and "25-50%" inclusively, so 50%
  // is genuinely ambiguous. The tie goes to the more defensive stage.
  it("puts exactly 50.0% of target in reduce, the more defensive of the two bands that claim it", () => {
    expect(selectBufferStage(0.5)).toBe("reduce");
    expect(selectBufferStage(0.5001)).toBe("draining");
    expect(selectBufferStage(0.4999)).toBe("reduce");
  });

  // Exactly 25%. The spec writes halt as "< 25%" and reduce as "25-50%", so 25%
  // is unambiguously reduce. This is the one boundary where the more defensive
  // stage does not win, and it is the spec's own wording.
  it("puts exactly 25.0% of target in reduce, following the spec's '< 25%' wording for halt", () => {
    expect(selectBufferStage(0.25)).toBe("reduce");
    expect(selectBufferStage(0.2499)).toBe("halt_unwind");
    expect(selectBufferStage(0.2501)).toBe("reduce");
  });

  // Exactly 0%. The spec gives 0% its own row.
  it("puts exactly 0.0% of target in backing_only", () => {
    expect(selectBufferStage(0)).toBe("backing_only");
    expect(selectBufferStage(0.0001)).toBe("halt_unwind");
  });

  it("clamps a negative fraction to backing_only rather than producing a stage below the ladder", () => {
    expect(selectBufferStage(-0.5)).toBe("backing_only");
  });

  it("rejects a non-finite fraction instead of guessing", () => {
    expect(() => selectBufferStage(Number.NaN)).toThrow(RangeError);
  });

  it("honours custom triggers", () => {
    const strict: PlaybookThresholds = {
      ...DEFAULT_PLAYBOOK_THRESHOLDS,
      healthyFractionOfTarget: 0.9,
      drainingFractionOfTarget: 0.7,
      reduceFractionOfTarget: 0.4,
    };
    expect(selectBufferStage(0.8, strict)).toBe("draining");
    expect(selectBufferStage(0.5, strict)).toBe("reduce");
    expect(selectBufferStage(0.3, strict)).toBe("halt_unwind");
  });

  it("rejects out-of-order triggers", () => {
    const broken: PlaybookThresholds = {
      ...DEFAULT_PLAYBOOK_THRESHOLDS,
      reduceFractionOfTarget: 0.9,
    };
    expect(() => selectBufferStage(0.5, broken)).toThrow(RangeError);
  });

  it("reports each stage's upper edge", () => {
    expect(bufferStageUpperBound("backing_only")).toBe(0);
    expect(bufferStageUpperBound("halt_unwind")).toBe(0.25);
    expect(bufferStageUpperBound("reduce")).toBe(0.5);
    expect(bufferStageUpperBound("draining")).toBe(0.75);
    expect(bufferStageUpperBound("healthy")).toBeNull();
  });
});

describe("stage transitions use hysteresis so recovery is not called early", () => {
  it("does not ease while coverage oscillates around the 50% trigger", () => {
    // 49% of target is `reduce`. Recovering to 51% is inside the easing margin,
    // so the protocol stays deleveraging rather than flipping stage twice.
    const atFortyNine = selectBufferStage(0.49);
    expect(atFortyNine).toBe("reduce");

    // Without history, 51% would read as `draining`.
    expect(selectBufferStage(0.51)).toBe("draining");

    const afterRecovery = nextStage(atFortyNine, 0.51);
    expect(afterRecovery).toBe("reduce");

    const afterRelapse = nextStage(afterRecovery, 0.49);
    expect(afterRelapse).toBe("reduce");
  });

  it("eases once coverage clears the trigger by the easing margin", () => {
    expect(DEFAULT_BUFFER_STAGE_HYSTERESIS.easingMarginFractionOfTarget).toBe(0.05);
    expect(nextStage("reduce", 0.55)).toBe("reduce");
    expect(nextStage("reduce", 0.5501)).toBe("draining");
  });

  it("eases one stage at a time even after a full recovery", () => {
    expect(nextStage("backing_only", 0.9)).toBe("halt_unwind");
    expect(nextStage("halt_unwind", 0.9)).toBe("reduce");
    expect(nextStage("reduce", 0.9)).toBe("draining");
    expect(nextStage("draining", 0.9)).toBe("healthy");
  });

  it("tightens immediately and may skip stages", () => {
    expect(nextStage("healthy", 0.1)).toBe("halt_unwind");
    expect(nextStage("healthy", 0)).toBe("backing_only");
    expect(nextStage("draining", 0.2)).toBe("halt_unwind");
  });

  it("allows a faster ease when the policy is configured for it", () => {
    expect(
      nextStage("backing_only", 0.9, DEFAULT_PLAYBOOK_THRESHOLDS, {
        easingMarginFractionOfTarget: 0.05,
        maxEaseStepsPerTransition: 4,
      }),
    ).toBe("healthy");
  });

  it("rejects a nonsensical easing policy", () => {
    expect(() =>
      nextStage("reduce", 0.9, DEFAULT_PLAYBOOK_THRESHOLDS, {
        easingMarginFractionOfTarget: 0.05,
        maxEaseStepsPerTransition: 0,
      }),
    ).toThrow(RangeError);
  });
});

describe("stage actions are machine-readable and escalate monotonically", () => {
  it("pauses mint from the reduce stage down", () => {
    expect(negativeFundingPlaybook("healthy").pauseMint).toBe(false);
    expect(negativeFundingPlaybook("draining").pauseMint).toBe(false);
    expect(negativeFundingPlaybook("reduce").pauseMint).toBe(true);
    expect(negativeFundingPlaybook("halt_unwind").pauseMint).toBe(true);
    expect(negativeFundingPlaybook("backing_only").pauseMint).toBe(true);
  });

  it("never reduces the hedge less as the buffer drains further", () => {
    const ladder = negativeFundingPlaybookLadder();
    // The ladder is worst first, so hedge reduction must be non-increasing.
    for (let index = 1; index < ladder.length; index += 1) {
      const worse = ladder[index - 1];
      const better = ladder[index];
      expect(worse).toBeDefined();
      expect(better).toBeDefined();
      expect(worse?.hedgeReductionBps ?? 0).toBeGreaterThanOrEqual(better?.hedgeReductionBps ?? 0);
    }
  });

  it("raises the mint fee while draining and unwinds the hedge fully when halted", () => {
    expect(negativeFundingPlaybook("draining").mintFeeBpsDelta).toBe(25);
    expect(negativeFundingPlaybook("draining").redeemIncentiveBps).toBe(10);
    expect(negativeFundingPlaybook("halt_unwind").hedgeReductionBps).toBe(10_000);
  });

  it("requires disclosure from draining down, and subordinates staker NAV only at backing_only", () => {
    expect(negativeFundingPlaybook("healthy").disclosureRequired).toBe(false);
    for (const stage of ["draining", "reduce", "halt_unwind", "backing_only"] as const) {
      expect(negativeFundingPlaybook(stage).disclosureRequired).toBe(true);
    }
    expect(negativeFundingPlaybook("backing_only").stakerNavSubordinated).toBe(true);
    expect(negativeFundingPlaybook("halt_unwind").stakerNavSubordinated).toBe(false);
    expect(negativeFundingPlaybook("backing_only").governanceDecisionPoint).toBe(true);
    expect(negativeFundingPlaybook("halt_unwind").governanceDecisionPoint).toBe(true);
  });

  it("floors the staker reward index at zero until the buffer is gone", () => {
    expect(negativeFundingPlaybook("healthy").stakerRewardIndexFloorAtZero).toBe(true);
    expect(negativeFundingPlaybook("halt_unwind").stakerRewardIndexFloorAtZero).toBe(true);
    expect(negativeFundingPlaybook("backing_only").stakerRewardIndexFloorAtZero).toBe(false);
  });

  it("keeps the deprecated booleans consistent with the knobs they summarise", () => {
    for (const stage of BUFFER_STAGE_ORDER) {
      const step = negativeFundingPlaybook(stage);
      expect(step.restrictIssuance).toBe(step.pauseMint || step.mintFeeBpsDelta > 0);
      expect(step.reduceHedgeNotional).toBe(step.hedgeReductionBps > 0);
    }
  });

  it("gives every stage non-empty operator prose", () => {
    for (const stage of BUFFER_STAGE_ORDER) {
      const step = negativeFundingPlaybook(stage);
      expect(step.actions.length).toBeGreaterThan(0);
      expect(step.regime.length).toBeGreaterThan(0);
      for (const action of step.actions) {
        expect(action.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("states the backing-only failure mode plainly", () => {
    const step = negativeFundingPlaybook("backing_only");
    expect(step.actions.join(" ")).toContain("below one dollar");
    expect(step.actions.join(" ")).toContain("failure mode");
  });

  it("accepts custom action magnitudes", () => {
    const step = negativeFundingPlaybook("draining", {
      drainingMintFeeBpsDelta: 100,
      reduceMintFeeBpsDelta: 200,
      drainingHedgeReductionBps: 1000,
      reduceHedgeReductionBps: 3000,
      haltHedgeReductionBps: 10_000,
      drainingRedeemIncentiveBps: 20,
      reduceRedeemIncentiveBps: 40,
      haltRedeemIncentiveBps: 80,
    });
    expect(step.mintFeeBpsDelta).toBe(100);
    expect(step.hedgeReductionBps).toBe(1000);
  });
});

describe("backward compatibility with the retired four-stage vocabulary", () => {
  it("maps the old names onto the new stages", () => {
    expect(toBufferStage("nominal")).toBe("healthy");
    expect(toBufferStage("watch")).toBe("draining");
    expect(toBufferStage("throttle")).toBe("reduce");
    expect(toBufferStage("unwind")).toBe("halt_unwind");
  });

  it("accepts an old name in negativeFundingPlaybook and answers in the new vocabulary", () => {
    const step = negativeFundingPlaybook("throttle");
    expect(step.stage).toBe("reduce");
    expect(step.legacyStage).toBe("throttle");
  });

  it("keeps a legacy name on every new stage", () => {
    const legacyByStage: Record<BufferStage, string> = {
      healthy: "nominal",
      draining: "watch",
      reduce: "throttle",
      halt_unwind: "unwind",
      backing_only: "unwind",
    };
    for (const stage of BUFFER_STAGE_ORDER) {
      expect(negativeFundingPlaybook(stage).legacyStage).toBe(legacyByStage[stage]);
    }
  });

  it("still selects a four-stage posture from a projection", () => {
    expect(
      selectPlaybookStage({
        dailyNetFlowUsd: -1,
        dailyDrainUsd: 1,
        daysToDepletion: 5,
        depletesAtMs: null,
        coverageRatio: 0.05,
      }),
    ).toBe("unwind");
    expect(
      selectPlaybookStage({
        dailyNetFlowUsd: 1,
        dailyDrainUsd: 0,
        daysToDepletion: null,
        depletesAtMs: null,
        coverageRatio: 0.05,
      }),
    ).toBe("nominal");
  });
});
