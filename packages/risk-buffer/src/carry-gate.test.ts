import { describe, expect, it } from "vitest";

import {
  DEFAULT_CARRY_GATE_CONFIG,
  carryFloorAnnualRate,
  carryFloorDailyRate,
  carryGateAllowsMintBps,
  carryObservationToDailyRate,
  carryRateToDailyBps,
  evaluateCarryGate,
  type CarryGateInput,
} from "./carry-gate.js";
import { MEASURED_CARRY_REGIMES, SOL_PERP_FUNDING_SNAPSHOT_2026_08_09 } from "./scenarios.js";
import { DAYS_PER_YEAR } from "./units.js";

/**
 * The floor, worked by hand at the POYZ target buffer (risk-spec 1.4, 6):
 *
 *   b               = 0.03            (300 bps, buffer_target_bps)
 *   min_runway_days = 30
 *
 *   floor(daily)  = -(0.03 / 30)      = -0.001        (-0.1%/day)
 *   floor(annual) = -0.001 * 365.25   = -0.36525      (-36.525%/yr)
 *
 * Every expectation below is derived from those two lines.
 */
const TARGET_BUFFER = 0.03;
const FLOOR_DAILY = -0.001;
const FLOOR_ANNUAL = -0.36525;

const AT_TARGET: CarryGateInput = {
  netCarry: { basis: "hourly", rate: SOL_PERP_FUNDING_SNAPSHOT_2026_08_09.hourlyRate1y },
  bufferFraction: TARGET_BUFFER,
};

describe("carry floor derivation", () => {
  it("derives -0.1%/day and -36.525%/yr from a 3% buffer over 30 days", () => {
    expect(carryFloorDailyRate(TARGET_BUFFER, 30)).toBeCloseTo(FLOOR_DAILY, 12);
    expect(carryFloorAnnualRate(TARGET_BUFFER, 30)).toBeCloseTo(FLOOR_ANNUAL, 10);
  });

  it("uses 30 days as the default minimum runway", () => {
    expect(DEFAULT_CARRY_GATE_CONFIG.minRunwayDays).toBe(30);
    // No hysteresis by default; the baseline regime has only 0.7 points of
    // headroom, so a non-zero margin is a deliberate operator choice.
    expect(DEFAULT_CARRY_GATE_CONFIG.reopenMarginAnnualRate).toBe(0);
  });

  it("tightens by itself as the buffer drains", () => {
    // Half the buffer, half the admissible bleed.
    expect(carryFloorDailyRate(0.015, 30)).toBeCloseTo(-0.0005, 12);
    // An empty buffer admits no negative carry at all.
    expect(carryFloorDailyRate(0, 30)).toBe(-0);
    expect(carryFloorAnnualRate(0.017, 30)).toBeCloseTo(-(0.017 / 30) * DAYS_PER_YEAR, 12);
  });

  it("is exactly the runway definition read backwards", () => {
    // At exactly the floor, b / |f_d| is exactly minRunwayDays.
    const floor = carryFloorDailyRate(TARGET_BUFFER, 30);
    expect(TARGET_BUFFER / -floor).toBeCloseTo(30, 9);
  });

  it("rejects a malformed floor request instead of producing Infinity", () => {
    expect(() => carryFloorDailyRate(TARGET_BUFFER, 0)).toThrow(RangeError);
    expect(() => carryFloorDailyRate(TARGET_BUFFER, -1)).toThrow(RangeError);
    expect(() => carryFloorDailyRate(-0.01, 30)).toThrow(RangeError);
    expect(() => carryFloorDailyRate(Number.NaN, 30)).toThrow(RangeError);
  });
});

describe("carryObservationToDailyRate", () => {
  it("restates every basis onto the same daily rate", () => {
    expect(carryObservationToDailyRate({ basis: "hourly", rate: -0.00004086 })).toBeCloseTo(
      -0.00098064,
      14,
    );
    expect(carryObservationToDailyRate({ basis: "daily", rate: -0.00098064 })).toBe(-0.00098064);
    expect(carryObservationToDailyRate({ basis: "annual", rate: -0.35817876 })).toBeCloseTo(
      -0.00098064,
      14,
    );
  });

  it("rejects a non-finite rate", () => {
    expect(() => carryObservationToDailyRate({ basis: "hourly", rate: Number.NaN })).toThrow(
      RangeError,
    );
  });
});

describe("the gate against the measured venue regimes (_DIRECTION 8-1, 2026-08-09)", () => {
  /*
   * Hand calculation for each window, at b = 3% and minRunwayDays = 30.
   * floor(daily) = -0.001, floor(annual) = -0.36525.
   *
   *   window  f_h (%/hr)  f_d = f_h * 24        APR = f_h * 8766   vs floor
   *   24h     -0.012013   -0.0028831200         -1.05305958        blocked
   *   7d      +0.002704   +0.0006489600         +0.23703264        allowed
   *   30d     -0.004937   -0.0011848800         -0.43277742        blocked
   *   1y      -0.004086   -0.0009806400         -0.35817876        allowed
   *
   * Two of the four measured windows block new mint. This is the current
   * regime, not a stress case.
   */
  const expected: ReadonlyArray<{
    readonly id: string;
    readonly annualRate: number;
    readonly allowed: boolean;
  }> = [
    { id: "measured_24h", annualRate: -1.05305958, allowed: false },
    { id: "measured_7d", annualRate: 0.23703264, allowed: true },
    { id: "measured_30d", annualRate: -0.43277742, allowed: false },
    { id: "measured_1y", annualRate: -0.35817876, allowed: true },
  ];

  for (const row of expected) {
    it(`${row.id} annualizes to ${(row.annualRate * 100).toFixed(2)}% and ${row.allowed ? "allows" : "blocks"} mint`, () => {
      const regime = MEASURED_CARRY_REGIMES.find((candidate) => candidate.id === row.id);
      expect(regime).toBeDefined();
      expect(regime?.annualizedRate).toBeCloseTo(row.annualRate, 8);

      const evaluation = evaluateCarryGate({
        netCarry: { basis: "hourly", rate: regime?.hourlyRate ?? 0 },
        bufferFraction: TARGET_BUFFER,
      });
      expect(evaluation.mintAllowed).toBe(row.allowed);
      expect(evaluation.decision).toBe(row.allowed ? "allow_mint" : "block_mint");
      expect(evaluation.reason).toBe(row.allowed ? "carry_at_or_above_floor" : "carry_below_floor");
      expect(evaluation.netCarryAnnualRate).toBeCloseTo(row.annualRate, 8);
      expect(evaluation.carryFloorAnnualRate).toBeCloseTo(FLOOR_ANNUAL, 10);
    });
  }

  it("passes the 1-year baseline by 0.707 points of headroom, not comfortably", () => {
    const evaluation = evaluateCarryGate(AT_TARGET);
    // -0.35817876 - (-0.36525) = 0.00707124
    expect(evaluation.headroomAnnualRate).toBeCloseTo(0.00707124, 8);
    expect(evaluation.mintAllowed).toBe(true);
  });

  it("reports the runway the baseline regime implies: 30.59 days on a 3% buffer", () => {
    /*
     * Hand calculation, the core number of the product:
     *
     *   f_h  = -0.00004086            (-0.004086 %/hr, the 1y measured window)
     *   f_d  = 0.00004086 * 24        =  0.00098064
     *   days = 0.03 / 0.00098064      =  30.5922... days
     *
     * risk-spec 1.3 prints that cell as 30.6 days. A 3% buffer -- nearly twice
     * Ethena's empirical 1.7% -- buys about one month at the one-year average
     * rate.
     */
    const evaluation = evaluateCarryGate(AT_TARGET);
    expect(evaluation.impliedRunwayDays).toBeCloseTo(0.03 / 0.00098064, 9);
    expect(evaluation.impliedRunwayDays).toBeCloseTo(30.59, 2);
    expect(evaluation.impliedRunwayDays).toBeCloseTo(30.6, 1);
    // Just above the 30-day requirement, which is why the gate passes at all.
    expect(evaluation.impliedRunwayDays ?? 0).toBeGreaterThan(
      DEFAULT_CARRY_GATE_CONFIG.minRunwayDays,
    );
  });

  it("reports no runway for the one positive window, rather than a fabricated large number", () => {
    const evaluation = evaluateCarryGate({
      netCarry: { basis: "hourly", rate: SOL_PERP_FUNDING_SNAPSHOT_2026_08_09.hourlyRate7d },
      bufferFraction: TARGET_BUFFER,
    });
    expect(evaluation.mintAllowed).toBe(true);
    expect(evaluation.impliedRunwayDays).toBeNull();
  });

  it("blocks the baseline regime once the buffer has drained to the Ethena anchor", () => {
    // b = 1.7% over 30 days is a floor of -0.0005667/day = -20.70%/yr, and the
    // 1y regime at -35.82%/yr no longer clears it. The floor tightens as the
    // buffer drains, which is the ratchet risk-spec 1.4 describes.
    const evaluation = evaluateCarryGate({ ...AT_TARGET, bufferFraction: 0.017 });
    expect(evaluation.carryFloorAnnualRate).toBeCloseTo(-0.207_0, 3);
    expect(evaluation.mintAllowed).toBe(false);
    expect(evaluation.reason).toBe("carry_below_floor");
    expect(evaluation.impliedRunwayDays).toBeCloseTo(0.017 / 0.00098064, 9);
  });
});

describe("the gate fails closed", () => {
  it("refuses mint when there is no carry observation", () => {
    const evaluation = evaluateCarryGate({ ...AT_TARGET, netCarry: null });
    expect(evaluation.mintAllowed).toBe(false);
    expect(evaluation.reason).toBe("no_carry_observation");
    expect(evaluation.insufficientData).toBe(true);
    expect(evaluation.netCarryAnnualRate).toBeNull();
    expect(evaluation.impliedRunwayDays).toBeNull();
    // The floor is still reportable; it does not depend on the observation.
    expect(evaluation.carryFloorAnnualRate).toBeCloseTo(FLOOR_ANNUAL, 10);
  });

  it("refuses mint when the buffer share cannot be measured", () => {
    const evaluation = evaluateCarryGate({ ...AT_TARGET, bufferFraction: null });
    expect(evaluation.mintAllowed).toBe(false);
    expect(evaluation.reason).toBe("no_buffer_measurement");
    expect(evaluation.insufficientData).toBe(true);
    expect(evaluation.carryFloorAnnualRate).toBeNull();
  });

  it("refuses any negative carry once the buffer is empty", () => {
    const evaluation = evaluateCarryGate({ ...AT_TARGET, bufferFraction: 0 });
    expect(evaluation.carryFloorDailyRate).toBe(-0);
    expect(evaluation.mintAllowed).toBe(false);
    expect(evaluation.reason).toBe("carry_below_floor");
  });

  it("admits exactly-zero carry against an empty buffer", () => {
    const evaluation = evaluateCarryGate({
      netCarry: { basis: "daily", rate: 0 },
      bufferFraction: 0,
    });
    expect(evaluation.mintAllowed).toBe(true);
    expect(evaluation.impliedRunwayDays).toBeNull();
  });

  it("admits carry sitting exactly on the floor", () => {
    const evaluation = evaluateCarryGate({
      netCarry: { basis: "daily", rate: FLOOR_DAILY },
      bufferFraction: TARGET_BUFFER,
    });
    expect(evaluation.mintAllowed).toBe(true);
    expect(evaluation.headroomAnnualRate).toBeCloseTo(0, 12);
    expect(evaluation.impliedRunwayDays).toBeCloseTo(30, 9);
  });

  it("rejects a malformed input or configuration instead of guessing", () => {
    expect(() => evaluateCarryGate({ ...AT_TARGET, bufferFraction: -0.01 })).toThrow(RangeError);
    expect(() =>
      evaluateCarryGate({ ...AT_TARGET, netCarry: { basis: "daily", rate: Number.NaN } }),
    ).toThrow(RangeError);
    expect(() => evaluateCarryGate({ ...AT_TARGET, config: { minRunwayDays: 0 } })).toThrow(
      RangeError,
    );
    expect(() =>
      evaluateCarryGate({ ...AT_TARGET, config: { reopenMarginAnnualRate: -0.01 } }),
    ).toThrow(RangeError);
    expect(() => evaluateCarryGate({ ...AT_TARGET, asOfMs: Number.NaN })).toThrow(RangeError);
  });
});

describe("re-open hysteresis", () => {
  it("is inactive by default, so a passing regime re-opens the gate immediately", () => {
    const evaluation = evaluateCarryGate({ ...AT_TARGET, previouslyBlocked: true });
    expect(evaluation.mintAllowed).toBe(true);
  });

  it("holds a closed gate shut until the configured margin is cleared", () => {
    // 200 bps/yr of margin is more than the baseline's 70.7 bps of headroom, so
    // the baseline clears the floor but not the re-open margin.
    const evaluation = evaluateCarryGate({
      ...AT_TARGET,
      previouslyBlocked: true,
      config: { reopenMarginAnnualRate: 0.02 },
    });
    expect(evaluation.mintAllowed).toBe(false);
    expect(evaluation.reason).toBe("carry_below_reopen_margin");
    expect(evaluation.assumptions.join(" ")).toContain("already closed");
  });

  it("does not apply the margin to a gate that was open", () => {
    const evaluation = evaluateCarryGate({
      ...AT_TARGET,
      previouslyBlocked: false,
      config: { reopenMarginAnnualRate: 0.02 },
    });
    expect(evaluation.mintAllowed).toBe(true);
  });
});

describe("the integer form the program evaluates", () => {
  it("agrees with the floating-point gate on every measured regime", () => {
    const bufferBps = 300;
    for (const regime of MEASURED_CARRY_REGIMES) {
      const float = evaluateCarryGate({
        netCarry: { basis: "hourly", rate: regime.hourlyRate },
        bufferFraction: bufferBps / 10_000,
      });
      const integer = carryGateAllowsMintBps(
        carryRateToDailyBps(regime.dailyRate),
        bufferBps,
        DEFAULT_CARRY_GATE_CONFIG.minRunwayDays,
      );
      expect(`${regime.id}: ${integer}`).toBe(`${regime.id}: ${float.mintAllowed}`);
    }
  });

  it("is the same inequality without a division", () => {
    // b = 300 bps over 30 days admits a daily bleed of 10 bps.
    expect(carryGateAllowsMintBps(-10, 300, 30)).toBe(true);
    expect(carryGateAllowsMintBps(-11, 300, 30)).toBe(false);
    expect(carryGateAllowsMintBps(0, 0, 30)).toBe(true);
    expect(carryGateAllowsMintBps(-1, 0, 30)).toBe(false);
  });

  it("rounds a sub-basis-point residual toward the stricter side", () => {
    // -0.00098064/day is -9.8064 bps, floored to -10 bps: a slightly larger
    // cost, so the gate is never loosened by the rounding.
    expect(carryRateToDailyBps(-0.00098064)).toBe(-10);
    expect(carryRateToDailyBps(0.00098064)).toBe(9);
  });

  it("rejects non-integer arguments rather than silently truncating", () => {
    expect(() => carryGateAllowsMintBps(-10.5, 300, 30)).toThrow(RangeError);
    expect(() => carryGateAllowsMintBps(-10, -1, 30)).toThrow(RangeError);
    expect(() => carryGateAllowsMintBps(-10, 300, 0)).toThrow(RangeError);
    expect(() => carryGateAllowsMintBps(-10, 300, 30.5)).toThrow(RangeError);
  });
});

describe("evaluateCarryGate is pure and renderable", () => {
  it("returns the same result for the same input and does not mutate it", () => {
    const input: CarryGateInput = { ...AT_TARGET, asOfMs: 1_754_697_600_000 };
    const snapshot = { ...input };
    expect(evaluateCarryGate(input)).toEqual(evaluateCarryGate(input));
    expect(input).toEqual(snapshot);
  });

  it("echoes the supplied time and reports null when none was supplied", () => {
    expect(evaluateCarryGate({ ...AT_TARGET, asOfMs: 1_754_697_600_000 }).asOfMs).toBe(
      1_754_697_600_000,
    );
    expect(evaluateCarryGate(AT_TARGET).asOfMs).toBeNull();
  });

  it("states a reason and its assumptions in renderable English", () => {
    const blocked = evaluateCarryGate({
      netCarry: { basis: "hourly", rate: SOL_PERP_FUNDING_SNAPSHOT_2026_08_09.hourlyRate30d },
      bufferFraction: TARGET_BUFFER,
    });
    expect(blocked.reasonText).toContain("below the carry floor");
    expect(blocked.reasonText).toContain("30 days");
    expect(blocked.assumptions.length).toBeGreaterThan(0);
    expect(blocked.assumptions.join(" ")).toContain("hold flat");

    const allowed = evaluateCarryGate(AT_TARGET);
    expect(allowed.reasonText).toContain("at or above the carry floor");
  });
});
