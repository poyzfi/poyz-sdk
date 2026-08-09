/**
 * Golden bytes for the execution payload.
 *
 * `packages/delta-keeper/src/payload.ts` is the canonical encoder and this SDK
 * ships the verifier, which only works if the two agree byte for byte. The
 * vectors below were produced by running that canonical encoder and pasting its
 * output; they are not this package's own output rehearsed back at itself.
 *
 * Why constants rather than only a live cross-check: a live comparison passes
 * whenever both sides change together, which is exactly the case where a silent
 * layout change slips through. A frozen vector breaks the moment either side
 * moves, and the break names the byte.
 *
 * If one of these fails, do not update the constant to make it pass. Find out
 * which side changed and why. A digest that changed is a proof chain that no
 * longer verifies, and every already-committed proof becomes unverifiable.
 *
 * Cross-check: when the canonical encoder can be resolved, its output is
 * compared directly as well. It is not yet exported from `@poyz/delta-keeper`'s
 * entry point, so that assertion is opportunistic today and the constants carry
 * the guarantee.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeProofHash,
  computeVenuesHash,
  encodeExecutionPayload,
  toHex,
} from "../dist/esm/index.js";

const CONFIG = "9SgzpR2hgRXByQsYQjsZ6258t3jxVGchtPCMg6Y1GkF4";
const KEEPER = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";
const SUBACCOUNT = "So11111111111111111111111111111111111111112";

/**
 * The vector.
 *
 * Every field is a distinct value, and the two deltas and one fill amount are
 * negative, so a signed field read as unsigned changes the bytes rather than
 * happening to agree. `delta_bps_before`, `delta_bps_after`, `oracle_expo`,
 * `oracle_price`, `price`, `base_amount` and `ts` are all signed on the wire.
 */
const PAYLOAD = {
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
  fills: [
    { orderId: 7n, price: 20_000_000_000n, baseAmount: -5_000_000_000n, ts: 1_765_000_090n },
    { orderId: 8n, price: 20_010_000_000n, baseAmount: 1_250_000_000n, ts: 1_765_000_095n },
  ],
};

/** Produced by packages/delta-keeper/src/payload.ts encodeExecutionPayload. */
const GOLDEN_PAYLOAD_HEX =
  "7d723d7f4f1cc0f393f719c06fc87e63cd1d738061cb369d0dd9ad8849cc19b3" + // config
  "0400000000000000" + // sequence
  "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c" + // keeper
  "01" + // venue_id
  "069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001" + // venue_subaccount
  "77ffffff" + // delta_bps_before
  "0c000000" + // delta_bps_after
  "00a0db215d000000" + // collateral_notional
  "00d640e65c000000" + // hedged_notional
  "00c817a804000000" + // oracle_price
  "404b4c0000000000" + // oracle_conf
  "f8ffffff" + // oracle_expo
  "a4c3336900000000" + // oracle_publish_time
  "02000000" + // fills.len
  "070000000000000000c817a804000000000efad5feffffff9ac3336900000000" + // fills[0]
  "0800000000000000805eb0a804000000807c814a000000009fc3336900000000"; // fills[1]

/** sha256 of the above, as the canonical encoder computes it. */
const GOLDEN_VENUES_HASH = "4d75f7bc26877108e6c54d10031e027160b59a0dc363fdafc8011d6d07814860";

/** The same payload with no fills. Pins the Vec prefix on its own. */
const GOLDEN_EMPTY_VENUES_HASH = "b8045c733b3aa3ecbbbde0985998a6df6c84aeb967157c4820f523f16e4a08ea";

const PROOF_LINK = {
  prevHash: new Uint8Array(32).fill(0x11),
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
  venuesHash: hexToBytes(GOLDEN_VENUES_HASH),
  keeper: KEEPER,
};

/** Produced by packages/delta-keeper/src/payload.ts computeProofChainHash. */
const GOLDEN_PROOF_HASH = "668c0902724470ea428e4cfe8d3b41cfc80a400cc8233dbe8c9f0ee3b62793c0";

function hexToBytes(hex) {
  return Uint8Array.from(hex.match(/../g).map((byte) => Number.parseInt(byte, 16)));
}

test("the execution payload encodes to the canonical bytes", () => {
  const encoded = toHex(encodeExecutionPayload(PAYLOAD));
  if (encoded !== GOLDEN_PAYLOAD_HEX) {
    // Name the byte rather than dumping two 450-character strings.
    const mine = encoded.match(/../g) ?? [];
    const golden = GOLDEN_PAYLOAD_HEX.match(/../g) ?? [];
    const at = mine.findIndex((byte, index) => byte !== golden[index]);
    assert.fail(
      `execution payload diverged from the canonical encoder at byte ${at}: ` +
        `sdk-ts wrote ${mine[at]}, delta-keeper writes ${golden[at]}. ` +
        "Do not update the constant. Find which encoder moved -- every committed proof " +
        "becomes unverifiable when these disagree.",
    );
  }
  assert.equal(encoded, GOLDEN_PAYLOAD_HEX);
});

test("the payload width is fixed at 157 + 4 + 32 per fill", () => {
  assert.equal(encodeExecutionPayload(PAYLOAD).byteLength, 157 + 4 + 32 * 2);
  assert.equal(encodeExecutionPayload({ ...PAYLOAD, fills: [] }).byteLength, 157 + 4);
  assert.equal(GOLDEN_PAYLOAD_HEX.length / 2, 225);
});

test("signed fields are written signed, which the golden bytes pin", () => {
  const bytes = encodeExecutionPayload(PAYLOAD);
  // delta_bps_before = -137 at offset 105, i32 little-endian: 77 ff ff ff.
  assert.equal(toHex(bytes.slice(105, 109)), "77ffffff");
  // delta_bps_after = 12 at 109.
  assert.equal(toHex(bytes.slice(109, 113)), "0c000000");
  // oracle_expo = -8 at 145.
  assert.equal(toHex(bytes.slice(145, 149)), "f8ffffff");
  // fills[0].base_amount = -5_000_000_000 at 161 + 16, i64 little-endian.
  assert.equal(toHex(bytes.slice(177, 185)), "000efad5feffffff");
});

test("the fills vector prefix is a u32 at offset 157", () => {
  assert.equal(toHex(encodeExecutionPayload(PAYLOAD).slice(157, 161)), "02000000");
  assert.equal(toHex(encodeExecutionPayload({ ...PAYLOAD, fills: [] }).slice(157, 161)), "00000000");
});

test("venues_hash matches the canonical digest", async () => {
  assert.equal(toHex(await computeVenuesHash(PAYLOAD)), GOLDEN_VENUES_HASH);
  assert.equal(
    toHex(await computeVenuesHash({ ...PAYLOAD, fills: [] })),
    GOLDEN_EMPTY_VENUES_HASH,
  );
});

test("this_hash matches the canonical chain digest", async () => {
  assert.equal(toHex(await computeProofHash(PROOF_LINK)), GOLDEN_PROOF_HASH);
});

test("the golden vector would catch a sign error", async () => {
  // If deltaBpsBefore were written unsigned, or the two deltas were swapped, the
  // digest changes. Proving that here means the vector is load-bearing rather
  // than merely present.
  const swapped = { ...PAYLOAD, deltaBpsBefore: PAYLOAD.deltaBpsAfter, deltaBpsAfter: PAYLOAD.deltaBpsBefore };
  assert.notEqual(toHex(await computeVenuesHash(swapped)), GOLDEN_VENUES_HASH);

  const positive = { ...PAYLOAD, deltaBpsBefore: 137 };
  assert.notEqual(toHex(await computeVenuesHash(positive)), GOLDEN_VENUES_HASH);

  const reordered = {
    ...PAYLOAD,
    fills: [PAYLOAD.fills[1], PAYLOAD.fills[0]],
  };
  assert.notEqual(toHex(await computeVenuesHash(reordered)), GOLDEN_VENUES_HASH, "fill order is committed");
});

test("cross-check against the canonical encoder", async (t) => {
  // The canonical encoder lives in another package, whose dist is a build
  // artifact and may be absent in a fresh checkout. So this cannot be a hard
  // dependency of the SDK's own suite -- but it must not be a silent skip
  // either, which is the failure mode this whole file exists to prevent. The
  // mode is therefore reported through t.diagnostic(), which shows in the TAP
  // output, and POYZ_REQUIRE_CANONICAL=1 turns an unresolvable encoder into a
  // failure so CI can demand the live comparison.
  const specifiers = ["@poyz/delta-keeper", "../../delta-keeper/dist/payload.js"];
  const attempts = [];
  let canonical = null;
  let resolvedFrom = null;

  for (const specifier of specifiers) {
    try {
      const loaded = await import(specifier);
      if (typeof loaded.encodeExecutionPayload === "function") {
        canonical = loaded;
        resolvedFrom = specifier;
        break;
      }
      attempts.push(`${specifier}: resolved but exports no encodeExecutionPayload`);
    } catch (error) {
      attempts.push(`${specifier}: ${error.code ?? error.message}`);
    }
  }

  const required = process.env.POYZ_REQUIRE_CANONICAL === "1";

  if (canonical === null) {
    const detail = `canonical encoder not reachable (${attempts.join("; ")})`;
    if (required) {
      assert.fail(`${detail}. POYZ_REQUIRE_CANONICAL=1 demands the live comparison.`);
    }
    t.diagnostic(`SKIPPED live comparison: ${detail}. Golden constants were still enforced.`);
    return;
  }

  t.diagnostic(`live comparison ran against ${resolvedFrom}`);

  assert.equal(
    toHex(canonical.encodeExecutionPayload(PAYLOAD)),
    toHex(encodeExecutionPayload(PAYLOAD)),
    "the canonical encoder and this verifier disagree on the payload bytes",
  );
  assert.equal(
    toHex(canonical.hashExecutionPayload(PAYLOAD)),
    toHex(await computeVenuesHash(PAYLOAD)),
    "the canonical encoder and this verifier disagree on venues_hash",
  );
  assert.equal(
    toHex(canonical.computeProofChainHash(PROOF_LINK)),
    toHex(await computeProofHash(PROOF_LINK)),
    "the canonical encoder and this verifier disagree on this_hash",
  );
  assert.equal(
    toHex(canonical.encodeExecutionPayload(PAYLOAD)),
    GOLDEN_PAYLOAD_HEX,
    "the canonical encoder no longer produces the golden vector",
  );
});
