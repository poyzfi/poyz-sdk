#!/usr/bin/env node
/**
 * Turn one `poyz delta --json` envelope into step outputs, a job summary and a
 * workflow verdict.
 *
 * Kept as a file rather than inlined into action.yml so it can be read, and run,
 * on its own:
 *
 *   node summarize.mjs report.json <cli-exit-code> [fail-on-unavailable]
 *
 * Exit code mirrors the verdict: 0 keeps the workflow green, 1 fails it.
 */

import { appendFileSync, readFileSync } from "node:fs";

const EXIT_UNAVAILABLE = 3;
const EXIT_THRESHOLD = 4;

function append(variable, text) {
  const target = process.env[variable];
  if (target === undefined || target === "") {
    return;
  }
  appendFileSync(target, text);
}

function setOutput(name, value) {
  append("GITHUB_OUTPUT", `${name}=${value}\n`);
}

function bps(value) {
  if (typeof value !== "number") {
    return "";
  }
  return `${value > 0 ? "+" : ""}${value}`;
}

function usd(value) {
  if (typeof value !== "number") {
    return "not published";
  }
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function main() {
  const [reportPath, rawStatus, failOnUnavailable] = process.argv.slice(2);
  if (reportPath === undefined || rawStatus === undefined) {
    console.error("usage: summarize.mjs <report.json> <cli-exit-code> [fail-on-unavailable]");
    process.exit(1);
  }
  const status = Number(rawStatus);

  let envelope = null;
  let parseError = null;
  try {
    envelope = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }

  const data = envelope?.data ?? null;
  const available = envelope?.available === true;
  const deviation = data?.deviationBps ?? null;
  const threshold = data?.thresholdBps ?? null;
  const withinThreshold = data?.withinThreshold ?? null;

  setOutput("delta-bps", deviation === null ? "" : String(deviation));
  setOutput("within-threshold", withinThreshold === null ? "" : String(withinThreshold));
  setOutput("available", String(available));
  setOutput("exit-code", String(status));

  const verdict =
    status === EXIT_THRESHOLD
      ? "FAIL -- delta is outside the band"
      : status === EXIT_UNAVAILABLE
        ? "NO DATA -- the protocol has not published a delta"
        : status === 0
          ? "PASS -- delta is inside the band"
          : `ERROR -- the CLI exited ${status}`;

  const rows = [
    ["Verdict", verdict],
    ["Deviation", deviation === null ? "not published" : `${bps(deviation)} bps`],
    ["Threshold", threshold === null ? "not published" : `${threshold} bps`],
    ["Spot notional", usd(data?.spotNotionalUsd)],
    ["Short notional", usd(data?.shortNotionalUsd)],
    ["Source", envelope?.source ?? "unknown"],
    ["Cluster", envelope?.cluster ?? "unknown"],
    ["Observed", envelope?.observedAt ?? "not published"],
  ];

  const venues = Array.isArray(data?.venues) ? data.venues : [];
  const venueTable =
    venues.length === 0
      ? ""
      : [
          "",
          "| Venue | Market | Short notional | Weight |",
          "| --- | --- | ---: | ---: |",
          ...venues.map(
            (venue) =>
              `| ${venue.venue} | ${venue.market ?? "-"} | ${usd(venue.shortNotionalUsd)} | ${(
                (venue.weight ?? 0) * 100
              ).toFixed(2)}% |`,
          ),
        ].join("\n");

  const error = envelope?.error ?? null;
  const notes = [
    "",
    "Funding is a market rate and can be negative. A delta inside the band is a measurement, not a promise about the next block.",
  ];
  if (parseError !== null) {
    notes.push("", `The CLI output could not be parsed as JSON: ${parseError}`);
  }
  if (error !== null) {
    notes.push("", `\`${error.code}\`: ${error.message}`);
  }

  append(
    "GITHUB_STEP_SUMMARY",
    [
      "## POYZ delta monitor",
      "",
      "| Field | Value |",
      "| --- | --- |",
      ...rows.map(([label, value]) => `| ${label} | ${value} |`),
      venueTable,
      ...notes,
      "",
    ].join("\n"),
  );

  if (status === EXIT_THRESHOLD) {
    console.error(`poyz delta: outside the band (${bps(deviation)} bps against a ${threshold} bps threshold)`);
    process.exit(1);
  }
  if (status === EXIT_UNAVAILABLE) {
    if (failOnUnavailable === "true") {
      console.error("poyz delta: no delta was published and fail-on-unavailable is set");
      process.exit(1);
    }
    console.log("poyz delta: no delta published; not failing the workflow");
    process.exit(0);
  }
  if (status !== 0) {
    console.error(`poyz delta: the CLI exited ${status}`);
    process.exit(1);
  }
  process.exit(0);
}

main();
