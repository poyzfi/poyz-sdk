/**
 * `poyz funding` -- the funding rate the short leg is currently paid.
 *
 * Funding is a market rate. When it is negative the short pays, which means the
 * protocol pays, and the output says so in words as well as in colour.
 */

import type { FundingStatusView } from "@poyz/sdk";
import { clientConfig } from "../globals.js";
import {
  cell,
  formatPercent,
  formatTimestamp,
  fundingTone,
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

const NAME = "funding";

export function renderFunding(input: CommandInput, view: FundingStatusView, source: string): string {
  const { palette } = input;
  // Net carry is the representative figure and it is signed. The gross funding
  // leg and the borrow-fee leg are shown separately below it, never summed into
  // one "yield" line: on the LP-pool venue the position holder always pays, so
  // adding the two as if they were the same kind of number reads as income when
  // the total is a cost.
  const net = view.netCarryRate;
  const negative = net !== null && net < 0;
  const rateTone = net === null ? "body" : fundingTone(net);

  const rows = presentRows([
    maybeRow("cluster", input.globals.cluster, "muted"),
    maybeRow("source", source, "muted"),
    maybeRow("observed", formatTimestamp(view.capturedAtMs), "muted"),
    net === null
      ? null
      : row("net carry", {
          text: `${formatPercent(net, 2, true)}${view.isEstimate ? "  estimate" : ""}`,
          tone: rateTone,
          align: "left",
        }),
    net === null
      ? null
      : row("direction", {
          text: negative ? "protocol pays" : "protocol receives",
          tone: negative ? "short" : "balance",
          align: "left",
        }),
    view.grossFundingRate === null
      ? null
      : row("gross funding", {
          text: formatPercent(view.grossFundingRate, 2, true),
          tone: fundingTone(view.grossFundingRate),
          align: "left",
        }),
    view.hedgeCostRate === null
      ? null
      : row("hedge cost", {
          text: formatPercent(view.hedgeCostRate, 2, true),
          tone: "short",
          align: "left",
        }),
    maybeRow("carry model", view.carryModel, "muted"),
    maybeRow("window", view.windowHours === null ? null : `${view.windowHours} h`, "body"),
    view.negativeCarry === null
      ? null
      : row("negative regime", {
          text: view.negativeCarry ? "yes" : "no",
          tone: view.negativeCarry ? "short" : "balance",
          align: "left",
        }),
  ]);

  const venueBlock =
    view.venues.length === 0
      ? null
      : [
          `  ${palette.paint("muted", "Per venue")}`,
          table(
            palette,
            [
              cell("Venue", "muted"),
              cell("Market", "muted"),
              cell("Carry model", "muted"),
              cell("Annualized", "muted", "right"),
            ],
            view.venues.map((venue) => [
              cell(venue.venue, "body"),
              cell(venue.market ?? "-", "body"),
              cell(venue.carryModel ?? "-", venue.carryModel === "borrow-fee-paying" ? "short" : "muted"),
              cell(formatPercent(venue.annualizedRate, 2, true), fundingTone(venue.annualizedRate), "right"),
            ]),
          ),
        ].join("\n");

  const notes: string[] = [
    "Carry is a market rate, not a fixed return, and it is signed. It turns negative when the perp trades below spot, and in that regime the short side pays instead of being paid.",
    "The venues do not carry the same kind of rate. A funding venue can pay the short or charge it; an LP-pool venue charges a borrow fee the position holder always pays, so that leg is a cost. Net carry is funding received less borrow fee paid, and it is the figure to read.",
  ];
  if (view.isEstimate) {
    notes.push("The rate above is labelled estimate: it is derived from the current interval, not from settled payments.");
  }

  return sections(
    heading(palette, "POYZ funding"),
    keyValues(palette, rows),
    venueBlock,
    notes.map((note) => wrap(note, 78, "  ")).join("\n\n"),
  );
}

export const fundingCommand: CommandSpec = {
  path: [NAME],
  summary: "Net carry on the hedged book, signed, with the funding and cost legs apart",
  usage: "poyz funding [--source api|chain|auto] [--json]",
  flags: [],
  notes: [
    "A negative rate is shown in magenta and spelled out as \"protocol pays\". It is a normal market state, not an error.",
  ],
  async run(input: CommandInput) {
    const client = input.ctx.createClient(clientConfig(input.globals));
    const sourced = await client.getFunding({ source: input.globals.source });
    if (!sourced.available || sourced.data === null) {
      return unavailableResult({ input, command: NAME, metric: "Funding status", sourced });
    }

    if (input.globals.json) {
      return jsonResult({
        ok: true,
        command: NAME,
        cluster: input.globals.cluster,
        source: sourced.source,
        available: true,
        observedAtMs: sourced.observedAtMs,
        data: sourced.data,
        error: null,
      });
    }
    return textResult(renderFunding(input, sourced.data, sourced.source));
  },
};
