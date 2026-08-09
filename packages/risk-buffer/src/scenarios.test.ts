import { describe, expect, it } from "vitest";

import {
  BASELINE_CARRY_REGIME,
  BUFFER_SIZE_SCENARIOS,
  FTX_NEGATIVE_FUNDING_EPISODE_DAYS,
  FUNDING_STRESS_SCENARIOS,
  MEASURED_CARRY_REGIMES,
  MEASURED_CARRY_RUNWAY_TABLE,
  RISK_SPEC_RUNWAY_TABLE,
  SOL_PERP_FUNDING_SNAPSHOT_2026_08_09,
  TIER_B_DAILY_FUNDING_CAP,
  TIER_B_HOURLY_FUNDING_CAP,
  buildRunwayTable,
  carryRegimeAsStressScenario,
} from "./scenarios.js";
import { HOURS_PER_YEAR_JULIAN, dailyToAnnualRate } from "./units.js";

/**
 * The published risk-spec 1.4 table, transcribed by hand from the document so
 * the test compares the code against the spec rather than against itself.
 *
 * Rows are buffer size b, columns are daily funding cost f_d. Values are days,
 * to one decimal, computed as b / f_d.
 */
const RISK_SPEC_TABLE: ReadonlyArray<{
  readonly bufferScenarioId: string;
  readonly bufferFraction: number;
  readonly cells: ReadonlyArray<{
    readonly fundingScenarioId: string;
    readonly dailyCostFraction: number;
    readonly expectedDays: number;
  }>;
}> = [
  {
    bufferScenarioId: "b_100bps",
    bufferFraction: 0.01,
    cells: [
      { fundingScenarioId: "mild", dailyCostFraction: 0.00015, expectedDays: 66.7 },
      { fundingScenarioId: "moderate", dailyCostFraction: 0.0003, expectedDays: 33.3 },
      { fundingScenarioId: "severe", dailyCostFraction: 0.0006, expectedDays: 16.7 },
      { fundingScenarioId: "extreme", dailyCostFraction: 0.00125, expectedDays: 8.0 },
      { fundingScenarioId: "tier_b_cap", dailyCostFraction: 0.03, expectedDays: 0.3 },
    ],
  },
  {
    bufferScenarioId: "b_170bps",
    bufferFraction: 0.017,
    cells: [
      { fundingScenarioId: "mild", dailyCostFraction: 0.00015, expectedDays: 113.3 },
      { fundingScenarioId: "moderate", dailyCostFraction: 0.0003, expectedDays: 56.7 },
      { fundingScenarioId: "severe", dailyCostFraction: 0.0006, expectedDays: 28.3 },
      { fundingScenarioId: "extreme", dailyCostFraction: 0.00125, expectedDays: 13.6 },
      { fundingScenarioId: "tier_b_cap", dailyCostFraction: 0.03, expectedDays: 0.6 },
    ],
  },
  {
    bufferScenarioId: "b_300bps",
    bufferFraction: 0.03,
    cells: [
      { fundingScenarioId: "mild", dailyCostFraction: 0.00015, expectedDays: 200.0 },
      { fundingScenarioId: "moderate", dailyCostFraction: 0.0003, expectedDays: 100.0 },
      { fundingScenarioId: "severe", dailyCostFraction: 0.0006, expectedDays: 50.0 },
      { fundingScenarioId: "extreme", dailyCostFraction: 0.00125, expectedDays: 24.0 },
      { fundingScenarioId: "tier_b_cap", dailyCostFraction: 0.03, expectedDays: 1.0 },
    ],
  },
  {
    bufferScenarioId: "b_500bps",
    bufferFraction: 0.05,
    cells: [
      { fundingScenarioId: "mild", dailyCostFraction: 0.00015, expectedDays: 333.3 },
      { fundingScenarioId: "moderate", dailyCostFraction: 0.0003, expectedDays: 166.7 },
      { fundingScenarioId: "severe", dailyCostFraction: 0.0006, expectedDays: 83.3 },
      { fundingScenarioId: "extreme", dailyCostFraction: 0.00125, expectedDays: 40.0 },
      { fundingScenarioId: "tier_b_cap", dailyCostFraction: 0.03, expectedDays: 1.7 },
    ],
  },
];

describe("risk-spec 1.4 stress table is reproduced exactly", () => {
  it("has one cell per buffer size and funding scenario", () => {
    expect(BUFFER_SIZE_SCENARIOS).toHaveLength(4);
    expect(FUNDING_STRESS_SCENARIOS).toHaveLength(5);
    expect(RISK_SPEC_RUNWAY_TABLE).toHaveLength(20);
  });

  for (const row of RISK_SPEC_TABLE) {
    for (const cell of row.cells) {
      const bufferLabel = (row.bufferFraction * 100).toFixed(1);
      const fundingLabel = (cell.dailyCostFraction * 100).toFixed(3);
      it(`b=${bufferLabel}% at f_d=${fundingLabel}%/day gives ${cell.expectedDays.toFixed(1)} days`, () => {
        const found = RISK_SPEC_RUNWAY_TABLE.find(
          (candidate) =>
            candidate.bufferScenarioId === row.bufferScenarioId &&
            candidate.fundingScenarioId === cell.fundingScenarioId,
        );
        expect(found).toBeDefined();
        expect(found?.bufferFraction).toBeCloseTo(row.bufferFraction, 12);
        expect(found?.dailyCostFraction).toBeCloseTo(cell.dailyCostFraction, 12);
        expect(found?.runwayDays).toBeCloseTo(cell.expectedDays, 1);
      });
    }
  }

  it("reproduces the spec's own reading: 1.7% covers about one FTX-scale episode at -0.03%/day", () => {
    const cell = RISK_SPEC_RUNWAY_TABLE.find(
      (candidate) =>
        candidate.bufferScenarioId === "b_170bps" && candidate.fundingScenarioId === "moderate",
    );
    expect(cell?.runwayDays).toBeCloseTo(56.7, 1);
    expect(cell?.runwayDays ?? 0).toBeGreaterThan(FTX_NEGATIVE_FUNDING_EPISODE_DAYS.maxDays);
    expect(cell?.runwayDays ?? 0).toBeLessThan(FTX_NEGATIVE_FUNDING_EPISODE_DAYS.maxDays * 1.25);
  });

  it("reproduces the spec's second reading: 1.7% covers about 14 days of a severe -0.125%/day regime", () => {
    const cell = RISK_SPEC_RUNWAY_TABLE.find(
      (candidate) =>
        candidate.bufferScenarioId === "b_170bps" && candidate.fundingScenarioId === "extreme",
    );
    expect(cell?.runwayDays).toBeCloseTo(13.6, 1);
  });
});

describe("funding scenario annual rates", () => {
  it("labels the columns with the annual rates the 365.25-day basis gives", () => {
    /*
     * f_d * 365.25 for each column. The 365-day readings the earlier build
     * asserted are shown alongside so the shift is visible and small:
     *
     *   mild     0.00015  -> -0.0547875   (365-day: -0.05475)
     *   moderate 0.0003   -> -0.1095750   (365-day: -0.10950)
     *   severe   0.0006   -> -0.2191500   (365-day: -0.21900)
     *   extreme  0.00125  -> -0.4565625   (365-day: -0.45625)
     *
     * The dailyCostFraction values are untouched, which is why the runway table
     * above is unchanged.
     */
    const byId = new Map(FUNDING_STRESS_SCENARIOS.map((scenario) => [scenario.id, scenario]));
    expect(byId.get("mild")?.annualizedRate).toBeCloseTo(-0.0547875, 8);
    expect(byId.get("moderate")?.annualizedRate).toBeCloseTo(-0.109575, 8);
    expect(byId.get("severe")?.annualizedRate).toBeCloseTo(-0.21915, 8);
    expect(byId.get("extreme")?.annualizedRate).toBeCloseTo(-0.4565625, 8);
  });

  it("every scenario's annual rate is its daily cost annualized, signed negative", () => {
    for (const scenario of FUNDING_STRESS_SCENARIOS) {
      expect(scenario.annualizedRate).toBeCloseTo(-dailyToAnnualRate(scenario.dailyCostFraction), 10);
      expect(scenario.annualizedRate).toBeLessThan(0);
    }
  });
});

describe("Tier-B cap", () => {
  it("keeps 0.125%/hr and 0.125%/day apart", () => {
    expect(TIER_B_HOURLY_FUNDING_CAP).toBeCloseTo(0.00125, 12);
    expect(TIER_B_DAILY_FUNDING_CAP).toBeCloseTo(0.03, 12);
    const extreme = FUNDING_STRESS_SCENARIOS.find((scenario) => scenario.id === "extreme");
    // The extreme column is 0.125% per day, which shares digits with the hourly
    // cap and is 24 times milder.
    expect(extreme?.dailyCostFraction).toBeCloseTo(TIER_B_HOURLY_FUNDING_CAP, 12);
    expect(TIER_B_DAILY_FUNDING_CAP / (extreme?.dailyCostFraction ?? 1)).toBeCloseTo(24, 9);
  });
});

describe("buildRunwayTable", () => {
  it("builds an arbitrary grid", () => {
    const table = buildRunwayTable(
      [{ id: "custom", label: "2% of supply", bufferFraction: 0.02, note: "test row" }],
      [
        {
          id: "flat",
          label: "flat",
          dailyCostFraction: 0.0002,
          annualizedRate: -0.073,
          note: "test column",
        },
      ],
    );
    expect(table).toHaveLength(1);
    expect(table[0]?.runwayDays).toBeCloseTo(100, 9);
  });
});

describe("observed funding snapshot", () => {
  it("carries its observation date and reproduces the recorded annual rates", () => {
    expect(SOL_PERP_FUNDING_SNAPSHOT_2026_08_09.observedAtIso).toBe("2026-08-09");
    // _DIRECTION.md 8-1 annualizes venue funding at 24 * 365.25 = 8766.
    expect(HOURS_PER_YEAR_JULIAN).toBe(8766);
    expect(SOL_PERP_FUNDING_SNAPSHOT_2026_08_09.hourlyRate24h * HOURS_PER_YEAR_JULIAN).toBeCloseTo(
      -1.053,
      3,
    );
    expect(SOL_PERP_FUNDING_SNAPSHOT_2026_08_09.hourlyRate30d * HOURS_PER_YEAR_JULIAN).toBeCloseTo(
      -0.433,
      3,
    );
    expect(SOL_PERP_FUNDING_SNAPSHOT_2026_08_09.hourlyRate1y * HOURS_PER_YEAR_JULIAN).toBeCloseTo(
      -0.358,
      3,
    );
  });

  it("records that the observed regime is negative on three of four windows", () => {
    const rates = [
      SOL_PERP_FUNDING_SNAPSHOT_2026_08_09.hourlyRate24h,
      SOL_PERP_FUNDING_SNAPSHOT_2026_08_09.hourlyRate7d,
      SOL_PERP_FUNDING_SNAPSHOT_2026_08_09.hourlyRate30d,
      SOL_PERP_FUNDING_SNAPSHOT_2026_08_09.hourlyRate1y,
    ];
    expect(rates.filter((rate) => rate < 0)).toHaveLength(3);
  });
});

describe("measured carry regimes are the current regime, not a scenario", () => {
  /*
   * The four venue-published windows (_DIRECTION.md 8-1, observed 2026-08-09),
   * with the arithmetic written out. APR = f_h * 24 * 365.25; f_d = f_h * 24.
   *
   *   window  f_h (%/hr)   APR            f_d           runway at b=3%
   *   24h     -0.012013    -105.31%       0.00288312    0.03/0.00288312 = 10.41 d
   *   7d      +0.002704     +23.70%       (positive)    no drain, no runway
   *   30d     -0.004937     -43.28%       0.00118488    0.03/0.00118488 = 25.32 d
   *   1y      -0.004086     -35.82%       0.00098064    0.03/0.00098064 = 30.59 d
   *
   * risk-spec 1.3 prints the b=3% row as 10.4 / 25.3 / 30.6 days.
   */
  const EXPECTED: ReadonlyArray<{
    readonly id: string;
    readonly hourlyRate: number;
    readonly annualizedRate: number;
    readonly protocolPays: boolean;
    readonly runwayAt3Pct: number | null;
  }> = [
    {
      id: "measured_24h",
      hourlyRate: -0.00012013,
      annualizedRate: -1.05305958,
      protocolPays: true,
      runwayAt3Pct: 10.4,
    },
    {
      id: "measured_7d",
      hourlyRate: 0.00002704,
      annualizedRate: 0.23703264,
      protocolPays: false,
      runwayAt3Pct: null,
    },
    {
      id: "measured_30d",
      hourlyRate: -0.00004937,
      annualizedRate: -0.43277742,
      protocolPays: true,
      runwayAt3Pct: 25.3,
    },
    {
      id: "measured_1y",
      hourlyRate: -0.00004086,
      annualizedRate: -0.35817876,
      protocolPays: true,
      runwayAt3Pct: 30.6,
    },
  ];

  it("carries all four windows in the order the source records them", () => {
    expect(MEASURED_CARRY_REGIMES.map((regime) => regime.id)).toEqual(
      EXPECTED.map((row) => row.id),
    );
    for (const regime of MEASURED_CARRY_REGIMES) {
      expect(regime.source).toContain("2026-08-09");
      expect(regime.source).toContain("_DIRECTION.md 8-1");
    }
  });

  it("treats the 1-year window as the baseline regime and it is negative", () => {
    expect(BASELINE_CARRY_REGIME.id).toBe("measured_1y");
    expect(BASELINE_CARRY_REGIME.protocolPays).toBe(true);
    expect(BASELINE_CARRY_REGIME.annualizedRate).toBeCloseTo(-0.35817876, 8);
    expect(BASELINE_CARRY_REGIME.annualizedRate).toBeLessThan(0);
  });

  for (const row of EXPECTED) {
    it(`${row.id} annualizes to ${(row.annualizedRate * 100).toFixed(2)}% on the 365.25-day basis`, () => {
      const regime = MEASURED_CARRY_REGIMES.find((candidate) => candidate.id === row.id);
      expect(regime).toBeDefined();
      expect(regime?.hourlyRate).toBeCloseTo(row.hourlyRate, 12);
      expect(regime?.dailyRate).toBeCloseTo(row.hourlyRate * 24, 12);
      expect(regime?.annualizedRate).toBeCloseTo(row.annualizedRate, 8);
      expect(regime?.annualizedRate).toBeCloseTo(row.hourlyRate * HOURS_PER_YEAR_JULIAN, 12);
      expect(regime?.protocolPays).toBe(row.protocolPays);
    });

    it(`${row.id} gives a 3% buffer ${row.runwayAt3Pct === null ? "no runway" : `${row.runwayAt3Pct.toFixed(1)} days`}`, () => {
      const cell = MEASURED_CARRY_RUNWAY_TABLE.find(
        (candidate) =>
          candidate.bufferScenarioId === "b_300bps" && candidate.fundingScenarioId === row.id,
      );
      expect(cell).toBeDefined();
      if (row.runwayAt3Pct === null) {
        // Positive carry has no drain to run out of. A number here would be an
        // invention, so the cell is empty.
        expect(cell?.runwayDays).toBeNull();
      } else {
        expect(cell?.runwayDays).toBeCloseTo(row.runwayAt3Pct, 1);
        expect(cell?.runwayDays).toBeCloseTo(0.03 / Math.abs(row.hourlyRate * 24), 9);
      }
    });
  }

  it("gives the Ethena-anchor buffer 17.3 days at the baseline regime", () => {
    // 0.017 / 0.00098064 = 17.3356, which risk-spec 1.3 prints as 17.3.
    const cell = MEASURED_CARRY_RUNWAY_TABLE.find(
      (candidate) =>
        candidate.bufferScenarioId === "b_170bps" && candidate.fundingScenarioId === "measured_1y",
    );
    expect(cell?.runwayDays).toBeCloseTo(17.3, 1);
  });

  it("adapts a measured regime into a runway-table column, cost-signed", () => {
    const column = carryRegimeAsStressScenario(BASELINE_CARRY_REGIME);
    expect(column.dailyCostFraction).toBeCloseTo(0.00098064, 12);
    expect(column.annualizedRate).toBeCloseTo(-0.35817876, 8);
    // The positive window maps to a negative cost, which reads as no drain.
    const positive = MEASURED_CARRY_REGIMES.find((regime) => regime.id === "measured_7d");
    expect(positive).toBeDefined();
    expect(carryRegimeAsStressScenario(positive ?? BASELINE_CARRY_REGIME).dailyCostFraction,
    ).toBeLessThan(0);
  });
});
