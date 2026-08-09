import { describe, expect, it } from "vitest";

import { MS_PER_DAY } from "./units.js";
import { timeToYieldWipeout, type YieldWipeoutInput } from "./wipeout.js";

/**
 * The reference case, worked by hand.
 *
 *   f_h = -0.0000125 (-0.00125%/hr)   H = 100,000,000 USD   B = 1,700,000 USD
 *
 *   dailyNetCarryUsd       = -0.0000125 * 24 * 100,000,000 = -30,000 USD/day
 *   annualizedNetCarryRate = -0.0000125 * 24 * 365.25      = -0.109575 (-10.9575%/yr)
 *   daysToStakerYieldZero  = 0 accrued / 30,000            = 0 days
 *   daysToBufferDepletion  = 1,700,000 / 30,000            = 56.666... days
 *
 * Only the annualized line moved when the basis changed from 365 days to the
 * 365.25 that _DIRECTION.md 8-1 fixes; -10.95%/yr is the 365-day reading of the
 * same rate. The daily and runway lines have no year length in them.
 *
 * The two events are different. Staker carry reaches zero immediately, because
 * there is no accrued cushion; the buffer keeps the backing whole for another
 * 56.7 days.
 */
const NEGATIVE_FUNDING_CASE: YieldWipeoutInput = {
  hourlyFundingRate: -0.0000125,
  hedgeNotionalUsd: 100_000_000,
  bufferBalanceUsd: 1_700_000,
};

describe("timeToYieldWipeout under a negative funding regime", () => {
  it("computes -30,000 USD per day and -10.9575% per year", () => {
    const estimate = timeToYieldWipeout(NEGATIVE_FUNDING_CASE);
    expect(estimate.isNegativeCarry).toBe(true);
    expect(estimate.dailyNetCarryUsd).toBeCloseTo(-30_000, 6);
    expect(estimate.annualizedNetCarryRate).toBeCloseTo(-0.109575, 10);
    expect(estimate.annualizedFundingRate).toBeCloseTo(-0.109575, 10);
    // Not -3.65%/yr, the 8h-read-as-a-day error, under either year length.
    expect(estimate.annualizedFundingRate ?? 0).not.toBeCloseTo(-0.0365, 3);
  });

  it("separates staker carry reaching zero from the buffer emptying", () => {
    const estimate = timeToYieldWipeout(NEGATIVE_FUNDING_CASE);
    expect(estimate.daysToStakerYieldZero).toBe(0);
    expect(estimate.daysToBufferDepletion).toBeCloseTo(56.7, 1);
    expect(estimate.daysToBufferDepletion).toBeCloseTo(1_700_000 / 30_000, 9);
    expect(estimate.firstEvent).toBe("staker_yield_zero");
  });

  it("consumes an accrued carry cushion before the reward index reaches zero", () => {
    // 300,000 USD accrued at 30,000/day of bleed is exactly 10 days.
    const estimate = timeToYieldWipeout({
      ...NEGATIVE_FUNDING_CASE,
      accruedStakerCarryUsd: 300_000,
    });
    expect(estimate.daysToStakerYieldZero).toBeCloseTo(10, 9);
    expect(estimate.daysToBufferDepletion).toBeCloseTo(56.666_666_7, 6);
    expect(estimate.firstEvent).toBe("staker_yield_zero");
  });

  it("lets other carry offset negative funding", () => {
    // Funding costs 10.9575%/yr; a 12%/yr collateral rate leaves net carry
    // positive at 0.12 - 0.109575 = 0.010425.
    const estimate = timeToYieldWipeout({
      ...NEGATIVE_FUNDING_CASE,
      otherAnnualizedCarryRate: 0.12,
    });
    expect(estimate.isNegativeCarry).toBe(false);
    expect(estimate.annualizedNetCarryRate).toBeCloseTo(0.010425, 8);
    expect(estimate.daysToStakerYieldZero).toBeNull();
    expect(estimate.daysToBufferDepletion).toBeNull();
    expect(estimate.firstEvent).toBeNull();
  });

  it("reports buffer depletion first when the accrued cushion outlasts the buffer", () => {
    const estimate = timeToYieldWipeout({
      ...NEGATIVE_FUNDING_CASE,
      accruedStakerCarryUsd: 5_000_000,
    });
    expect(estimate.firstEvent).toBe("buffer_depletion");
  });

  it("dates both events only when the caller supplies the current time", () => {
    const asOfMs = 1_754_697_600_000;
    const estimate = timeToYieldWipeout({
      ...NEGATIVE_FUNDING_CASE,
      accruedStakerCarryUsd: 300_000,
      asOfMs,
    });
    expect(estimate.stakerYieldZeroAtMs).toBeCloseTo(asOfMs + 10 * MS_PER_DAY, 0);
    expect(estimate.bufferDepletionAtMs).toBeCloseTo(
      asOfMs + (1_700_000 / 30_000) * MS_PER_DAY,
      0,
    );
    const undated = timeToYieldWipeout(NEGATIVE_FUNDING_CASE);
    expect(undated.stakerYieldZeroAtMs).toBeNull();
    expect(undated.bufferDepletionAtMs).toBeNull();
  });

  it("labels itself an estimate and states what it assumes", () => {
    const estimate = timeToYieldWipeout(NEGATIVE_FUNDING_CASE);
    expect(estimate.isEstimate).toBe(true);
    expect(estimate.assumptions.length).toBeGreaterThan(0);
    expect(estimate.assumptions.join(" ")).toContain("distinct events");
  });
});

describe("timeToYieldWipeout refuses to invent numbers", () => {
  it("reports insufficient data when there is no funding observation", () => {
    const estimate = timeToYieldWipeout({ ...NEGATIVE_FUNDING_CASE, hourlyFundingRate: null });
    expect(estimate.insufficientData).toBe(true);
    expect(estimate.insufficientDataReason).not.toBeNull();
    expect(estimate.dailyNetCarryUsd).toBeNull();
    expect(estimate.daysToStakerYieldZero).toBeNull();
    expect(estimate.daysToBufferDepletion).toBeNull();
    expect(estimate.firstEvent).toBeNull();
  });

  it("returns null rather than Infinity at exactly zero funding", () => {
    const estimate = timeToYieldWipeout({ ...NEGATIVE_FUNDING_CASE, hourlyFundingRate: 0 });
    expect(estimate.isNegativeCarry).toBe(false);
    expect(estimate.daysToStakerYieldZero).toBeNull();
    expect(estimate.daysToBufferDepletion).toBeNull();
    expect(estimate.dailyNetCarryUsd).toBe(0);
  });

  it("rejects malformed input instead of producing NaN", () => {
    expect(() =>
      timeToYieldWipeout({ ...NEGATIVE_FUNDING_CASE, bufferBalanceUsd: -1 }),
    ).toThrow(RangeError);
    expect(() =>
      timeToYieldWipeout({ ...NEGATIVE_FUNDING_CASE, accruedStakerCarryUsd: -1 }),
    ).toThrow(RangeError);
  });
});

describe("timeToYieldWipeout is pure", () => {
  it("returns the same result for the same input", () => {
    const input: YieldWipeoutInput = { ...NEGATIVE_FUNDING_CASE, asOfMs: 1_700_000_000_000 };
    expect(timeToYieldWipeout(input)).toEqual(timeToYieldWipeout(input));
  });

  it("does not mutate its input", () => {
    const input = { ...NEGATIVE_FUNDING_CASE };
    const snapshot = { ...input };
    timeToYieldWipeout(input);
    expect(input).toEqual(snapshot);
  });
});
