/** Argument parsing, environment fallback, and the colour decision. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXIT_USAGE,
  GLOBAL_FLAGS,
  createContext,
  getBoolean,
  getNumber,
  getString,
  parseFlags,
  resolveGlobals,
  runCli,
  shouldUseColor,
  stripAnsi,
} from "../dist/poyz.mjs";
import { makeContext } from "./helpers.mjs";

const SPECS = [
  ...GLOBAL_FLAGS,
  { name: "max-deviation-bps", type: "number", placeholder: "<n>", summary: "" },
  { name: "rate", type: "number", placeholder: "<r>", summary: "" },
  { name: "once", type: "boolean", summary: "" },
];

test("parses --name value, --name=value and switches", () => {
  const flags = parseFlags(["--cluster", "devnet", "--api=https://example.test", "--json", "1.5"], SPECS);
  assert.equal(getString(flags, "cluster"), "devnet");
  assert.equal(getString(flags, "api"), "https://example.test");
  assert.equal(getBoolean(flags, "json"), true);
  assert.deepEqual(flags.positionals, ["1.5"]);
});

test("consumes a negative number as a flag value", () => {
  const flags = parseFlags(["--rate", "-0.15"], SPECS);
  assert.equal(getNumber(flags, "rate"), -0.15);
});

test("rejects an unknown flag with a usage error", () => {
  assert.throws(
    () => parseFlags(["--max-deviation-bp", "100"], SPECS),
    (error) => error.exitCode === EXIT_USAGE && /unknown flag/.test(error.message),
  );
});

test("rejects a non-numeric value for a number flag", () => {
  assert.throws(
    () => parseFlags(["--max-deviation-bps", "wide"], SPECS),
    (error) => error.exitCode === EXIT_USAGE,
  );
});

test("rejects a missing value at the end of the line", () => {
  assert.throws(() => parseFlags(["--cluster"], SPECS), (error) => error.exitCode === EXIT_USAGE);
});

test("treats everything after -- as positional", () => {
  const flags = parseFlags(["--json", "--", "--not-a-flag"], SPECS);
  assert.deepEqual(flags.positionals, ["--not-a-flag"]);
});

test("flag beats environment variable, environment beats default", () => {
  const withFlag = resolveGlobals(parseFlags(["--cluster", "devnet"], SPECS), { POYZ_CLUSTER: "localnet" }, false);
  assert.equal(withFlag.cluster, "devnet");

  const withEnv = resolveGlobals(parseFlags([], SPECS), { POYZ_CLUSTER: "localnet" }, false);
  assert.equal(withEnv.cluster, "localnet");

  const bare = resolveGlobals(parseFlags([], SPECS), {}, false);
  assert.equal(bare.cluster, "mainnet-beta");
});

test("every documented environment fallback is wired", () => {
  const globals = resolveGlobals(
    parseFlags([], SPECS),
    {
      POYZ_KEYPAIR: "/keys/poyz.json",
      POYZ_API: "https://api.test",
      POYZ_RPC: "https://rpc.test",
      POYZ_PROGRAM_ID: "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS",
      POYZ_COLLATERAL_MINT: "So11111111111111111111111111111111111111112",
    },
    false,
  );
  assert.equal(globals.keypairPath, "/keys/poyz.json");
  assert.equal(globals.apiBaseUrl, "https://api.test");
  assert.equal(globals.rpcUrl, "https://rpc.test");
  assert.equal(globals.programId, "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
  assert.equal(globals.collateralMint, "So11111111111111111111111111111111111111112");
});

test("an unknown cluster is a usage error, from a flag or the environment", () => {
  assert.throws(
    () => resolveGlobals(parseFlags(["--cluster", "sandbox"], SPECS), {}, false),
    (error) => error.exitCode === EXIT_USAGE && /unknown|must be one of/.test(error.message),
  );
  assert.throws(
    () => resolveGlobals(parseFlags([], SPECS), { POYZ_CLUSTER: "sandbox" }, false),
    (error) => error.exitCode === EXIT_USAGE,
  );
});

test("an unknown --source value is a usage error", () => {
  assert.throws(
    () => resolveGlobals(parseFlags(["--source", "guess"], SPECS), {}, false),
    (error) => error.exitCode === EXIT_USAGE,
  );
});

test("--json forces colour off even on a terminal", () => {
  const globals = resolveGlobals(parseFlags(["--json"], SPECS), {}, true);
  assert.equal(globals.useColor, false);
  assert.equal(shouldUseColor({ json: true, noColorFlag: false, noColorEnv: undefined, isTty: true }), false);
});

test("colour is on for a terminal and off for everything that disables it", () => {
  assert.equal(shouldUseColor({ json: false, noColorFlag: false, noColorEnv: undefined, isTty: true }), true);
  assert.equal(shouldUseColor({ json: false, noColorFlag: true, noColorEnv: undefined, isTty: true }), false);
  assert.equal(shouldUseColor({ json: false, noColorFlag: false, noColorEnv: "1", isTty: true }), false);
  assert.equal(shouldUseColor({ json: false, noColorFlag: false, noColorEnv: "", isTty: true }), true);
  assert.equal(shouldUseColor({ json: false, noColorFlag: false, noColorEnv: undefined, isTty: false }), false);
});

test("NO_COLOR from the environment reaches the resolved configuration", () => {
  const globals = resolveGlobals(parseFlags([], SPECS), { NO_COLOR: "1" }, true);
  assert.equal(globals.useColor, false);
});

test("help and version never colour a non-terminal stream", async () => {
  const { ctx } = makeContext();
  const help = await runCli(["--help"], ctx);
  assert.equal(help.exitCode, 0);
  assert.equal(stripAnsi(help.stdout), help.stdout);

  const version = await runCli(["--version"], ctx);
  assert.match(version.stdout, /^poyz \d+\.\d+\.\d+ \(sdk \d+\.\d+\.\d+\)\n$/);
});

test("createContext exposes the same shape the tests stub", () => {
  const real = createContext({ isTty: false });
  for (const key of ["env", "isTty", "canPrompt", "emit", "emitErr", "confirm", "sleep", "now", "createClient", "loadSigner", "onInterrupt"]) {
    assert.ok(key in real, `context is missing ${key}`);
  }
});
