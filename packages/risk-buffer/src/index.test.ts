import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as api from "./index.js";
import type {
  BufferProjection,
  BufferState,
  NegativeFundingScenario,
  PlaybookStage,
  PlaybookStep,
  PlaybookThresholds,
} from "./index.js";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

function readSourceFiles(): ReadonlyArray<{ readonly name: string; readonly text: string }> {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(join(SRC_DIR, name), "utf8") }));
}

describe("public surface from the earlier build is preserved", () => {
  it("still exports every runtime symbol the earlier build had", () => {
    const previouslyExported = [
      "coverageRatio",
      "coverageShortfallUsd",
      "projectBufferDepletion",
      "selectPlaybookStage",
      "negativeFundingPlaybook",
      "requiredTopUpUsd",
      "DEFAULT_PLAYBOOK_THRESHOLDS",
    ] as const;
    for (const name of previouslyExported) {
      expect(api).toHaveProperty(name);
      expect(api[name]).toBeDefined();
    }
  });

  it("still exports every type the earlier build had", () => {
    // Compile-time assertions. `npx tsc --noEmit` covers this file, so a missing
    // or renamed type fails the typecheck rather than the runtime.
    const state: BufferState = {
      balanceUsd: 1,
      coveredSupplyUsd: 100,
      targetCoverageRatio: 0.03,
    };
    const scenario: NegativeFundingScenario = {
      annualizedFundingRate: -0.1,
      hedgedNotionalUsd: 100,
      dailyOperatingCostUsd: 0,
    };
    const projection: BufferProjection = api.projectBufferDepletion(state, scenario, 0);
    const stage: PlaybookStage = api.selectPlaybookStage(projection);
    const step: PlaybookStep = api.negativeFundingPlaybook(stage);
    const thresholds: PlaybookThresholds = api.DEFAULT_PLAYBOOK_THRESHOLDS;

    expect(projection.dailyDrainUsd).toBeGreaterThan(0);
    expect(step.actions.length).toBeGreaterThan(0);
    expect(thresholds.unwindDays).toBe(7);
  });

  it("exports the two functions apps/service calls from /simulate", () => {
    expect(typeof api.estimateBufferDepletion).toBe("function");
    expect(typeof api.timeToYieldWipeout).toBe("function");
  });
});

describe("copy rules hold across the package", () => {
  it("contains none of the banned marketing phrases", () => {
    // Assembled at runtime so this test file does not itself contain the
    // phrases it forbids.
    const banned = [
      ["risk", "free"].join("-"),
      ["guaranteed", "yield"].join(" "),
      ["no", "downside"].join(" "),
      ["no", "risk"].join(" "),
    ];
    for (const { name, text } of readSourceFiles()) {
      const lowered = text.toLowerCase();
      for (const phrase of banned) {
        expect(`${name}: ${lowered.includes(phrase)}`).toBe(`${name}: false`);
      }
    }
  });

  it("is plain ASCII, so no emoji or check marks can reach the web", () => {
    for (const { name, text } of readSourceFiles()) {
      const offending = [...text].filter((character) => character.charCodeAt(0) > 126);
      expect(`${name}: ${offending.join("")}`).toBe(`${name}: `);
    }
  });
});

describe("the package is pure", () => {
  it("never reads the clock", () => {
    // Needles are assembled at runtime so this file does not itself contain the
    // call sites it forbids.
    const clockReads = [
      ["Date", "now"].join("."),
      `new ${"Date"}(`,
      ["performance", "now"].join("."),
    ];
    for (const { name, text } of readSourceFiles()) {
      for (const needle of clockReads) {
        expect(`${name} uses ${needle}: ${text.includes(needle)}`).toBe(
          `${name} uses ${needle}: false`,
        );
      }
    }
  });

  it("never reaches the network", () => {
    const networkCalls = [`fetch${"("}`, "XMLHttp" + "Request"];
    for (const { name, text } of readSourceFiles()) {
      for (const needle of networkCalls) {
        expect(`${name} uses ${needle}: ${text.includes(needle)}`).toBe(
          `${name} uses ${needle}: false`,
        );
      }
    }
  });

  it("has no runtime dependencies", () => {
    const packageJson: unknown = JSON.parse(
      readFileSync(join(SRC_DIR, "..", "package.json"), "utf8"),
    );
    const dependencies = (packageJson as { dependencies?: Record<string, string> }).dependencies;
    expect(dependencies ?? {}).toEqual({});
  });

  it("imports nothing outside the package except node builtins in tests", () => {
    for (const { name, text } of readSourceFiles()) {
      if (name.endsWith(".test.ts")) {
        continue;
      }
      const importPaths = [...text.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
      const external = importPaths.filter((path) => !path.startsWith("./"));
      expect(`${name} imports ${external.join(", ")}`).toBe(`${name} imports `);
    }
  });
});
