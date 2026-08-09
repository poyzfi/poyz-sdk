/**
 * Tests for the layers that talk to something: config validation, the status
 * API mapping, transaction building, and the refusal paths.
 *
 * The API client is driven with an injected `fetch` and the chain context is
 * supplied directly, so no network is touched. The "the protocol has no value
 * for this yet" branch is exercised explicitly, because that is the branch that
 * must never turn into a zero.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Keypair } from "@solana/web3.js";

import {
  DEFAULT_RPC_ENDPOINTS,
  POYZ_API_ROUTES,
  POYZ_IDL_ERRORS,
  POYZ_INSTRUCTION_SUPPORT,
  PoyzApiClient,
  PoyzClient,
  PoyzConfigError,
  PoyzUnavailableError,
  PoyzUnsupportedError,
  TOKEN_PROGRAM_ID,
  buildApiUrl,
  deriveAssociatedTokenAddress,
  describeProgramError,
  extractProgramErrorCode,
  keypairSigner,
  requireAvailable,
  resolveConfig,
  simulateFunding,
} from "../dist/esm/index.js";

const WSOL = "So11111111111111111111111111111111111111112";
const USER = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey.toBase58();
const KEEPER = Keypair.fromSeed(new Uint8Array(32).fill(11)).publicKey.toBase58();
const SYNTH = Keypair.fromSeed(new Uint8Array(32).fill(21)).publicKey.toBase58();
const ORACLE = Keypair.fromSeed(new Uint8Array(32).fill(31)).publicKey.toBase58();

/** A complete chain context, so plans build without an RPC round trip. */
const CONTEXT = {
  collateralMint: WSOL,
  syntheticMint: SYNTH,
  bondMint: WSOL,
  oracle: ORACLE,
  tokenProgram: TOKEN_PROGRAM_ID,
};

function offlineClient(extra = {}) {
  return PoyzClient.create({ context: CONTEXT, ...extra });
}

function stubFetch(routes) {
  return async (url) => {
    const match = Object.entries(routes).find(([route]) => url.endsWith(route));
    if (match === undefined) {
      return { ok: false, status: 404, text: async () => `no stub for ${url}` };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(match[1]) };
  };
}

function apiClient(routes) {
  return new PoyzApiClient({ apiBaseUrl: "https://api.test", requestTimeoutMs: 1000 }, stubFetch(routes));
}

test("resolveConfig fills defaults per cluster", () => {
  assert.equal(resolveConfig().rpcUrl, DEFAULT_RPC_ENDPOINTS["mainnet-beta"]);
  assert.equal(resolveConfig({ cluster: "devnet" }).rpcUrl, DEFAULT_RPC_ENDPOINTS.devnet);
  assert.equal(resolveConfig().commitment, "confirmed");
});

test("resolveConfig refuses a keyed RPC url", () => {
  const keyed = [
    "https://mainnet.helius-rpc.com/?api-key=abc",
    "https://solana-mainnet.g.alchemy.com/v2/abc",
    "https://example.quicknode.pro/abc/",
    "https://rpc.example.com/?access_token=abc",
  ];
  for (const rpcUrl of keyed) {
    assert.throws(() => resolveConfig({ rpcUrl }), PoyzConfigError, rpcUrl);
  }
  assert.doesNotThrow(() => resolveConfig({ rpcUrl: "https://api.mainnet-beta.solana.com" }));
});

test("resolveConfig rejects empty and nonsense fields", () => {
  assert.throws(() => resolveConfig({ cluster: "mainnet" }), PoyzConfigError);
  assert.throws(() => resolveConfig({ commitment: "eventual" }), PoyzConfigError);
  assert.throws(() => resolveConfig({ apiBaseUrl: "  " }), PoyzConfigError);
  assert.throws(() => resolveConfig({ requestTimeoutMs: 0 }), PoyzConfigError);
  assert.equal(resolveConfig({ apiBaseUrl: "https://a.test/" }).apiBaseUrl, "https://a.test");
});

test("buildApiUrl never produces a double slash", () => {
  assert.equal(buildApiUrl("https://a.test/", "/api/delta"), "https://a.test/api/delta");
  assert.equal(buildApiUrl("https://a.test", "api/delta"), "https://a.test/api/delta");
});

test("an unavailable metric stays unavailable and keeps its reason", async () => {
  const api = apiClient({
    [POYZ_API_ROUTES.delta]: {
      available: false,
      detail: "No upstream source has published this metric yet.",
    },
  });
  const delta = await api.getDelta();
  assert.equal(delta.available, false);
  assert.equal(delta.data, null);
  assert.equal(delta.detail, "No upstream source has published this metric yet.");
  assert.equal(delta.source, "api");
});

test("delta percentages are converted to decimals and basis points", async () => {
  const api = apiClient({
    [POYZ_API_ROUTES.delta]: {
      available: true,
      observed_at: "2026-08-09T12:00:00Z",
      data: {
        deviation_pct: -0.42,
        threshold_pct: 1,
        collateral_notional_usd: 1_000_000,
        hedge_notional_usd: 1_004_200,
        rebalances_24h: 6,
        venues: [{ venue: "drift", notional_usd: 900_000, share_pct: 90 }],
      },
    },
  });
  const delta = await api.getDelta();
  assert.equal(delta.available, true);
  assert.equal(delta.data.deviationRatio, -0.0042);
  assert.equal(delta.data.deviationBps, -42);
  assert.equal(delta.data.thresholdBps, 100);
  assert.equal(delta.data.withinThreshold, true);
  assert.equal(delta.data.rebalanceCount, 6);
  assert.equal(delta.data.venues[0].weight, 0.9);
  assert.equal(delta.data.venues[0].shortNotionalUsd, 900_000);
  assert.equal(delta.data.venues[0].venueId, 1, "the drift alias resolves to velocity's slot");
  assert.equal(delta.observedAtMs, Date.parse("2026-08-09T12:00:00Z"));
});

test("a negative carry is carried through as negative", async () => {
  const api = apiClient({
    [POYZ_API_ROUTES.funding]: {
      available: true,
      data: {
        apy_pct: -8.5,
        is_estimate: true,
        negative: true,
        venues: [{ venue: "drift", annualized_pct: -8.5 }],
      },
    },
  });
  const funding = await api.getFunding();
  assert.equal(funding.data.netCarryRate, -0.085);
  assert.equal(funding.data.annualizedRate, -0.085, "the alias is the net, never a gross");
  assert.equal(funding.data.negativeCarry, true);
  assert.equal(funding.data.isEstimate, true);
  assert.equal(funding.data.venues[0].annualizedRate, -0.085);
});

test("the split carry legs are kept apart, and net is the representative figure", async () => {
  const api = apiClient({
    [POYZ_API_ROUTES.funding]: {
      available: true,
      data: {
        gross_funding_apy_pct: 12.0,
        hedge_cost_apy_pct: 6.14,
        net_apy_pct: 5.86,
        apy_pct: 12.0,
        carry_model: "notional-weighted",
        is_estimate: true,
        negative: false,
        venues: [
          { venue: "velocity", carry: { kind: "funding-receiving", annualized_pct: 12.0 } },
          { venue: "jupiter-perps", carry: { kind: "borrow-fee-paying", annualized_pct: -6.14 } },
        ],
      },
    },
  });
  const funding = await api.getFunding();
  assert.equal(funding.data.grossFundingRate, 0.12);
  assert.ok(Math.abs(funding.data.hedgeCostRate - 0.0614) < 1e-12);
  assert.ok(Math.abs(funding.data.netCarryRate - 0.0586) < 1e-12, "net, not the gross apy_pct");
  assert.ok(Math.abs(funding.data.annualizedRate - 0.0586) < 1e-12);
  assert.equal(funding.data.carryModel, "notional-weighted");
  assert.equal(funding.data.venues[0].carryModel, "funding-receiving");
  assert.equal(funding.data.venues[1].carryModel, "borrow-fee-paying");
  assert.ok(Math.abs(funding.data.venues[1].annualizedRate + 0.0614) < 1e-12, "the cost leg keeps its sign");
});

test("a missing numeric field becomes null rather than zero", async () => {
  const api = apiClient({ [POYZ_API_ROUTES.collateral]: { available: true, data: { assets: [] } } });
  const collateral = await api.getCollateral();
  assert.equal(collateral.data.totalUsd, null);
  assert.equal(collateral.data.bufferUsd, null);
  assert.deepEqual(collateral.data.assets, []);
});

test("a non-2xx status is an error, not an empty reading", async () => {
  const api = new PoyzApiClient({ apiBaseUrl: "https://api.test", requestTimeoutMs: 1000 }, async () => ({
    ok: false,
    status: 502,
    text: async () => "bad gateway",
  }));
  await assert.rejects(() => api.getDelta(), /answered 502/);
});

test("a transport failure surfaces through the client as unavailable with the reason", async () => {
  const client = offlineClient({
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  const delta = await client.getDelta({ source: "api" });
  assert.equal(delta.available, false);
  assert.match(delta.detail, /could not be read from the status API/);
});

test("carry is not pretended to have an on-chain series", async () => {
  const funding = await offlineClient().getFunding({ source: "chain" });
  assert.equal(funding.available, false);
  assert.match(funding.detail, /no on-chain carry series/);
});

test("requireAvailable turns an unavailable reading into an error with the same reason", async () => {
  const api = apiClient({
    [POYZ_API_ROUTES.delta]: {
      available: false,
      detail: "No upstream source has published this metric yet.",
    },
  });
  const delta = await api.getDelta();
  assert.throws(() => requireAvailable(delta, "delta"), PoyzUnavailableError);
  try {
    requireAvailable(delta, "delta");
  } catch (error) {
    assert.equal(error.metric, "delta");
    assert.equal(error.detail, "No upstream source has published this metric yet.");
    assert.equal(error.code, "unavailable");
  }
});

test("requireAvailable passes an available reading straight through", async () => {
  const api = apiClient({
    [POYZ_API_ROUTES.funding]: { available: true, data: { apy_pct: 12, hourly_pct: 0.00137 } },
  });
  assert.equal(requireAvailable(await api.getFunding(), "funding").annualizedRate, 0.12);
});

test("mint_request encodes the IDL discriminator and all three arguments", async () => {
  const plan = await offlineClient().buildMintRequest({
    user: USER,
    nonce: 1n,
    collateralAmount: 2_500_000_000n,
    minSyntheticOut: 495_000_000n,
  });
  const [ix] = plan.instructions;
  assert.equal(ix.name, "mint_request");
  assert.deepEqual(
    ix.accounts.map((account) => account.name),
    [
      "user",
      "config",
      "request",
      "collateral_mint",
      "user_collateral",
      "collateral_vault",
      "oracle",
      "token_program",
      "system_program",
    ],
  );
  assert.equal(ix.accounts[0].isSigner, true);
  assert.equal(ix.accounts[1].isWritable, true);
  // discriminator (8) + nonce (8) + collateral_amount (8) + min_synthetic_out (8)
  assert.equal(ix.dataHex.length, 32 * 2);
  assert.ok(ix.dataHex.includes("00f9029500000000"), "2500000000 little-endian");
  assert.equal(plan.feePayer, USER);
});

test("a mint request is described as a request, never as a completed mint", async () => {
  const plan = await offlineClient().buildMintRequest({
    user: USER,
    nonce: 1n,
    collateralAmount: 1n,
    minSyntheticOut: 0n,
  });
  assert.match(plan.description, /request/i);
  assert.ok(plan.warnings.some((warning) => warning.includes("request leg only")));
});

test("token accounts default to the associated token account for the owner", async () => {
  const plan = await offlineClient().buildStake({ owner: USER, amount: 1_000n });
  const ownerSynthetic = plan.instructions[0].accounts.find((a) => a.name === "owner_synthetic");
  assert.equal(ownerSynthetic.pubkey, deriveAssociatedTokenAddress(USER, SYNTH, TOKEN_PROGRAM_ID));
});

test("an explicit token account overrides the derived one", async () => {
  const explicit = deriveAssociatedTokenAddress(KEEPER, SYNTH, TOKEN_PROGRAM_ID);
  const plan = await offlineClient().buildStake({
    owner: USER,
    amount: 1_000n,
    ownerSynthetic: explicit,
  });
  const account = plan.instructions[0].accounts.find((a) => a.name === "owner_synthetic");
  assert.equal(account.pubkey, explicit);
});

test("a plan serializes to its readable summary, not to web3.js internals", async () => {
  const plan = await offlineClient().buildKeeperRegister({
    keeper: KEEPER,
    bondAmount: 50_000_000_000n,
  });
  const json = JSON.parse(JSON.stringify(plan));
  assert.deepEqual(Object.keys(json).sort(), ["description", "feePayer", "instructions", "warnings"]);
  assert.equal(json.instructions[0].name, "keeper_register");
  assert.ok(plan.warnings.some((warning) => warning.includes("slash")));
  assert.ok(plan.warnings.some((warning) => warning.includes("cooldown")));
});

test("staking carries the negative funding warning", async () => {
  const plan = await offlineClient().buildStake({ owner: USER, amount: 1n });
  assert.ok(plan.warnings.some((warning) => warning.includes("negative regime")));
});

test("keeper attestations warn about slashing before they are signed", async () => {
  const client = offlineClient();
  const proof = await client.buildCommitRebalanceProof({
    keeper: KEEPER,
    sequence: 0n,
    venuesHash: new Uint8Array(32).fill(1),
    venueId: 1,
    deltaBpsBefore: -150,
    deltaBpsAfter: 10,
    hedgedNotional: 399_000_000_000n,
    collateralNotional: 400_000_000_000n,
  });
  assert.ok(proof.warnings.some((warning) => warning.includes("slashable fault")));
  assert.equal(proof.instructions[0].accounts.length, 6);

  const confirm = await client.buildMintConfirm({
    keeper: KEEPER,
    user: USER,
    nonce: 1n,
    hedgeProofHash: new Uint8Array(32).fill(2),
    venueId: 1,
    filledNotional: 500_000_000n,
  });
  assert.ok(confirm.warnings.some((warning) => warning.includes("slashable fault")));
  assert.equal(confirm.feePayer, KEEPER);
});

test("write builders reject amounts that would be a no-op or a mistake", async () => {
  const client = offlineClient();
  await assert.rejects(
    () => client.buildMintRequest({ user: USER, nonce: 0n, collateralAmount: 0n, minSyntheticOut: 0n }),
    /collateralAmount must be greater than zero/,
  );
  await assert.rejects(
    () => client.buildKeeperRegister({ keeper: KEEPER, bondAmount: -1n }),
    /bondAmount must be greater than zero/,
  );
  await assert.rejects(() => client.buildStake({ owner: USER, amount: 0n }), /amount must be greater/);
});

test("a proof cannot be built with an empty or short hash", async () => {
  const client = offlineClient();
  const base = {
    keeper: KEEPER,
    sequence: 0n,
    venueId: 1,
    deltaBpsBefore: -120,
    deltaBpsAfter: 5,
    hedgedNotional: 1n,
    collateralNotional: 1n,
  };
  await assert.rejects(
    () => client.buildCommitRebalanceProof({ ...base, venuesHash: new Uint8Array(31) }),
    /exactly 32 bytes/,
  );
  await assert.rejects(
    () => client.buildCommitRebalanceProof({ ...base, venuesHash: new Uint8Array(32) }),
    /must not be all zeroes/,
  );
});

test("administrative instructions are refused with a reason, not half-built", async () => {
  const client = offlineClient();
  for (const method of ["buildInitialize", "buildKeeperSlash", "buildSettleFunding"]) {
    await assert.rejects(() => client[method]({}), PoyzUnsupportedError);
  }
  assert.equal(POYZ_INSTRUCTION_SUPPORT.initialize.available, false);
  assert.equal(POYZ_INSTRUCTION_SUPPORT.keeperSlash.available, false);
});

test("the instruction support table matches what the client actually wraps", () => {
  for (const method of [
    "mintRequest",
    "mintConfirm",
    "mintCancel",
    "redeemRequest",
    "redeemConfirm",
    "redeemCancel",
    "stake",
    "requestUnstake",
    "unstake",
    "claimFunding",
    "keeperRegister",
    "keeperBond",
    "keeperUnbond",
    "commitRebalanceProof",
    "bufferDeposit",
  ]) {
    assert.equal(POYZ_INSTRUCTION_SUPPORT[method]?.available, true, `${method} should be available`);
    assert.equal(typeof PoyzClient.prototype[method], "function", `${method} should exist on the client`);
    const builder = `build${method[0].toUpperCase()}${method.slice(1)}`;
    assert.equal(typeof PoyzClient.prototype[builder], "function", `${builder} should exist`);
  }
});

test("program error codes are recognised in every shape the RPC returns them", () => {
  // Resolve by name, never by a hard-coded number: Anchor renumbers every code
  // after an inserted one, so a pinned 6028 silently becomes a different error.
  const codeOf = (name) => {
    const entry = POYZ_IDL_ERRORS.find((error) => error.name === name);
    assert.ok(entry !== undefined, `the program no longer defines ${name}`);
    return entry.code;
  };
  const bond = codeOf("InsufficientBond");

  assert.equal(extractProgramErrorCode({ InstructionError: [0, { Custom: bond }] }), bond);
  assert.equal(extractProgramErrorCode(`custom program error: 0x${bond.toString(16)}`), bond);
  assert.equal(extractProgramErrorCode(`Program log: AnchorError ... Error Number: ${bond}.`), bond);
  assert.equal(extractProgramErrorCode("nothing to see here"), null);

  assert.equal(describeProgramError(bond).name, "InsufficientBond");
  assert.equal(describeProgramError(codeOf("MintPaused")).name, "MintPaused");
  assert.equal(describeProgramError(9999), null);
});

test("a signer is refused when it does not match the fee payer", async () => {
  const client = offlineClient();
  const plan = await client.buildStake({ owner: USER, amount: 1n });
  const signer = keypairSigner(Keypair.fromSeed(new Uint8Array(32).fill(3)).secretKey);
  await assert.rejects(() => client.sendTransaction(plan, signer), /does not match the plan fee payer/);
});

test("keypairSigner exposes a public key and never the secret", () => {
  const keypair = Keypair.fromSeed(new Uint8Array(32).fill(7));
  const signer = keypairSigner(keypair.secretKey);
  assert.equal(signer.publicKey, keypair.publicKey.toBase58());
  assert.equal(JSON.stringify(signer).includes("secret"), false);
  assert.equal(Object.keys(signer).sort().join(","), "publicKey,signTransaction");
  assert.throws(() => keypairSigner(new Uint8Array(10)), /not a valid 64 byte/);
  try {
    keypairSigner(new Uint8Array(10).fill(0xaa));
  } catch (error) {
    assert.equal(/aa/.test(error.message), false, "the key must not appear in the error");
  }
});

test("a positive funding scenario earns and leaves the buffer alone", () => {
  const result = simulateFunding({
    amountUsd: 1_000_000,
    days: 30,
    fundingScenario: { annualizedRate: 0.12, bufferBalanceUsd: 50_000, coveredSupplyUsd: 1_000_000 },
    nowMs: 1_765_000_000_000,
  });
  assert.ok(result.grossFundingUsd > 0);
  assert.equal(result.isNegativeRegime, false);
  assert.equal(result.buffer.daysToDepletion, null);
  assert.equal(result.buffer.stage, "nominal");
  assert.equal(result.buffer.depletesWithinPeriod, false);
  assert.ok(result.disclaimer.includes("can stay negative"));
});

test("a negative funding scenario drains the buffer and escalates the playbook", () => {
  const result = simulateFunding({
    amountUsd: 1_000_000,
    days: 90,
    fundingScenario: {
      annualizedRate: -0.15,
      bufferBalanceUsd: 17_000,
      coveredSupplyUsd: 1_000_000,
      dailyOperatingCostUsd: 250,
    },
    nowMs: 1_765_000_000_000,
  });
  assert.ok(result.grossFundingUsd < 0);
  assert.equal(result.isNegativeRegime, true);
  assert.ok(result.buffer.dailyDrainUsd > 0);
  assert.ok(result.buffer.daysToDepletion < 90);
  assert.equal(result.buffer.depletesWithinPeriod, true);
  assert.notEqual(result.buffer.stage, "nominal");
  assert.ok(result.buffer.actions.length > 0);
});

test("simulateFunding without a buffer balance omits the projection instead of inventing one", () => {
  const result = simulateFunding({
    amountUsd: 500_000,
    days: 10,
    fundingScenario: { annualizedRate: 0.05 },
  });
  assert.equal(result.buffer, null);
  assert.ok(Math.abs(result.periodReturn - 0.05 * (10 / 365)) < 1e-12);
});

test("simulateFunding rejects malformed input", () => {
  assert.throws(
    () => simulateFunding({ amountUsd: 1, days: 0, fundingScenario: { annualizedRate: 0 } }),
    RangeError,
  );
  assert.throws(
    () => simulateFunding({ amountUsd: -1, days: 1, fundingScenario: { annualizedRate: 0 } }),
    RangeError,
  );
});

test("unstaking is two-legged, and the plans say which leg they are", async () => {
  const client = offlineClient();
  const request = await client.buildRequestUnstake({ owner: USER, amount: 1_000_000n });
  assert.equal(request.instructions[0].name, "request_unstake");
  assert.ok(request.warnings.some((warning) => warning.includes("Nothing is withdrawn here")));

  const withdraw = await client.buildUnstake({ owner: USER });
  assert.equal(withdraw.instructions[0].name, "unstake");
  // discriminator only: the program withdraws whatever is pending.
  assert.equal(withdraw.instructions[0].dataHex.length, 16);
  assert.ok(withdraw.warnings.some((warning) => warning.includes("cooldown")));
});

test("a venue with no position reports null exposure, never zero", async () => {
  const api = apiClient({
    [POYZ_API_ROUTES.venues]: {
      available: true,
      observed_at: "2026-08-09T13:33:31Z",
      detail: "Venue market data is live; position sizes are withheld rather than estimated.",
      data: {
        venues: [
          {
            venue: "drift",
            display_name: "Velocity (formerly Drift)",
            status: "live",
            market: { symbol: "SOL-PERP", mark_price_usd: 75.65 },
            funding: { hourly_pct: -0.02, annualized_pct: -175.0, estimate: true },
            carry: { kind: "funding-receiving", annualized_pct: -175.0, direction: "paid" },
            position: null,
          },
          {
            venue: "jupiter-perps",
            display_name: "Jupiter Perps",
            status: "live",
            market: { symbol: "SOL-PERP" },
            carry: { kind: "borrow-fee-paying", annualized_pct: -6.14, direction: "paid" },
            position: null,
          },
        ],
      },
    },
  });
  const venues = await api.getVenues();
  assert.equal(venues.available, true);
  const [velocity, jupiter] = venues.data;
  assert.equal(velocity.status, "live");
  assert.equal(velocity.market, "SOL-PERP");
  assert.equal(velocity.carryAnnualizedRate, -1.75);
  assert.equal(velocity.carryModel, "funding-receiving");
  assert.equal(velocity.venueId, 1);
  assert.equal(velocity.shortNotionalUsd, null, "no position is null, not 0");
  assert.equal(velocity.weight, null);
  assert.equal(jupiter.venueId, 2);
  assert.equal(jupiter.carryModel, "borrow-fee-paying");
  assert.equal(jupiter.carryDirection, "paid", "the LP-pool leg is a cost, not a yield");
  assert.ok(Math.abs(jupiter.carryAnnualizedRate + 0.0614) < 1e-12);
});

test("the stats route keeps each indicator's own availability", async () => {
  const api = apiClient({
    [POYZ_API_ROUTES.stats]: {
      delta: { available: false, value: null, detail: "The program is not deployed yet." },
      collateral_usd: { available: false, value: null, detail: "The program is not deployed yet." },
      funding_apy: { available: true, value: -175.0, unit: "pct", estimate: true, display: "-175.0% funding APY" },
      rebalance_count: { available: false, value: null, detail: "The program is not deployed yet." },
      cluster: "mainnet-beta",
      program_id: null,
      program_status: "not_deployed",
      anchor_version: null,
      delta_state: "unknown",
      generated_at: "2026-08-09T13:33:42Z",
    },
  });
  const stats = await api.getStats();
  assert.equal(stats.fundingApy.available, true);
  assert.equal(stats.fundingApy.value, -175.0);
  assert.equal(stats.fundingApy.estimate, true);
  assert.equal(stats.delta.available, false);
  assert.equal(stats.delta.value, null);
  assert.match(stats.delta.detail, /not deployed/);
  assert.equal(stats.chain.programStatus, "not_deployed");
  assert.equal(stats.generatedAtMs, Date.parse("2026-08-09T13:33:42Z"));
});

test("hedge venues are not pretended to exist on chain", async () => {
  const venues = await offlineClient().getHedgeVenues({ source: "chain" });
  assert.equal(venues.available, false);
  assert.match(venues.detail, /not stored on chain/);
});

test("venue slot 0 is refused before a proof is ever built", async () => {
  const client = offlineClient();
  await assert.rejects(
    () =>
      client.buildCommitRebalanceProof({
        keeper: KEEPER,
        sequence: 0n,
        venuesHash: new Uint8Array(32).fill(1),
        venueId: 0,
        deltaBpsBefore: -100,
        deltaBpsAfter: 5,
        hedgedNotional: 1n,
        collateralNotional: 1n,
      }),
    /venueId 0 is the unset value/,
  );
});

test("a borrow fee reported as a positive magnitude is signed as the cost it is", async () => {
  // This is the exact shape the live API publishes. A funding venue reports an
  // already-signed rate; a borrow-fee venue reports the fee as a positive
  // magnitude and states direction: "paid" beside it. Reading the second at face
  // value turns a 6.14% cost into 6.14% of income, and nothing downstream would
  // notice, because both are just numbers on the same axis.
  const api = apiClient({
    [POYZ_API_ROUTES.venues]: {
      available: true,
      data: {
        venues: [
          {
            venue: "velocity",
            status: "live",
            carry: { kind: "funding", annualized_pct: -175.0, direction: "paid" },
          },
          {
            venue: "jupiter-perps",
            status: "candidate",
            carry: { kind: "borrow_fee", annualized_pct: 6.1362, direction: "paid" },
          },
          {
            venue: "velocity",
            status: "live",
            carry: { kind: "funding", annualized_pct: 23.7, direction: "received" },
          },
        ],
      },
    },
  });
  const [velocityPaying, jupiter, velocityEarning] = (await api.getVenues()).data;

  assert.equal(velocityPaying.carryAnnualizedRate, -1.75, "an already-signed rate keeps its sign");
  assert.ok(jupiter.carryAnnualizedRate < 0, "a fee the protocol pays must be negative");
  assert.ok(Math.abs(jupiter.carryAnnualizedRate + 0.061362) < 1e-12);
  assert.equal(velocityEarning.carryAnnualizedRate, 0.237, "received carry is positive");

  assert.equal(velocityPaying.carryModel, "funding-receiving", "the API kind is normalised");
  assert.equal(jupiter.carryModel, "borrow-fee-paying");
});

test("a retired venue the API still lists gets no slot, so it cannot enter a proof", async () => {
  const api = apiClient({
    [POYZ_API_ROUTES.venues]: {
      available: true,
      data: {
        venues: [
          { venue: "velocity", status: "live", carry: { kind: "funding", annualized_pct: -1, direction: "paid" } },
          { venue: "mango", status: "discontinued" },
          { venue: "zeta", status: "discontinued" },
        ],
      },
    },
  });
  const [velocity, mango, zeta] = (await api.getVenues()).data;
  assert.equal(velocity.venueId, 1);
  // 0 is the unset slot, which the program rejects, so a retired venue the API
  // still lists cannot be committed against. It is reported, not hidden.
  assert.equal(mango.venueId, 0);
  assert.equal(zeta.venueId, 0);
  assert.equal(mango.status, "discontinued");
});

test("a venue id sent by the API is ignored; the slot comes from the program's contract", async () => {
  // The backend has shipped 0-base venue ids. If this SDK took a numeric id from
  // an API response, a 0 would be the unset sentinel on chain and a 1 would name
  // the wrong venue. It does not read one: the slot is resolved from the venue
  // NAME through the contract the program publishes, so a wrong number in the
  // payload cannot reach a proof.
  const api = apiClient({
    [POYZ_API_ROUTES.venues]: {
      available: true,
      data: {
        venues: [
          {
            venue: "velocity",
            // Deliberately wrong, in the 0-base scheme the backend still uses.
            venue_id: 0,
            id: 0,
            status: "live",
            carry: { kind: "funding", annualized_pct: -175.0, direction: "paid" },
          },
          {
            venue: "jupiter-perps",
            venue_id: 1,
            id: 1,
            status: "live",
            carry: { kind: "borrow_fee", annualized_pct: 6.14, direction: "paid" },
          },
        ],
      },
    },
  });

  const [velocity, jupiter] = (await api.getVenues()).data;
  assert.equal(velocity.venueId, 1, "velocity is slot 1 whatever the API said");
  assert.equal(jupiter.venueId, 2, "jupiter-perps is slot 2 whatever the API said");
  assert.notEqual(velocity.venueId, 0, "slot 0 is the unset sentinel and can never name a venue");
  assert.notEqual(jupiter.venueId, 1, "the API's 1 must not be taken as velocity's slot");
});
