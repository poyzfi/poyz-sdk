import { describe, expect, it } from "vitest";

import { bufferStateFromBps } from "./accounting.js";
import {
  estimateBufferDepletion,
  projectBufferDepletion,
  requiredTopUpUsd,
  type BufferDepletionInput,
} from "./depletion.js";
import { SOL_PERP_FUNDING_SNAPSHOT_2026_08_09 } from "./scenarios.js";
import { MS_PER_DAY, perEightHourToHourlyRate } from "./units.js";

/**
 * The reference case, worked by hand.
 *
 *   f_h = -0.00125% / hr            = -0.0000125
 *   S   = 100,000,000 USD, H ~= S
 *   B   = 1,700,000 USD             -> b = 1.7% of supply (the Ethena anchor)
 *
 *   f_d              = |f_h| * 24                       = 0.0003        (0.03%/day)
 *   daily cost       = 0.0000125 * 24 * 100,000,000     = 30,000 USD/day
 *   annualized       = -0.0000125 * 24 * 365.25         = -0.109575     (-10.9575%/yr)
 *   runway (days)    = 1,700,000 / 30,000               = 56.666...
 *   equivalently     = b / f_d = 0.017 / 0.0003         = 56.666...
 *
 * Note which lines moved when the annualization basis changed from 365 days to
 * the 365.25 that _DIRECTION.md 8-1 fixes: only the annualized line. -10.95%/yr
 * is the 365-day reading of the same rate and is what earlier risk-spec drafts
 * printed in section 1.3. The daily cost and the runway are daily-basis
 * divisions with no year length in them, so 56.7 days is unchanged.
 */
const NEGATIVE_FUNDING_CASE: BufferDepletionInput = {
  bufferBalanceUsd: 1_700_000,
  supplyUsd: 100_000_000,
  hourlyFundingRate: -0.0000125,
};

describe("estimateBufferDepletion under a negative funding regime", () => {
  it("negative funding at -0.00125%/hr on 100M supply costs 30,000 USD per day", () => {
    const estimate = estimateBufferDepletion(NEGATIVE_FUNDING_CASE);
    expect(estimate.isDraining).toBe(true);
    expect(estimate.dailyFundingCostUsd).toBeCloseTo(30_000, 6);
    expect(estimate.dailyNetFlowUsd).toBeCloseTo(-30_000, 6);
    expect(estimate.dailyCostFraction).toBeCloseTo(0.0003, 12);
  });

  it("negative funding of -0.00125%/hr annualizes to -10.9575%, not -3.65%", () => {
    const estimate = estimateBufferDepletion(NEGATIVE_FUNDING_CASE);
    expect(estimate.annualizedFundingRate).toBeCloseTo(-0.109575, 10);
    // The 365-day reading of the same rate, for the reader comparing against an
    // earlier risk-spec draft: both divide back to the same hourly rate.
    expect((estimate.annualizedFundingRate ?? 0) / (24 * 365.25)).toBeCloseTo(
      -0.1095 / (24 * 365),
      14,
    );
    // -3.65%/yr is the 8h-read-as-a-day error and stays excluded under either
    // year length. The change of basis is not a reason to drop this.
    expect(estimate.annualizedFundingRate ?? 0).not.toBeCloseTo(-0.0365, 3);
    expect((estimate.annualizedFundingRate ?? 0) / 3).toBeCloseTo(-0.036525, 10);
  });

  it("negative funding drains a 1.7% buffer in 56.7 days, matching the risk-spec 1.3 table", () => {
    const estimate = estimateBufferDepletion(NEGATIVE_FUNDING_CASE);
    expect(estimate.bufferFraction).toBeCloseTo(0.017, 12);
    // 1,700,000 / 30,000 = 56.666..., which the spec table prints as 56.7.
    expect(estimate.runwayDays).toBeCloseTo(56.7, 1);
    expect(estimate.runwayDays).toBeCloseTo(1_700_000 / 30_000, 9);
  });

  it("negative funding quoted per 8h reaches the same runway once converted", () => {
    const estimate = estimateBufferDepletion({
      ...NEGATIVE_FUNDING_CASE,
      hourlyFundingRate: perEightHourToHourlyRate(-0.0001),
    });
    expect(estimate.runwayDays).toBeCloseTo(56.7, 1);
  });

  it("places a 1.7% buffer against a 3% target in the draining stage", () => {
    const estimate = estimateBufferDepletion(NEGATIVE_FUNDING_CASE);
    // 1,700,000 / (100,000,000 * 0.03) = 0.5667 of target.
    expect(estimate.coverageFractionOfTarget).toBeCloseTo(0.566_666_7, 6);
    expect(estimate.stage).toBe("draining");
  });

  it("dates the depletion only when the caller supplies the current time", () => {
    const asOfMs = 1_754_697_600_000;
    const withTime = estimateBufferDepletion({ ...NEGATIVE_FUNDING_CASE, asOfMs });
    expect(withTime.depletesAtMs).toBeCloseTo(asOfMs + (1_700_000 / 30_000) * MS_PER_DAY, 0);
    expect(estimateBufferDepletion(NEGATIVE_FUNDING_CASE).depletesAtMs).toBeNull();
  });

  it("labels itself an estimate and states what it assumes", () => {
    const estimate = estimateBufferDepletion(NEGATIVE_FUNDING_CASE);
    expect(estimate.isEstimate).toBe(true);
    expect(estimate.assumptions.length).toBeGreaterThan(0);
    expect(estimate.assumptions.join(" ")).toContain("H ~= S");
    expect(estimate.assumptions.join(" ")).toContain("hold flat");
  });

  it("honours an explicit hedge notional and drops the H ~= S assumption", () => {
    const estimate = estimateBufferDepletion({
      ...NEGATIVE_FUNDING_CASE,
      hedgeNotionalUsd: 50_000_000,
    });
    // Half the notional, half the bleed, twice the runway.
    expect(estimate.dailyFundingCostUsd).toBeCloseTo(15_000, 6);
    expect(estimate.runwayDays).toBeCloseTo(113.3, 1);
    expect(estimate.assumptions.join(" ")).not.toContain("H ~= S");
  });

  it("adds a fixed operating drain on top of the funding cost", () => {
    const estimate = estimateBufferDepletion({
      ...NEGATIVE_FUNDING_CASE,
      dailyOperatingCostUsd: 4_000,
    });
    expect(estimate.dailyNetFlowUsd).toBeCloseTo(-34_000, 6);
    expect(estimate.runwayDays).toBeCloseTo(1_700_000 / 34_000, 9);
  });
});

describe("estimateBufferDepletion against the measured regime (_DIRECTION 8-1, 2026-08-09)", () => {
  /*
   * The one-year measured window is the baseline regime, and this is the core
   * number of the product. Worked by hand:
   *
   *   f_h   = -0.004086 %/hr        = -0.00004086
   *   f_d   = 0.00004086 * 24       =  0.00098064        (0.098064 %/day)
   *   APR   = -0.00004086 * 8766    = -0.35817876        (-35.82%/yr, venue reports -35.8%)
   *   S     = 100,000,000 USD, H ~= S
   *   B     = 3,000,000 USD          -> b = 3% (buffer_target_bps = 300)
   *   drain = 0.00098064 * 100,000,000 = 98,064 USD/day
   *   days  = 3,000,000 / 98,064       = 30.5924...
   *   check = b / f_d = 0.03 / 0.00098064 = 30.5924...   (identical)
   *
   * risk-spec 1.3 prints that cell as 30.6 days. Weeks, not months, at the
   * target buffer -- and this is the one-year average, not a stress case.
   */
  const MEASURED_1Y: BufferDepletionInput = {
    bufferBalanceUsd: 3_000_000,
    supplyUsd: 100_000_000,
    hourlyFundingRate: SOL_PERP_FUNDING_SNAPSHOT_2026_08_09.hourlyRate1y,
  };

  it("annualizes the 1y window to about -35.8% on the 365.25-day basis", () => {
    const estimate = estimateBufferDepletion(MEASURED_1Y);
    expect(estimate.annualizedFundingRate).toBeCloseTo(-0.35817876, 8);
    expect((estimate.annualizedFundingRate ?? 0) * 100).toBeCloseTo(-35.8, 1);
  });

  it("gives a 3% buffer 30.59 days at the 1y measured regime", () => {
    const estimate = estimateBufferDepletion(MEASURED_1Y);
    expect(estimate.dailyCostFraction).toBeCloseTo(0.00098064, 12);
    expect(estimate.dailyFundingCostUsd).toBeCloseTo(98_064, 6);
    expect(estimate.runwayDays).toBeCloseTo(3_000_000 / 98_064, 9);
    expect(estimate.runwayDays).toBeCloseTo(0.03 / 0.00098064, 9);
    expect(estimate.runwayDays).toBeCloseTo(30.6, 1);
  });

  it("gives the same 3% buffer 25.3 days at 30d and 10.4 days at 24h", () => {
    // 0.03 / (0.00004937 * 24) = 25.3190; 0.03 / (0.00012013 * 24) = 10.4054.
    const thirtyDay = estimateBufferDepletion({
      ...MEASURED_1Y,
      hourlyFundingRate: SOL_PERP_FUNDING_SNAPSHOT_2026_08_09.hourlyRate30d,
    });
    const spot = estimateBufferDepletion({
      ...MEASURED_1Y,
      hourlyFundingRate: SOL_PERP_FUNDING_SNAPSHOT_2026_08_09.hourlyRate24h,
    });
    expect(thirtyDay.runwayDays).toBeCloseTo(25.3, 1);
    expect(spot.runwayDays).toBeCloseTo(10.4, 1);
  });

  it("reports no runway for the single positive window instead of inventing one", () => {
    const estimate = estimateBufferDepletion({
      ...MEASURED_1Y,
      hourlyFundingRate: SOL_PERP_FUNDING_SNAPSHOT_2026_08_09.hourlyRate7d,
    });
    expect(estimate.isDraining).toBe(false);
    expect(estimate.runwayDays).toBeNull();
    expect(estimate.annualizedFundingRate).toBeCloseTo(0.23703264, 8);
  });
});

describe("estimateBufferDepletion refuses to invent numbers", () => {
  it("reports insufficient data when there is no funding observation", () => {
    const estimate = estimateBufferDepletion({
      ...NEGATIVE_FUNDING_CASE,
      hourlyFundingRate: null,
    });
    expect(estimate.insufficientData).toBe(true);
    expect(estimate.insufficientDataReason).not.toBeNull();
    expect(estimate.runwayDays).toBeNull();
    expect(estimate.dailyFundingCostUsd).toBeNull();
    expect(estimate.annualizedFundingRate).toBeNull();
    // Coverage does not depend on funding, so it is still reported.
    expect(estimate.coverageFractionOfTarget).toBeCloseTo(0.566_666_7, 6);
    expect(estimate.stage).toBe("draining");
  });

  it("returns null rather than Infinity when the funding rate is exactly zero", () => {
    const estimate = estimateBufferDepletion({
      ...NEGATIVE_FUNDING_CASE,
      hourlyFundingRate: 0,
    });
    expect(estimate.insufficientData).toBe(false);
    expect(estimate.isDraining).toBe(false);
    expect(estimate.runwayDays).toBeNull();
    expect(estimate.depletesAtMs).toBeNull();
    expect(estimate.dailyFundingCostUsd).toBe(0);
    expect(Number.isFinite(estimate.dailyNetFlowUsd ?? Number.NaN)).toBe(true);
  });

  it("returns no runway when funding is positive and the buffer is growing", () => {
    const estimate = estimateBufferDepletion({
      ...NEGATIVE_FUNDING_CASE,
      hourlyFundingRate: 0.00001,
    });
    expect(estimate.isDraining).toBe(false);
    expect(estimate.runwayDays).toBeNull();
    expect(estimate.dailyNetFlowUsd ?? 0).toBeGreaterThan(0);
  });

  it("reports no coverage fraction when there is no target to measure against", () => {
    const estimate = estimateBufferDepletion({
      ...NEGATIVE_FUNDING_CASE,
      bufferTargetBps: 0,
    });
    expect(estimate.coverageFractionOfTarget).toBeNull();
    expect(estimate.stage).toBeNull();
    // The runway is unaffected; it does not depend on the target.
    expect(estimate.runwayDays).toBeCloseTo(56.7, 1);
  });

  it("rejects malformed input instead of producing NaN", () => {
    expect(() =>
      estimateBufferDepletion({ ...NEGATIVE_FUNDING_CASE, bufferBalanceUsd: -1 }),
    ).toThrow(RangeError);
    expect(() =>
      estimateBufferDepletion({ ...NEGATIVE_FUNDING_CASE, hourlyFundingRate: Number.NaN }),
    ).toThrow(RangeError);
  });
});

describe("an empty buffer", () => {
  it("is backing_only with zero runway", () => {
    const estimate = estimateBufferDepletion({ ...NEGATIVE_FUNDING_CASE, bufferBalanceUsd: 0 });
    expect(estimate.coverageFractionOfTarget).toBe(0);
    expect(estimate.stage).toBe("backing_only");
    expect(estimate.runwayDays).toBe(0);
    expect(estimate.isDraining).toBe(true);
  });
});

describe("estimateBufferDepletion is pure", () => {
  it("returns the same result for the same input", () => {
    const first = estimateBufferDepletion({ ...NEGATIVE_FUNDING_CASE, asOfMs: 1_700_000_000_000 });
    const second = estimateBufferDepletion({ ...NEGATIVE_FUNDING_CASE, asOfMs: 1_700_000_000_000 });
    expect(first).toEqual(second);
  });

  it("does not read the clock: two calls a moment apart date depletion identically", () => {
    const asOfMs = 1_700_000_000_000;
    const first = estimateBufferDepletion({ ...NEGATIVE_FUNDING_CASE, asOfMs });
    const second = estimateBufferDepletion({ ...NEGATIVE_FUNDING_CASE, asOfMs });
    expect(first.depletesAtMs).toBe(second.depletesAtMs);
  });

  it("does not mutate its input", () => {
    const input = { ...NEGATIVE_FUNDING_CASE };
    const snapshot = { ...input };
    estimateBufferDepletion(input);
    expect(input).toEqual(snapshot);
  });
});

describe("projectBufferDepletion (retained from the earlier build)", () => {
  const state = bufferStateFromBps(1_700_000, 100_000_000, 300);

  // -0.109575 is -0.0000125/hr annualized on the 365.25-day basis, so the daily
  // figure this scenario implies is exactly -30,000 USD again. On the old
  // 365-day basis the same daily figure came from -0.1095.
  const ANNUALIZED_RATE = -0.109575;

  it("still projects from an annualized rate", () => {
    const projection = projectBufferDepletion(
      state,
      {
        annualizedFundingRate: ANNUALIZED_RATE,
        hedgedNotionalUsd: 100_000_000,
        dailyOperatingCostUsd: 0,
      },
      0,
    );
    expect(projection.dailyDrainUsd).toBeCloseTo(30_000, 3);
    expect(projection.daysToDepletion).toBeCloseTo(56.7, 1);
    expect(projection.coverageRatio).toBeCloseTo(0.017, 12);
  });

  it("still sizes a top-up to hold a target runway", () => {
    const projection = projectBufferDepletion(
      state,
      {
        annualizedFundingRate: ANNUALIZED_RATE,
        hedgedNotionalUsd: 100_000_000,
        dailyOperatingCostUsd: 0,
      },
      0,
    );
    // 90 days at 30,000/day needs 2,700,000; the buffer holds 1,700,000.
    expect(requiredTopUpUsd(state, projection, 90)).toBeCloseTo(1_000_000, 2);
    expect(requiredTopUpUsd(state, projection, 30)).toBe(0);
  });
});
