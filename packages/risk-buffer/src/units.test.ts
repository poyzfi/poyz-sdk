import { describe, expect, it } from "vitest";

import {
  DAYS_PER_YEAR,
  HOURS_PER_DAY,
  HOURS_PER_YEAR,
  HOURS_PER_YEAR_JULIAN,
  annualToHourlyRate,
  bpsToFraction,
  bufferRunwayDays,
  dailyToAnnualRate,
  fractionToBps,
  hourlyToAnnualRate,
  hourlyToDailyRate,
  perEightHourToHourlyRate,
} from "./units.js";

describe("interval constants", () => {
  it("uses the _DIRECTION 8-1 annualization basis of 24 * 365.25", () => {
    expect(HOURS_PER_DAY).toBe(24);
    expect(DAYS_PER_YEAR).toBe(365.25);
    // 24 * 365.25 = 8766 exactly; 365.25 is 1461/4 and exact in binary floats.
    expect(HOURS_PER_YEAR).toBe(8766);
    // The superseded 365-day basis. Pinned as a negative so a revert is loud.
    expect(HOURS_PER_YEAR).not.toBe(24 * 365);
  });

  it("keeps hours-per-year and days-per-year on the same basis", () => {
    // This identity is what leaves the daily-basis runway table untouched by the
    // move from the 365-day basis to 365.25. If it ever fails, b / f_d starts
    // moving with the choice of year length, which it must not.
    expect(HOURS_PER_YEAR / DAYS_PER_YEAR).toBe(HOURS_PER_DAY);
  });

  it("keeps the deprecated Julian alias pointing at the same value", () => {
    expect(HOURS_PER_YEAR_JULIAN).toBe(8766);
    expect(HOURS_PER_YEAR_JULIAN).toBe(HOURS_PER_YEAR);
  });
});

describe("annualization of a negative funding rate (worked check)", () => {
  // -0.01% per 8h is the 2022 bear-market average.
  const perEightHour = -0.0001;

  it("converts -0.01%/8h to -0.00125%/hr", () => {
    expect(perEightHourToHourlyRate(perEightHour)).toBeCloseTo(-0.0000125, 12);
  });

  it("converts -0.00125%/hr to -0.03%/day", () => {
    expect(hourlyToDailyRate(-0.0000125)).toBeCloseTo(-0.0003, 12);
  });

  it("annualizes -0.01%/8h to -10.9575%/yr on the 365.25-day basis", () => {
    /*
     * Hand calculation:
     *
     *   -0.0001 per 8h  / 8            = -0.0000125       per hour
     *   -0.0000125      * 24           = -0.0003          per day  (-0.03%/day)
     *   -0.0000125      * 24 * 365.25  = -0.10957500      per year (-10.9575%)
     *
     * On the superseded 365-day basis the same rate is
     * -0.0000125 * 24 * 365 = -0.10950000, that is -10.95%/yr -- the figure
     * earlier risk-spec drafts quoted in section 1.3. The two bases differ only
     * by the leap-day quarter, a ratio of 365.25 / 365 = 1.000685.
     * _DIRECTION.md 8-1 fixes 365.25, so -10.9575% is the figure this package
     * reports and -10.95% is the 365-day reading of the same rate, not a
     * disagreement about the rate.
     */
    const hourly = perEightHourToHourlyRate(perEightHour);
    expect(hourlyToAnnualRate(hourly)).toBeCloseTo(-0.109575, 10);
    expect(dailyToAnnualRate(hourlyToDailyRate(hourly))).toBeCloseTo(-0.109575, 10);
    // The 365-day reading, recorded so the 0.0075-point gap is never mistaken
    // for an error in the rate itself.
    expect(hourly * 24 * 365).toBeCloseTo(-0.1095, 10);
  });

  it("is not -3.65%/yr, the figure a secondary source produced by treating 8h as a day", () => {
    const annual = hourlyToAnnualRate(perEightHourToHourlyRate(perEightHour));
    expect(annual).not.toBeCloseTo(-0.0365, 3);
    // The mistaken figure is the correct one divided by three, which is the
    // 8h-to-day interval error. Recording that here so the two are never
    // confused again. -3.65% stays wrong under either year length: this test
    // is not a casualty of the change of annualization basis.
    expect(annual / 3).toBeCloseTo(-0.036525, 10);
    expect(annual / 3).toBeCloseTo(-0.0365, 4);
  });

  it("round-trips through the annual rate", () => {
    expect(annualToHourlyRate(hourlyToAnnualRate(-0.0000125))).toBeCloseTo(-0.0000125, 14);
  });
});

describe("bps conversion", () => {
  it("converts 300 bps to 0.03 and back", () => {
    expect(bpsToFraction(300)).toBeCloseTo(0.03, 12);
    expect(fractionToBps(0.03)).toBeCloseTo(300, 9);
  });
});

describe("bufferRunwayDays", () => {
  it("computes b / f_d", () => {
    expect(bufferRunwayDays(0.017, 0.0003)).toBeCloseTo(56.7, 1);
  });

  it("is unchanged by the annualization basis, because both inputs are per-day", () => {
    // 0.017 / 0.0003 = 56.666..., and no year length appears in that division.
    // This is the guard the change of annualization basis had to keep intact:
    // the runway figures the spec publishes are daily-basis and must not move.
    expect(bufferRunwayDays(0.017, 0.0003)).toBe(0.017 / 0.0003);
    expect(bufferRunwayDays(0.01, 0.0003)).toBeCloseTo(33.3, 1);
    expect(bufferRunwayDays(0.03, 0.03)).toBeCloseTo(1.0, 9);
  });

  it("returns null rather than Infinity when there is no drain", () => {
    expect(bufferRunwayDays(0.017, 0)).toBeNull();
    expect(bufferRunwayDays(0.017, -0.0001)).toBeNull();
  });

  it("returns zero when the buffer is empty and the regime is draining", () => {
    expect(bufferRunwayDays(0, 0.0003)).toBe(0);
  });

  it("rejects a non-finite input instead of producing NaN", () => {
    expect(() => bufferRunwayDays(Number.NaN, 0.0003)).toThrow(RangeError);
    expect(() => bufferRunwayDays(0.017, Number.NaN)).toThrow(RangeError);
    expect(() => bufferRunwayDays(-0.01, 0.0003)).toThrow(RangeError);
  });
});
