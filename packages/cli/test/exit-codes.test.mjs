/**
 * Exit codes are the contract a CI job depends on, so each one is pinned to the
 * situation it is supposed to mean.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_RUNTIME,
  EXIT_THRESHOLD,
  EXIT_UNAVAILABLE,
  EXIT_USAGE,
  runCli,
} from "../dist/poyz.mjs";
import {
  CONFIG_VIEW,
  DELTA_VIEW,
  DELTA_VIEW_SPARSE,
  PLAN,
  UNAVAILABLE,
  failedSimulation,
  fakeSigner,
  makeContext,
  okSimulation,
  sourced,
} from "./helpers.mjs";

function deltaContext(value, overrides = {}) {
  return makeContext({
    createClient: () => ({
      async getDelta() {
        return value;
      },
    }),
    ...overrides,
  });
}

function writeContext(simulation, sendResult, config = CONFIG_VIEW) {
  const sent = [];
  const built = [];
  const { ctx, ...rest } = makeContext({
    loadSigner: () => fakeSigner(),
    confirm: async () => true,
    createClient: () => ({
      async getConfig() {
        if (config === null) {
          throw new Error("Account 5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1 does not exist");
        }
        return config;
      },
      async buildMintRequest(params) {
        built.push(params);
        return PLAN;
      },
      async simulate() {
        return simulation;
      },
      async mintRequest() {
        sent.push("mintRequest");
        if (sendResult === undefined) {
          throw new Error("send was not expected in this test");
        }
        return sendResult;
      },
    }),
  });
  return { ctx, sent, built, ...rest };
}

const MINT_ARGS = ["mint", "1.5", "--keypair", "/keys/poyz.json"];

test("0 when the command completes", async () => {
  const { ctx } = deltaContext(sourced(DELTA_VIEW));
  const result = await runCli(["delta"], ctx);
  assert.equal(result.exitCode, EXIT_OK);
});

test("2 for an unknown command", async () => {
  const { ctx } = makeContext();
  const result = await runCli(["rebalance"], ctx);
  assert.equal(result.exitCode, EXIT_USAGE);
  assert.match(result.stderr, /unknown command "rebalance"/);
});

test("2 for an unknown flag on a known command", async () => {
  const { ctx } = deltaContext(sourced(DELTA_VIEW));
  const result = await runCli(["delta", "--max-deviation-bp", "100"], ctx);
  assert.equal(result.exitCode, EXIT_USAGE);
});

test("2 when a write is missing the keypair path", async () => {
  const { ctx } = writeContext(okSimulation());
  const result = await runCli(["mint", "1.5"], ctx);
  assert.equal(result.exitCode, EXIT_USAGE);
  assert.match(result.stderr, /keypair path is required/);
});

test("2 when the mint decimals cannot be read and were not given", async () => {
  const { ctx, sent } = writeContext(okSimulation(), undefined, null);
  const result = await runCli(MINT_ARGS, ctx);
  assert.equal(result.exitCode, EXIT_USAGE);
  assert.match(result.stderr, /cannot determine the collateral mint decimals/);
  assert.match(result.stderr, /--decimals/);
  assert.deepEqual(sent, []);
});

test("--decimals lets a request be built while the config is unreadable", async () => {
  const { ctx, built } = writeContext(okSimulation(), undefined, null);
  const result = await runCli([...MINT_ARGS, "--decimals", "9"], ctx);
  assert.equal(result.exitCode, EXIT_REFUSED);
  assert.equal(built[0].collateralAmount, 1500000000n);
});

test("mint converts with the decimals the protocol config reports", async () => {
  const { ctx, built } = writeContext(okSimulation());
  await runCli(MINT_ARGS, ctx);
  assert.equal(built[0].collateralAmount, 1500000000n, "1.5 at 9 collateral decimals");
});

test("mint says it submits a request and prints the nonce it generated", async () => {
  const { ctx, built } = writeContext(okSimulation());
  const result = await runCli(MINT_ARGS, ctx);
  assert.match(result.stdout, /request, not an issuance/);
  assert.match(result.stdout, /nonce/);
  assert.match(result.stdout, /generated/);
  assert.equal(built[0].nonce, 1770000000000n);
  assert.match(result.stdout, /1770000000000/);
});

test("an explicit nonce is passed through unchanged and not marked generated", async () => {
  const { ctx, built } = writeContext(okSimulation());
  const result = await runCli([...MINT_ARGS, "--nonce", "42"], ctx);
  assert.equal(built[0].nonce, 42n);
  assert.doesNotMatch(result.stdout, /\(generated\)/);
});

test("3 when upstream has not published the metric", async () => {
  const { ctx } = deltaContext(UNAVAILABLE);
  const result = await runCli(["delta"], ctx);
  assert.equal(result.exitCode, EXIT_UNAVAILABLE);
  assert.match(result.stdout, /not available/);
  assert.match(result.stdout, /the indexer has not published a delta yet/);
});

test("3 when the deviation itself is missing and a limit was given", async () => {
  const { ctx } = deltaContext(sourced(DELTA_VIEW_SPARSE));
  const result = await runCli(["delta", "--max-deviation-bps", "100"], ctx);
  assert.equal(result.exitCode, EXIT_UNAVAILABLE);
});

test("4 when the deviation is outside the given band", async () => {
  const { ctx } = deltaContext(sourced(DELTA_VIEW));
  const result = await runCli(["delta", "--max-deviation-bps", "10"], ctx);
  assert.equal(result.exitCode, EXIT_THRESHOLD);
  assert.match(result.stderr, /exceeds the 10 bps limit/);
});

test("0 when the deviation is inside the given band", async () => {
  const { ctx } = deltaContext(sourced(DELTA_VIEW));
  const result = await runCli(["delta", "--max-deviation-bps", "100"], ctx);
  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(result.stderr, "");
});

test("4 is reported in the JSON envelope with the data still attached", async () => {
  const { ctx } = deltaContext(sourced(DELTA_VIEW));
  const result = await runCli(["delta", "--max-deviation-bps", "10", "--json"], ctx);
  assert.equal(result.exitCode, EXIT_THRESHOLD);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.command, "delta");
  assert.equal(payload.available, true);
  assert.equal(payload.error.code, "CLI_THRESHOLD_EXCEEDED");
  assert.equal(payload.data.deviationBps, 42);
});

test("5 when a write runs without --execute, and nothing is sent", async () => {
  const { ctx, sent } = writeContext(okSimulation());
  const result = await runCli(MINT_ARGS, ctx);
  assert.equal(result.exitCode, EXIT_REFUSED);
  assert.deepEqual(sent, []);
  assert.match(result.stdout, /Dry run\. No transaction was sent\./);
});

test("5 when the confirmation prompt is declined", async () => {
  const { ctx, sent } = writeContext(okSimulation());
  ctx.confirm = async () => false;
  const result = await runCli([...MINT_ARGS, "--execute"], ctx);
  assert.equal(result.exitCode, EXIT_REFUSED);
  assert.deepEqual(sent, []);
});

test("1 when the simulation fails, with the program error reported unchanged", async () => {
  const { ctx, sent } = writeContext(failedSimulation());
  const result = await runCli([...MINT_ARGS, "--execute", "--yes"], ctx);
  assert.equal(result.exitCode, EXIT_RUNTIME);
  assert.deepEqual(sent, []);
  assert.match(result.stdout, /ProgramAccountNotFound/);
  assert.match(result.stdout, /program that does not exist/);
});

test("0 once a transaction is actually sent", async () => {
  const { ctx, sent } = writeContext(okSimulation(), {
    signature: "5s1Gn4tuR3",
    cluster: "devnet",
    explorerUrl: "https://explorer.solana.com/tx/5s1Gn4tuR3?cluster=devnet",
  });
  const result = await runCli([...MINT_ARGS, "--execute", "--yes", "--cluster", "devnet"], ctx);
  assert.equal(result.exitCode, EXIT_OK);
  assert.deepEqual(sent, ["mintRequest"]);
  assert.match(result.stdout, /5s1Gn4tuR3/);
});

test("keeper run refuses to start without a confirmation and sends nothing", async () => {
  const { ctx } = makeContext({
    createClient: () => ({
      async getDelta() {
        return sourced(DELTA_VIEW);
      },
      async getConfig() {
        return CONFIG_VIEW;
      },
    }),
  });
  const result = await runCli(["keeper", "run", "--once"], ctx);
  assert.equal(result.exitCode, EXIT_REFUSED);
});

test("keeper run --once exits 4 when the observation is outside the band", async () => {
  const { ctx, out } = makeContext({
    createClient: () => ({
      async getDelta() {
        return sourced(DELTA_VIEW);
      },
      async getConfig() {
        return CONFIG_VIEW;
      },
    }),
  });
  const result = await runCli(["keeper", "run", "--once", "--yes", "--max-deviation-bps", "10"], ctx);
  assert.equal(result.exitCode, EXIT_THRESHOLD);
  const printed = out.join("");
  assert.match(printed, /REBALANCE/);
  assert.match(printed, /commits no execution proof/);
});

test("simulate needs no network and exits 0", async () => {
  const { ctx } = makeContext();
  const result = await runCli(["simulate", "--amount", "100000", "--days", "90", "--rate", "-0.15"], ctx);
  assert.equal(result.exitCode, EXIT_OK);
  assert.match(result.stdout, /negative funding/);
});

test("simulate without its required flags is a usage error", async () => {
  const { ctx } = makeContext();
  const result = await runCli(["simulate", "--amount", "100000"], ctx);
  assert.equal(result.exitCode, EXIT_USAGE);
});
