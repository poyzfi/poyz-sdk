/**
 * Rendering: formatters, the no-fake-zeros rule, and colour on and off.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cell,
  createPalette,
  formatBps,
  formatPercent,
  formatUsd,
  keyValues,
  row,
  runCli,
  stripAnsi,
  table,
} from "../dist/poyz.mjs";
import {
  DELTA_VIEW,
  DELTA_VIEW_SPARSE,
  FUNDING_VIEW_NEGATIVE,
  FUNDING_VIEW_POSITIVE,
  makeContext,
  sourced,
} from "./helpers.mjs";

function fundingContext(view, overrides = {}) {
  return makeContext({
    createClient: () => ({
      async getFunding() {
        return sourced(view);
      },
    }),
    ...overrides,
  });
}

test("money, percentages and basis points format the way the tables read", () => {
  assert.equal(formatUsd(12340000), "$12,340,000.00");
  assert.equal(formatUsd(-3698.6301), "-$3,698.63");
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatPercent(0.1132), "11.32%");
  assert.equal(formatPercent(0.0042, 2, true), "+0.42%");
  assert.equal(formatPercent(-0.1842, 2, true), "-18.42%");
  assert.equal(formatBps(42), "+42 bps");
  assert.equal(formatBps(-42), "-42 bps");
});

test("negative carry is spelled out, not only coloured", async () => {
  const { ctx } = fundingContext(FUNDING_VIEW_NEGATIVE);
  const result = await runCli(["funding"], ctx);
  // The prose is word-wrapped, so match against a whitespace-normalised copy.
  // Asserting on the raw string would break every time a sentence reflows,
  // which says nothing about whether the warning is present.
  const flat = result.stdout.replace(/\s+/g, " ");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /-18\.42%/);
  assert.match(result.stdout, /protocol pays/);
  assert.match(result.stdout, /estimate/);
  assert.match(flat, /can turn negative|turns negative/);
});

test("the two carry legs are shown apart and never summed into one yield", async () => {
  const { ctx } = fundingContext(FUNDING_VIEW_NEGATIVE);
  const result = await runCli(["funding"], ctx);
  const flat = result.stdout.replace(/\s+/g, " ");
  assert.match(result.stdout, /net carry/, "net is the representative line");
  assert.match(result.stdout, /gross funding/);
  assert.match(result.stdout, /hedge cost/);
  assert.match(result.stdout, /borrow-fee-paying/, "the cost leg is labelled as one");
  assert.match(flat, /Net carry is funding received less borrow fee paid/);
  assert.doesNotMatch(flat, /funding yield/i, "carry is not advertised as a yield");
});

test("positive funding says the protocol receives and drops the estimate label", async () => {
  const { ctx } = fundingContext(FUNDING_VIEW_POSITIVE);
  const result = await runCli(["funding"], ctx);
  assert.match(result.stdout, /protocol receives/);
  assert.doesNotMatch(result.stdout, /\+11\.32%\s+estimate/);
});

test("fields the protocol did not publish are left out, never rendered as zero", async () => {
  const { ctx } = makeContext({
    createClient: () => ({
      async getDelta() {
        return sourced(DELTA_VIEW_SPARSE);
      },
    }),
  });
  const result = await runCli(["delta"], ctx);
  assert.equal(result.exitCode, 0);
  for (const label of ["spot notional", "short notional", "rebalances", "threshold", "deviation", "last rebalance"]) {
    const asRow = new RegExp(`^\\s+${label}\\s{2,}\\S`, "m");
    assert.doesNotMatch(result.stdout, asRow, `sparse output should not render a "${label}" row`);
  }
  assert.ok(!result.stdout.includes("$0.00"), "sparse output must not invent a zero");
  assert.match(result.stdout, /was not published/);
});

test("populated delta renders the venue table", async () => {
  const { ctx } = makeContext({
    createClient: () => ({
      async getDelta() {
        return sourced(DELTA_VIEW);
      },
    }),
  });
  const result = await runCli(["delta"], ctx);
  assert.match(result.stdout, /Venue exposure/);
  assert.match(result.stdout, /velocity/);
  assert.match(result.stdout, /jupiter-perps/);
  assert.match(result.stdout, /80\.00%/);
});

test("no escape sequences when colour is off", async () => {
  const { ctx } = fundingContext(FUNDING_VIEW_NEGATIVE, { isTty: false });
  const result = await runCli(["funding"], ctx);
  assert.equal(stripAnsi(result.stdout), result.stdout);
  assert.ok(!result.stdout.includes("\u001B"), "colour must be off when stdout is not a terminal");
});

test("--no-color strips colour even on a terminal", async () => {
  const { ctx } = fundingContext(FUNDING_VIEW_NEGATIVE, { isTty: true });
  const result = await runCli(["funding", "--no-color"], ctx);
  assert.ok(!result.stdout.includes("\u001B"));
});

test("NO_COLOR strips colour even on a terminal", async () => {
  const { ctx } = fundingContext(FUNDING_VIEW_NEGATIVE, { isTty: true, env: { NO_COLOR: "1" } });
  const result = await runCli(["funding"], ctx);
  assert.ok(!result.stdout.includes("\u001B"));
});

test("colour is emitted as 24-bit truecolor on a terminal", async () => {
  const { ctx } = fundingContext(FUNDING_VIEW_NEGATIVE, { isTty: true });
  const result = await runCli(["funding"], ctx);
  assert.ok(result.stdout.includes("\u001B[38;2;214;66;127m"), "the short magenta must be truecolor #D6427F");
});

test("--json emits one parseable object and no escape sequences", async () => {
  const { ctx } = fundingContext(FUNDING_VIEW_NEGATIVE, { isTty: true });
  const result = await runCli(["funding", "--json"], ctx);
  assert.ok(!result.stdout.includes("\u001B"));
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(payload).sort(), [
    "available",
    "cluster",
    "command",
    "data",
    "error",
    "observedAt",
    "ok",
    "source",
  ]);
  assert.equal(payload.command, "funding");
  assert.equal(payload.source, "api");
  assert.equal(payload.observedAt, "2026-02-02T02:40:00.000Z");
  assert.equal(payload.data.annualizedRate, -0.1842);
});

test("--json reports an unavailable metric as null data, not a zero", async () => {
  const { ctx } = makeContext({
    createClient: () => ({
      async getFunding() {
        return { source: "chain", available: false, observedAtMs: null, detail: "no funding interval settled yet", data: null };
      },
    }),
  });
  const result = await runCli(["funding", "--json"], ctx);
  assert.equal(result.exitCode, 3);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, false);
  assert.equal(payload.data, null);
  assert.equal(payload.observedAt, null);
  assert.match(payload.error.message, /no funding interval settled yet/);
});

test("table columns stay aligned once the escape sequences are removed", () => {
  const painted = table(
    createPalette(true),
    [cell("Venue", "muted"), cell("Weight", "muted", "right")],
    [
      [cell("velocity", "short"), cell("80.00%", "body", "right")],
      [cell("jupiter-perps", "short"), cell("20.00%", "body", "right")],
    ],
  );
  const lines = stripAnsi(painted).split("\n");
  const widths = new Set(lines.map((line) => line.length));
  assert.equal(widths.size, 1, `all table lines should be the same width, got ${[...widths].join(", ")}`);
});

test("label blocks align on the longest label", () => {
  const block = keyValues(createPalette(false), [row("a", "1"), row("longer label", "2")]);
  const [first, second] = block.split("\n");
  assert.equal(first.indexOf("1"), second.indexOf("2"));
});
