/**
 * Tests for the execution proof encoder and the chain verifier.
 *
 * The digests here are only useful if every party computes them identically, so
 * these tests pin the two things that can silently diverge: the byte layout, and
 * the fact that changing any hashed field changes the digest. A vector produced
 * by the keeper's canonical encoder can be dropped straight into
 * `KNOWN_VECTOR` once one exists, and this file will hold the two encoders
 * together from then on.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeProofHash,
  computeVenuesHash,
  encodeExecutionPayload,
  toHex,
  verifyProof,
  verifyProofChain,
} from "../dist/esm/index.js";

const CONFIG = "9SgzpR2hgRXByQsYQjsZ6258t3jxVGchtPCMg6Y1GkF4";
const KEEPER = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";
const SUBACCOUNT = "So11111111111111111111111111111111111111112";

function payload(overrides = {}) {
  return {
    config: CONFIG,
    sequence: 4n,
    keeper: KEEPER,
    venueId: 1,
    venueSubaccount: SUBACCOUNT,
    deltaBpsBefore: -137,
    deltaBpsAfter: 12,
    collateralNotional: 400_000_000_000n,
    hedgedNotional: 399_000_000_000n,
    oraclePrice: 20_000_000_000n,
    oracleConf: 5_000_000n,
    oracleExpo: -8,
    oraclePublishTime: 1_765_000_100n,
    fills: [{ orderId: 7n, price: 20_000_000_000n, baseAmount: -5_000_000_000n, ts: 1_765_000_090n }],
    ...overrides,
  };
}

function link(overrides = {}) {
  return {
    prevHash: new Uint8Array(32),
    config: CONFIG,
    sequence: 4n,
    slot: 300_200n,
    oraclePrice: 20_000_000_000n,
    oracleConf: 5_000_000n,
    oracleExpo: -8,
    oraclePublishTime: 1_765_000_100n,
    collateralNotional: 400_000_000_000n,
    hedgedNotional: 399_000_000_000n,
    deltaBpsBefore: -137,
    deltaBpsAfter: 12,
    venueId: 1,
    venuesHash: new Uint8Array(32).fill(0xab),
    keeper: KEEPER,
    ...overrides,
  };
}

test("the execution payload encodes to the width the program declares", () => {
  // config 32 + sequence 8 + keeper 32 + venue_id 1 + subaccount 32 +
  // delta_before 4 + delta_after 4 + collateral 8 + hedged 8 + price 8 +
  // conf 8 + expo 4 + publish_time 8 + vec len 4 + one fill (8+8+8+8 = 32)
  assert.equal(encodeExecutionPayload(payload()).byteLength, 193);
  assert.equal(encodeExecutionPayload(payload({ fills: [] })).byteLength, 161);
  assert.equal(
    encodeExecutionPayload(payload({ fills: [payload().fills[0], payload().fills[0]] })).byteLength,
    225,
  );
});

test("integers are little-endian, matching Rust to_le_bytes", () => {
  const bytes = encodeExecutionPayload(payload({ sequence: 1n }));
  // The sequence sits immediately after the 32 byte config key.
  assert.equal(toHex(bytes.slice(32, 40)), "0100000000000000");
  // venue_id is one raw byte after the 32 byte keeper key.
  assert.equal(bytes[72], 1);
});

test("the fills vector carries a u32 length prefix", () => {
  const none = encodeExecutionPayload(payload({ fills: [] }));
  // The prefix is the last four bytes when there are no fills.
  assert.equal(toHex(none.slice(-4)), "00000000");
  const two = encodeExecutionPayload(payload({ fills: [payload().fills[0], payload().fills[0]] }));
  assert.equal(toHex(two.slice(157, 161)), "02000000");
});

test("every hashed field changes the venues hash", async () => {
  const base = toHex(await computeVenuesHash(payload()));
  const mutations = {
    config: KEEPER,
    sequence: 5n,
    keeper: SUBACCOUNT,
    venueId: 2,
    venueSubaccount: KEEPER,
    deltaBpsBefore: -138,
    deltaBpsAfter: 13,
    collateralNotional: 400_000_000_001n,
    hedgedNotional: 399_000_000_001n,
    oraclePrice: 20_000_000_001n,
    oracleConf: 5_000_001n,
    oracleExpo: -7,
    oraclePublishTime: 1_765_000_101n,
    fills: [],
  };
  for (const [field, value] of Object.entries(mutations)) {
    const mutated = toHex(await computeVenuesHash(payload({ [field]: value })));
    assert.notEqual(mutated, base, `changing ${field} must change the digest`);
  }
});

test("the config is hashed in, so a payload cannot be replayed across deployments", async () => {
  const here = toHex(await computeVenuesHash(payload()));
  const elsewhere = toHex(await computeVenuesHash(payload({ config: SUBACCOUNT })));
  assert.notEqual(here, elsewhere);
});

test("every hashed field changes the proof hash", async () => {
  const base = toHex(await computeProofHash(link()));
  const mutations = {
    prevHash: new Uint8Array(32).fill(1),
    config: KEEPER,
    sequence: 5n,
    slot: 300_201n,
    oraclePrice: 20_000_000_001n,
    oracleConf: 5_000_001n,
    oracleExpo: -7,
    oraclePublishTime: 1_765_000_101n,
    collateralNotional: 400_000_000_001n,
    hedgedNotional: 399_000_000_001n,
    deltaBpsBefore: -138,
    deltaBpsAfter: 13,
    venueId: 2,
    venuesHash: new Uint8Array(32).fill(0xac),
    keeper: SUBACCOUNT,
  };
  for (const [field, value] of Object.entries(mutations)) {
    const mutated = toHex(await computeProofHash(link({ [field]: value })));
    assert.notEqual(mutated, base, `changing ${field} must change the digest`);
  }
});

test("digests are stable across runs, so two parties agree", async () => {
  const a = toHex(await computeProofHash(link()));
  const b = toHex(await computeProofHash(link()));
  assert.equal(a, b);
  assert.equal(a.length, 64);
});

test("a malformed digest input is refused rather than padded", async () => {
  await assert.rejects(() => computeProofHash(link({ prevHash: new Uint8Array(31) })), /exactly 32 bytes/);
  await assert.rejects(() => computeProofHash(link({ venuesHash: new Uint8Array(0) })), /exactly 32 bytes/);
});

/** Build a stored record whose this_hash is genuinely the program's digest. */
async function record(sequence, prevHashHex, overrides = {}) {
  const venuesHash = new Uint8Array(32).fill(0xab);
  const prevHash = Uint8Array.from(
    prevHashHex.match(/../g).map((byte) => Number.parseInt(byte, 16)),
  );
  const thisHash = await computeProofHash(
    link({ sequence: BigInt(sequence), prevHash, venuesHash, slot: BigInt(300_000 + sequence) }),
  );
  return {
    sequence,
    address: `Proof${sequence}`,
    keeper: KEEPER,
    venueId: 1,
    venue: "velocity",
    deltaBpsBefore: -137,
    deltaBpsAfter: 12,
    hedgedNotional: "399000000000",
    collateralNotional: "400000000000",
    hedgedNotionalUsd: 399_000,
    collateralNotionalUsd: 400_000,
    slot: 300_000 + sequence,
    timestampMs: 1_765_000_123_000,
    venuesHashHex: toHex(venuesHash),
    prevHashHex,
    thisHashHex: toHex(thisHash),
    oraclePrice: "20000000000",
    oracleConf: "5000000",
    oracleExpo: -8,
    oraclePriceUsd: 200,
    oraclePublishTimeMs: 1_765_000_100_000,
    oraclePostedSlot: 300_100,
    ...overrides,
  };
}

test("a genuine proof verifies against its own stored digest", async () => {
  const zero = "00".repeat(32);
  const verification = await verifyProof(await record(4, zero), CONFIG);
  assert.equal(verification.hashMatches, true);
  assert.equal(verification.detail, null);
  assert.equal(verification.expectedHashHex, verification.actualHashHex);
});

test("a tampered field is caught, because the stored digest no longer matches", async () => {
  const zero = "00".repeat(32);
  // The kind of edit an indexer would not notice: the notional is raised, and
  // every other field, including the stored digest, is left as it was.
  const tampered = await record(4, zero, { hedgedNotional: "999000000000" });
  const verification = await verifyProof(tampered, CONFIG);
  assert.equal(verification.hashMatches, false);
  assert.match(verification.detail, /does not match the one stored on chain/);
});

test("a proof from another deployment does not verify here", async () => {
  const zero = "00".repeat(32);
  const verification = await verifyProof(await record(4, zero), SUBACCOUNT);
  assert.equal(verification.hashMatches, false, "the config is hashed in for exactly this reason");
});

test("the chain links each proof to the previous one", async () => {
  const zero = "00".repeat(32);
  const first = await record(1, zero);
  const second = await record(2, first.thisHashHex);
  const third = await record(3, second.thisHashHex);

  const results = await verifyProofChain([third, first, second], CONFIG);
  assert.deepEqual(
    results.map((r) => r.sequence),
    [1, 2, 3],
    "results come back oldest first regardless of input order",
  );
  assert.deepEqual(
    results.map((r) => r.hashMatches),
    [true, true, true],
  );
  assert.equal(results[0].linksToPrevious, null, "the oldest proof has no previous link in this run");
  assert.equal(results[1].linksToPrevious, true);
  assert.equal(results[2].linksToPrevious, true);
});

test("a break in the chain is reported, not smoothed over", async () => {
  const zero = "00".repeat(32);
  const first = await record(1, zero);
  const forged = await record(2, "11".repeat(32));

  const results = await verifyProofChain([first, forged], CONFIG);
  assert.equal(results[1].linksToPrevious, false);
  assert.match(results[1].detail, /not a contiguous chain/);
});
