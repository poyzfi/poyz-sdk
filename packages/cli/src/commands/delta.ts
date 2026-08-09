/**
 * `poyz delta` -- current delta deviation and the short exposure behind it.
 *
 * With `--max-deviation-bps` this is a monitor: it exits 4 when the measured
 * deviation is outside the band, which is what the GitHub Action in `action/`
 * turns into a failed workflow.
 */

import type { DeltaStatusView } from "@poyz/sdk";
import { clientConfig } from "../globals.js";
import { EXIT_THRESHOLD, usageError } from "../exit.js";
import { getNumber } from "../flags.js";
import {
  cell,
  deviationTone,
  formatBps,
  formatCount,
  formatPercent,
  formatTimestamp,
  formatUsd,
  heading,
  keyValues,
  row,
  sections,
  table,
  wrap,
} from "../render.js";
import {
  jsonResult,
  maybeRow,
  presentRows,
  textResult,
  unavailableResult,
  type CommandInput,
  type CommandSpec,
} from "./support.js";

const NAME = "delta";

export function renderDelta(input: CommandInput, view: DeltaStatusView, source: string): string {
  const { palette } = input;
  const absBps = view.deviationBps === null ? null : Math.abs(view.deviationBps);
  const tone = absBps === null ? "body" : deviationTone(absBps, view.thresholdBps);

  const rows = presentRows([
    maybeRow("cluster", input.globals.cluster, "muted"),
    maybeRow("source", source, "muted"),
    maybeRow("observed", formatTimestamp(view.capturedAtMs), "muted"),
    view.deviationBps === null
      ? null
      : row("deviation", {
          text:
            view.deviationRatio === null
              ? formatBps(view.deviationBps)
              : `${formatBps(view.deviationBps)}  (${formatPercent(view.deviationRatio, 2, true)})`,
          tone,
          align: "left",
        }),
    maybeRow("threshold", view.thresholdBps === null ? null : formatBps(view.thresholdBps).replace("+", ""), "body"),
    view.withinThreshold === null
      ? null
      : row("status", {
          text: view.withinThreshold ? "PASS" : "FAIL",
          tone: view.withinThreshold ? "balance" : "critical",
          align: "left",
        }),
    maybeRow("spot notional", view.spotNotionalUsd === null ? null : formatUsd(view.spotNotionalUsd), "balance"),
    maybeRow("short notional", view.shortNotionalUsd === null ? null : formatUsd(view.shortNotionalUsd), "short"),
    maybeRow("rebalances", view.rebalanceCount === null ? null : formatCount(view.rebalanceCount), "body"),
    maybeRow(
      "last rebalance",
      view.lastRebalanceAtMs === null ? null : formatTimestamp(view.lastRebalanceAtMs),
      "muted",
    ),
  ]);

  const venueBlock =
    view.venues.length === 0
      ? null
      : [
          `  ${palette.paint("muted", "Venue exposure")}`,
          table(
            palette,
            [
              cell("Venue", "muted"),
              cell("Status", "muted"),
              cell("Market", "muted"),
              cell("Short notional", "muted", "right"),
              cell("Weight", "muted", "right"),
              cell("Carry model", "muted"),
              cell("Carry APY", "muted", "right"),
            ],
            // A venue with no position prints "none", not a zero. The protocol
            // publishes venue data before it hedges anywhere, and a 0 there
            // would read as "we hedge nothing here" rather than "not started".
            view.venues.map((venue) => [
              cell(venue.venue, "short"),
              cell(venue.status ?? "-", venue.status === "live" ? "balance" : "muted"),
              cell(venue.market ?? "-", "body"),
              cell(venue.shortNotionalUsd === null ? "none" : formatUsd(venue.shortNotionalUsd), "body", "right"),
              cell(venue.weight === null ? "-" : formatPercent(venue.weight), "body", "right"),
              cell(venue.carryModel ?? "-", venue.carryModel === "borrow-fee-paying" ? "short" : "muted"),
              cell(
                venue.carryAnnualizedRate === null ? "-" : formatPercent(venue.carryAnnualizedRate),
                venue.carryAnnualizedRate !== null && venue.carryAnnualizedRate < 0 ? "short" : "balance",
                "right",
              ),
            ]),
          ),
        ].join("\n");

  const note =
    view.deviationBps === null
      ? wrap("The deviation itself was not published, so no band judgement is shown.", 78, "  ")
      : null;

  return sections(heading(palette, "POYZ delta"), keyValues(palette, rows), venueBlock, note);
}

export const deltaCommand: CommandSpec = {
  path: [NAME],
  summary: "Delta deviation between the spot leg and the perp short, per venue",
  usage: "poyz delta [--max-deviation-bps <n>] [--source api|chain|auto] [--json]",
  flags: [
    {
      name: "max-deviation-bps",
      type: "number",
      placeholder: "<n>",
      summary: "Exit 4 when the absolute deviation exceeds this many basis points",
    },
  ],
  notes: [
    "Exit 4 is reserved for the threshold breach, so a monitoring job can tell a breach from a network failure (1) or a metric that has not been published yet (3).",
  ],
  async run(input: CommandInput) {
    const limit = getNumber(input.flags, "max-deviation-bps");
    if (limit !== undefined && limit < 0) {
      throw usageError("--max-deviation-bps must not be negative");
    }

    const client = input.ctx.createClient(clientConfig(input.globals));
    const sourced = await client.getDelta({ source: input.globals.source });
    if (!sourced.available || sourced.data === null) {
      return unavailableResult({ input, command: NAME, metric: "Delta status", sourced });
    }

    const view = sourced.data;
    const absBps = view.deviationBps === null ? null : Math.abs(view.deviationBps);
    const breached = limit !== undefined && absBps !== null && absBps > limit;

    if (limit !== undefined && absBps === null) {
      return unavailableResult({
        input,
        command: NAME,
        metric: "Delta deviation in basis points",
        sourced: { ...sourced, detail: "the deviation was not published, so --max-deviation-bps cannot be evaluated" },
      });
    }

    const breachMessage =
      absBps === null || limit === undefined
        ? ""
        : `delta deviation ${formatBps(view.deviationBps ?? 0)} exceeds the ${limit} bps limit passed on the command line`;

    if (input.globals.json) {
      return jsonResult(
        {
          ok: !breached,
          command: NAME,
          cluster: input.globals.cluster,
          source: sourced.source,
          available: true,
          observedAtMs: sourced.observedAtMs,
          data: view,
          error: breached ? { code: "CLI_THRESHOLD_EXCEEDED", message: breachMessage } : null,
        },
        breached ? EXIT_THRESHOLD : 0,
      );
    }

    const body = renderDelta(input, view, sourced.source);
    return textResult(body, breached ? EXIT_THRESHOLD : 0, breached ? `poyz: ${breachMessage}\n` : "");
  },
};
