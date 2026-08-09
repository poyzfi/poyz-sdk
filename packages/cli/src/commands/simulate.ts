/**
 * `poyz simulate` -- offline funding arithmetic.
 *
 * No network, no wallet, no chain: it runs the same buffer model the protocol
 * uses on numbers the caller supplies, which makes it the honest way to ask
 * "what does a negative funding regime do to this position and to the buffer
 * behind it" before committing anything.
 *
 * The result carries the SDK's disclaimer and this command always prints it. A
 * projection over a market rate is a projection.
 */

import { simulateFunding, type FundingSimulationResult } from "@poyz/sdk";
import { usageError } from "../exit.js";
import { getNumber } from "../flags.js";
import type { Tone } from "../color.js";
import { bullet, formatPercent, formatUsd, heading, keyValues, row, sections, wrap } from "../render.js";
import { jsonResult, textResult, type CommandInput, type CommandSpec } from "./support.js";

const NAME = "simulate";

const STAGE_TONE: Readonly<Record<string, Tone>> = {
  nominal: "balance",
  watch: "warn",
  throttle: "warn",
  unwind: "critical",
};

/** How urgent a runway is. A long runway is not a warning; a short one is. */
function depletionTone(days: number | null): Tone {
  if (days === null) {
    return "balance";
  }
  if (days <= 30) {
    return "critical";
  }
  if (days <= 120) {
    return "warn";
  }
  return "body";
}

export function renderSimulation(input: CommandInput, result: FundingSimulationResult): string {
  const { palette } = input;
  const negative = result.isNegativeRegime;

  const inputs = keyValues(
    palette,
    [
      row("position", { text: formatUsd(result.amountUsd), tone: "body", align: "left" }),
      row("horizon", { text: `${result.days} days`, tone: "body", align: "left" }),
      row("annualized rate", {
        text: formatPercent(result.annualizedRate, 2, true),
        tone: negative ? "short" : "balance",
        align: "left",
      }),
      row("regime", {
        text: negative ? "negative funding -- the protocol pays" : "positive funding -- the protocol receives",
        tone: negative ? "short" : "balance",
        align: "left",
      }),
    ],
    "    ",
  );

  const outcome = keyValues(
    palette,
    [
      row("funding over horizon", {
        text: formatUsd(result.grossFundingUsd),
        tone: result.grossFundingUsd < 0 ? "short" : "balance",
        align: "left",
      }),
      row("per day", {
        text: formatUsd(result.dailyFundingUsd),
        tone: result.dailyFundingUsd < 0 ? "short" : "balance",
        align: "left",
      }),
      row("ending value", {
        text: formatUsd(result.endingValueUsd),
        tone: result.endingValueUsd < result.amountUsd ? "warn" : "balance",
        align: "left",
      }),
    ],
    "    ",
  );

  const bufferBlock =
    result.buffer === null
      ? wrap(
          "No buffer view: pass --buffer <usd> and --supply <usd> to model the risk buffer runway alongside the position.",
          76,
          "    ",
        )
      : sections(
          `  ${palette.paint("muted", "Risk buffer")}`,
          keyValues(
            palette,
            [
              row("coverage", { text: formatPercent(result.buffer.coverageRatio), tone: "body", align: "left" }),
              row("daily net flow", {
                text: formatUsd(result.buffer.dailyNetFlowUsd),
                tone: result.buffer.dailyNetFlowUsd < 0 ? "short" : "balance",
                align: "left",
              }),
              row("daily drain", {
                text: formatUsd(result.buffer.dailyDrainUsd),
                tone: result.buffer.dailyDrainUsd > 0 ? "warn" : "balance",
                align: "left",
              }),
              row("days to depletion", {
                text:
                  result.buffer.daysToDepletion === null
                    ? "not depleting at this rate"
                    : `${result.buffer.daysToDepletion.toFixed(1)} days`,
                tone: depletionTone(result.buffer.daysToDepletion),
                align: "left",
              }),
              row("stage", {
                text: result.buffer.stage,
                tone: STAGE_TONE[result.buffer.stage] ?? "body",
                align: "left",
              }),
              row("restrict issuance", {
                text: result.buffer.restrictIssuance ? "yes" : "no",
                tone: result.buffer.restrictIssuance ? "warn" : "balance",
                align: "left",
              }),
              row("reduce hedge notional", {
                text: result.buffer.reduceHedgeNotional ? "yes" : "no",
                tone: result.buffer.reduceHedgeNotional ? "warn" : "balance",
                align: "left",
              }),
            ],
            "    ",
          ),
          result.buffer.actions.length === 0
            ? null
            : sections(
                `    ${palette.paint("muted", "Playbook")}`,
                result.buffer.actions.map((action) => bullet(action, 76, "      ")).join("\n"),
              ),
        );

  return sections(
    heading(palette, "POYZ funding simulation"),
    `  ${palette.paint("muted", "Inputs")}`,
    inputs,
    `  ${palette.paint("muted", "Outcome")}`,
    outcome,
    bufferBlock,
    wrap(result.disclaimer, 78, "  "),
  );
}

export const simulateCommand: CommandSpec = {
  path: [NAME],
  summary: "Project funding over a horizon, including the negative regime",
  usage: "poyz simulate --amount <usd> --days <n> --rate <annualized> [--buffer <usd>] [--supply <usd>] [--json]",
  flags: [
    { name: "amount", type: "number", placeholder: "<usd>", summary: "Position size in dollars" },
    { name: "days", type: "number", placeholder: "<n>", summary: "Horizon in days" },
    {
      name: "rate",
      type: "number",
      placeholder: "<annualized>",
      summary: "Annualized funding rate as a decimal, for example 0.12 or -0.15",
    },
    { name: "buffer", type: "number", placeholder: "<usd>", summary: "Risk buffer balance in dollars" },
    { name: "supply", type: "number", placeholder: "<usd>", summary: "Synthetic supply the buffer covers, in dollars" },
    { name: "daily-cost", type: "number", placeholder: "<usd>", summary: "Daily operating cost charged to the buffer" },
  ],
  notes: [
    "Runs entirely offline. No RPC endpoint, no API and no wallet are touched.",
    "Pass a negative --rate to model the regime where the short side pays; --buffer and --supply then show the buffer runway and the playbook stage.",
  ],
  async run(input: CommandInput) {
    const amountUsd = getNumber(input.flags, "amount");
    const days = getNumber(input.flags, "days");
    const annualizedRate = getNumber(input.flags, "rate");

    if (amountUsd === undefined || days === undefined || annualizedRate === undefined) {
      throw usageError(
        "--amount, --days and --rate are all required",
        "Example: poyz simulate --amount 100000 --days 90 --rate -0.15 --buffer 20000 --supply 1000000",
      );
    }
    if (amountUsd <= 0) {
      throw usageError("--amount must be greater than zero");
    }
    if (days <= 0) {
      throw usageError("--days must be greater than zero");
    }

    const bufferBalanceUsd = getNumber(input.flags, "buffer");
    const coveredSupplyUsd = getNumber(input.flags, "supply");
    const dailyOperatingCostUsd = getNumber(input.flags, "daily-cost");

    const scenario: {
      annualizedRate: number;
      bufferBalanceUsd?: number;
      coveredSupplyUsd?: number;
      dailyOperatingCostUsd?: number;
    } = { annualizedRate };
    if (bufferBalanceUsd !== undefined) {
      scenario.bufferBalanceUsd = bufferBalanceUsd;
    }
    if (coveredSupplyUsd !== undefined) {
      scenario.coveredSupplyUsd = coveredSupplyUsd;
    }
    if (dailyOperatingCostUsd !== undefined) {
      scenario.dailyOperatingCostUsd = dailyOperatingCostUsd;
    }

    const result = simulateFunding({
      amountUsd,
      days,
      fundingScenario: scenario,
      nowMs: input.ctx.now(),
    });

    if (input.globals.json) {
      return jsonResult({
        ok: true,
        command: NAME,
        cluster: input.globals.cluster,
        source: null,
        available: true,
        observedAtMs: input.ctx.now(),
        data: result,
        error: null,
      });
    }
    return textResult(renderSimulation(input, result));
  },
};
