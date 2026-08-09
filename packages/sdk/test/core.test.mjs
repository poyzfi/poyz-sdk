/**
 * Unit tests for the pure layers: encoding, addresses, account decoding, units
 * and quotes.
 *
 * These run against the built ESM bundle rather than the sources, so what is
 * tested is what a consumer installs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACCOUNT_DISCRIMINATORS,
  BorshReader,
  BorshWriter,
  INSTRUCTION_DISCRIMINATORS,
  POYZ_PROGRAM_ID,
  VAULT_FLAGS,
  VAULT_FLAGS_ALL,
  VENUE_ALIASES,
  VENUE_FLAGS_DEFAULT,
  VENUE_ID_UNSET,
  VENUE_NAMES,
  VENUE_RETIRED,
  VENUE_SLOTS,
  annualizeFundingRate,
  baseUnitsToDecimal,
  decimalToBaseUnits,
  decodeConfig,
  decodeKeeper,
  decodeMintRequest,
  decodeRebalanceProof,
  decodeStakePosition,
  deriveConfigAddress,
  deriveKeeperAddress,
  deriveMintRequestAddress,
  deriveRebalanceProofAddress,
  deriveRedeemRequestAddress,
  deriveStakePositionAddress,
  formatBaseUnits,
  fromHex,
  lamportsToSol,
  oracleToDecimal,
  parseDecimalToBaseUnits,
  quoteMint,
  quoteRedeem,
  solToLamports,
  enabledVenues,
  isVenueEnabled,
  toHex,
  u64Seed,
  venueIdFromName,
  venueName,
} from "../dist/esm/index.js";

const WSOL = "So11111111111111111111111111111111111111112";
const SYSTEM = "11111111111111111111111111111111";

test("borsh writes and reads every scalar this program uses", () => {
  const bytes = new BorshWriter()
    .u8(7)
    .bool(true)
    .u16(65_535)
    .u32(4_294_967_295)
    .i32(-123_456)
    .u64(18_446_744_073_709_551_615n)
    .i64(-9_007_199_254_740_993n)
    .toUint8Array();

  const reader = new BorshReader(bytes);
  assert.equal(reader.u8(), 7);
  assert.equal(reader.bool(), true);
  assert.equal(reader.u16(), 65_535);
  assert.equal(reader.u32(), 4_294_967_295);
  assert.equal(reader.i32(), -123_456);
  assert.equal(reader.u64(), 18_446_744_073_709_551_615n);
  assert.equal(reader.i64(), -9_007_199_254_740_993n);
  assert.equal(reader.remaining, 0);
});

test("borsh integers are little-endian, matching Rust to_le_bytes", () => {
  assert.equal(toHex(u64Seed(1n)), "0100000000000000");
  assert.equal(toHex(u64Seed(258n)), "0201000000000000");
});

test("borsh u128 reassembles both halves", () => {
  const writer = new BorshWriter().u64(0n).u64(1n);
  const reader = new BorshReader(writer.toUint8Array());
  assert.equal(reader.u128(), 1n << 64n);
});

test("borsh refuses values that do not fit", () => {
  assert.throws(() => new BorshWriter().u8(256), RangeError);
  assert.throws(() => new BorshWriter().u64(-1n), RangeError);
  assert.throws(() => new BorshWriter().i32(2_147_483_648), RangeError);
});

test("borsh reader refuses to read past the end of the buffer", () => {
  const reader = new BorshReader(new Uint8Array(4));
  assert.throws(() => reader.u64(), RangeError);
});

test("hex round-trips and rejects malformed input", () => {
  assert.equal(toHex(fromHex("0xdeadBEEF")), "deadbeef");
  assert.throws(() => fromHex("abc"), RangeError);
  assert.throws(() => fromHex("zz"), RangeError);
});

test("the config PDA is a singleton, not keyed by collateral", () => {
  const config = deriveConfigAddress();
  assert.equal(config, deriveConfigAddress(POYZ_PROGRAM_ID));
  assert.notEqual(config, deriveConfigAddress(SYSTEM), "a different program id derives elsewhere");
});

test("keyed PDAs are deterministic and seed-order sensitive", () => {
  assert.equal(deriveKeeperAddress(WSOL), deriveKeeperAddress(WSOL));
  assert.notEqual(deriveKeeperAddress(WSOL), deriveStakePositionAddress(WSOL));
  assert.notEqual(deriveMintRequestAddress(WSOL, 0n), deriveMintRequestAddress(WSOL, 1n));
  assert.notEqual(deriveStakePositionAddress(WSOL), deriveStakePositionAddress(SYSTEM));
  assert.notEqual(
    deriveMintRequestAddress(WSOL, 0n),
    deriveRedeemRequestAddress(WSOL, 0n),
    "mint and redeem requests must not collide at the same nonce",
  );
  assert.notEqual(deriveRebalanceProofAddress(0n), deriveRebalanceProofAddress(1n));
});

test("PDA derivation rejects a malformed address instead of throwing base58 noise", () => {
  assert.throws(() => deriveKeeperAddress("not-an-address"), /keeper is not a valid base58 address/);
  assert.throws(() => deriveMintRequestAddress(WSOL, -1n), /nonce must not be negative/);
});

/** Build a Config account body matching the IDL field order. */
function encodeConfig({
  vaultFlags = VAULT_FLAGS_ALL,
  mintPaused = false,
  redeemPaused = false,
  pendingAuthority = null,
  guardian = null,
} = {}) {
  const writer = new BorshWriter().bytes(ACCOUNT_DISCRIMINATORS.Config);
  writer.bytes(new Uint8Array(32).fill(1)); // authority
  writer.bytes(pendingAuthority ?? new Uint8Array(32)); // pending_authority, zeroed == none
  writer.bytes(guardian ?? new Uint8Array(32)); // guardian, zeroed == none
  writer.bytes(new Uint8Array(32).fill(3)); // collateral_mint
  writer.bytes(new Uint8Array(32).fill(4)); // synthetic_mint
  writer.bytes(new Uint8Array(32).fill(5)); // bond_mint
  writer.bytes(new Uint8Array(32).fill(6)); // oracle
  writer.bytes(new Uint8Array(32).fill(7)); // token_program
  writer.bytes(new Uint8Array(32).fill(0xab)); // feed_id
  writer.bytes(new Uint8Array(32).fill(0xcd)); // last_proof_hash
  writer.u64(0n).u64(0n); // acc_funding_per_share as u128, low then high
  writer
    .u64(2_500_000_000n) // total_collateral
    .u64(0n) // pending_collateral
    .u64(400_000_000_000n) // total_synthetic
    .u64(0n) // pending_redeem_synthetic
    .u64(399_000_000_000n) // hedged_notional
    .u64(120_000_000_000n) // total_staked
    .u64(1_500_000_000n) // staker_funding_balance
    .u64(7_000_000_000n) // buffer_balance
    .u64(50_000_000_000n) // bonded_total
    .u64(0n) // slashed_total
    .u64(10_000_000_000n) // min_keeper_bond
    .u64(1_000_000_000_000n) // max_synthetic_supply
    .u64(42n) // rebalance_count
    .u64(987_654n) // last_proof_slot
    .i64(0n) // negative_funding_since
    .i64(1_765_000_000n) // last_settle_at
    .i64(1_765_000_200n) // venue_state_at
    .u64(5_000_000_000_000n); // venue_capacity_notional
  writer
    .u32(60) // max_price_age_sec
    .u32(300) // request_ttl_sec
    .u32(15) // min_settlement_delay_sec
    .u32(86_400) // unbond_cooldown_sec
    .u32(604_800) // buffer_unlock_delay_sec
    .u32(259_200) // unstake_cooldown_sec
    .u32(3_600) // max_venue_state_age_sec
    .u32(3) // keeper_count
    .i32(-125) // last_net_carry_bps
    .i32(-500); // min_net_carry_bps
  writer
    .u16(50) // max_conf_bps
    .u16(10_000) // collateral_ratio_bps
    .u16(10) // mint_fee_bps
    .u16(25) // redeem_fee_bps
    .u16(100) // delta_band_bps
    .u16(25) // delta_exit_bps
    .u16(300) // delta_hard_bps
    .u16(30) // max_hedge_slippage_bps
    .u16(2_000) // buffer_share_bps
    .u16(500) // buffer_max_draw_bps
    .u16(5_000); // max_supply_vs_capacity_bps
  writer
    .u8(9) // collateral_decimals
    .u8(6) // synthetic_decimals
    .u8(6) // bond_decimals
    .bool(mintPaused)
    .bool(redeemPaused)
    .u8(255) // bump
    .u8(vaultFlags)
    .u8(1) // venue_flags
    .u8(0) // last_venue_id
    .bytes(new Uint8Array(33));
  return writer.toUint8Array();
}

test("decodeConfig reads the IDL field order", () => {
  const config = decodeConfig("ConfigAddress", encodeConfig());
  assert.equal(config.totalCollateral, "2500000000");
  assert.equal(config.totalSynthetic, "400000000000");
  assert.equal(config.hedgedNotional, "399000000000");
  assert.equal(config.totalStaked, "120000000000");
  assert.equal(config.bufferBalance, "7000000000");
  assert.equal(config.minKeeperBond, "10000000000");
  assert.equal(config.rebalanceCount, 42);
  assert.equal(config.lastProofSlot, 987_654);
  assert.equal(config.keeperCount, 3);
  assert.equal(config.deltaBandBps, 100);
  assert.equal(config.deltaExitBps, 25);
  assert.equal(config.unstakeCooldownSec, 259_200);
  assert.equal(config.lastProofHashHex, "cd".repeat(32));
  assert.equal(config.deltaHardBps, 300);
  assert.equal(config.lastNetCarryBps, -125);
  assert.equal(config.minNetCarryBps, -500);
  assert.equal(config.venueCapacityNotional, "5000000000000");
  assert.equal(config.venueStateAtMs, 1_765_000_200_000);
  assert.equal(config.maxVenueStateAgeSec, 3_600);
  assert.equal(config.maxSupplyVsCapacityBps, 5_000);
  assert.equal(config.venueFlags, 1);
  assert.equal(config.lastVenueId, 0);
  assert.equal(config.mintFeeBps, 10);
  assert.equal(config.redeemFeeBps, 25);
  assert.equal(config.maxPriceAgeSec, 60);
  assert.equal(config.unbondCooldownSec, 86_400);
  assert.equal(config.collateralDecimals, 9);
  assert.equal(config.syntheticDecimals, 6);
  assert.equal(config.mintPaused, false);
  assert.equal(config.redeemPaused, false);
  assert.equal(config.guardian, null);
  assert.equal(config.feedIdHex, "ab".repeat(32));
});

test("a zeroed pending authority or guardian is null, not the system program", () => {
  const empty = decodeConfig("a", encodeConfig());
  assert.equal(empty.pendingAuthority, null);
  assert.equal(empty.guardian, null);
  const set = decodeConfig(
    "a",
    encodeConfig({ pendingAuthority: new Uint8Array(32).fill(9), guardian: new Uint8Array(32).fill(8) }),
  );
  assert.notEqual(set.pendingAuthority, null);
  assert.notEqual(set.guardian, null);
});

test("vaultsReady is only true once every vault group exists", () => {
  assert.equal(decodeConfig("a", encodeConfig({ vaultFlags: VAULT_FLAGS_ALL })).vaultsReady, true);
  const partial = VAULT_FLAGS.collateral | VAULT_FLAGS.bond;
  const config = decodeConfig("a", encodeConfig({ vaultFlags: partial }));
  assert.equal(config.vaultsReady, false);
  assert.equal(config.vaultFlags, partial);
});

test("the two pause flags are independent", () => {
  const halfPaused = decodeConfig("a", encodeConfig({ mintPaused: true, redeemPaused: false }));
  assert.equal(halfPaused.mintPaused, true);
  assert.equal(halfPaused.redeemPaused, false, "redemption stays open when only issuance is paused");
  const fullyPaused = decodeConfig("a", encodeConfig({ mintPaused: true, redeemPaused: true }));
  assert.equal(fullyPaused.redeemPaused, true);
});

test("decode refuses account data with the wrong discriminator", () => {
  const wrong = new BorshWriter().bytes(ACCOUNT_DISCRIMINATORS.Keeper).bytes(new Uint8Array(400));
  assert.throws(() => decodeConfig("addr", wrong.toUint8Array()), /Config discriminator/);
});

test("decodeKeeper reports never-set timestamps as null rather than 1970", () => {
  const writer = new BorshWriter().bytes(ACCOUNT_DISCRIMINATORS.Keeper);
  writer.bytes(new Uint8Array(32).fill(9));
  writer
    .u64(50_000_000_000n) // bonded
    .u64(0n) // slashed
    .u64(0n) // proofs_committed
    .i64(1_765_000_000n) // registered_at
    .i64(0n) // last_proof_at -- never
    .u64(0n) // last_proof_slot
    .i64(1_765_000_000n) // last_bond_at
    .bool(true)
    .u8(255)
    .bytes(new Uint8Array(14));

  const keeper = decodeKeeper("KeeperAddress", writer.toUint8Array());
  assert.equal(keeper.bonded, "50000000000");
  assert.equal(keeper.proofsCommitted, 0);
  assert.equal(keeper.registeredAtMs, 1_765_000_000_000);
  assert.equal(keeper.lastProofAtMs, null);
  assert.equal(keeper.active, true);
});

test("decodeStakePosition keeps the u128 reward debt exact", () => {
  const writer = new BorshWriter().bytes(ACCOUNT_DISCRIMINATORS.StakePosition);
  writer.bytes(new Uint8Array(32).fill(2));
  writer.u64(0n).u64(1n); // reward_debt u128 == 2^64
  writer
    .u64(120_000_000_000n) // amount
    .u64(3_500_000n) // unclaimed
    .u64(9_000_000n) // claimed_total
    .i64(1_765_000_500n) // last_update
    .i64(0n) // cooldown_end -- none pending
    .u64(0n); // pending_unstake
  writer.u8(255).bytes(new Uint8Array(7));

  const position = decodeStakePosition("PositionAddress", writer.toUint8Array());
  assert.equal(position.amount, "120000000000");
  assert.equal(position.unclaimed, "3500000");
  assert.equal(position.claimedTotal, "9000000");
  assert.equal(position.rewardDebt, (1n << 64n).toString());
  assert.equal(position.lastUpdateMs, 1_765_000_500_000);
  assert.equal(position.pendingUnstake, "0");
  assert.equal(position.cooldownEndMs, null, "no cooldown is running");
});

test("decodeMintRequest marks an expired request against the clock it is given", () => {
  const writer = new BorshWriter().bytes(ACCOUNT_DISCRIMINATORS.MintRequest);
  writer.bytes(new Uint8Array(32).fill(4));
  writer
    .u64(7n) // nonce
    .u64(2_500_000_000n) // collateral_amount
    .u64(500_000_000n) // quoted_notional
    .u64(495_000_000n) // min_synthetic_out
    .i64(20_000_000_000n) // quoted_price
    .i64(1_765_000_000n) // created_at
    .i64(1_765_000_300n) // deadline
    .u64(300_000n) // quoted_slot
    .i32(-8); // quoted_expo
  writer.u8(255).bytes(new Uint8Array(11));
  const data = writer.toUint8Array();

  const live = decodeMintRequest("RequestAddress", data, 1_765_000_100_000);
  assert.equal(live.nonce, "7");
  assert.equal(live.expired, false);
  assert.equal(live.quotedPriceUsd, 200);
  assert.equal(live.deadlineMs, 1_765_000_300_000);

  const stale = decodeMintRequest("RequestAddress", data, 1_765_000_999_000);
  assert.equal(stale.expired, true);
});

test("decodeRebalanceProof converts notionals only when the decimals are known", () => {
  const writer = new BorshWriter().bytes(ACCOUNT_DISCRIMINATORS.RebalanceProof);
  writer
    .bytes(new Uint8Array(32).fill(1)) // keeper
    .bytes(new Uint8Array(32).fill(0xab)) // venues_hash
    .bytes(new Uint8Array(32).fill(0x11)) // prev_hash
    .bytes(new Uint8Array(32).fill(0x22)); // this_hash
  writer
    .u64(4n) // sequence
    .u64(399_000_000_000n) // hedged_notional
    .u64(400_000_000_000n) // collateral_notional
    .i64(1_765_000_100n) // oracle_publish_time
    .u64(300_100n) // oracle_posted_slot
    .u64(300_200n) // slot
    .i64(1_765_000_123n) // timestamp
    .i64(20_000_000_000n) // oracle_price
    .u64(5_000_000n) // oracle_conf
    .i32(-137) // delta_bps_before
    .i32(12) // delta_bps_after
    .i32(-8) // oracle_expo
    .u8(1); // venue_id -- slot 1 is velocity
  writer.u8(253).bytes(new Uint8Array(18));
  const data = writer.toUint8Array();

  const scaled = decodeRebalanceProof("ProofAddress", data, 6);
  assert.equal(scaled.sequence, 4);
  assert.equal(scaled.deltaBpsBefore, -137);
  assert.equal(scaled.deltaBpsAfter, 12);
  assert.equal(scaled.venue, "velocity");
  assert.equal(scaled.venueId, 1);
  assert.equal(scaled.collateralNotionalUsd, 400_000);
  assert.equal(scaled.hedgedNotionalUsd, 399_000);
  assert.equal(scaled.oraclePriceUsd, 200);
  assert.equal(scaled.timestampMs, 1_765_000_123_000);
  assert.equal(scaled.venuesHashHex, "ab".repeat(32));
  assert.equal(scaled.prevHashHex, "11".repeat(32), "the chain links to the previous proof");
  assert.equal(scaled.thisHashHex, "22".repeat(32));
  assert.equal(scaled.oracleConf, "5000000");

  const unscaled = decodeRebalanceProof("ProofAddress", data);
  assert.equal(unscaled.collateralNotionalUsd, null, "no decimals means no guessed dollar figure");
  assert.equal(unscaled.collateralNotional, "400000000000", "the exact base units survive");
});

test("venue slot 0 is never named after a real venue", () => {
  // 0 is the u8 zero value. Naming it after the primary venue is how a field
  // that was never set becomes a false attribution in a committed proof.
  assert.equal(VENUE_ID_UNSET, 0);
  assert.equal(venueName(0), "none");
  assert.equal(venueName(1), "velocity");
  assert.equal(venueName(2), "jupiter-perps");
  assert.equal(venueName(9), "venue-9");
});

test("the venue table comes from the program's contract, not a local copy", () => {
  // The expectations here are read from the generated contract rather than
  // written out again. A second hand-maintained table is exactly the failure
  // this is guarding against: two tables that each look right, differing on one
  // string, discovered only when every proof commit fails.
  for (const [name, slot] of Object.entries(VENUE_SLOTS)) {
    if (slot === VENUE_ID_UNSET) {
      continue;
    }
    assert.equal(venueIdFromName(name), slot, `${name} must resolve to its contract slot`);
    assert.equal(venueName(slot), name, `slot ${slot} must name back to ${name}`);
  }
});

test("every published alias resolves to the same slot as its canonical name", () => {
  // The primary venue is spelled two ways across this system after the rebrand.
  // A mismatch is a string, so the type checker cannot see it.
  assert.ok(Object.keys(VENUE_ALIASES).length > 0, "the contract publishes at least one alias");
  for (const [alias, canonical] of Object.entries(VENUE_ALIASES)) {
    assert.equal(
      venueIdFromName(alias),
      venueIdFromName(canonical),
      `${alias} and ${canonical} must be the same slot`,
    );
  }
  assert.equal(venueIdFromName("drift"), venueIdFromName("velocity"), "the rebrand alias holds");
  assert.equal(venueIdFromName("Drift"), venueIdFromName(" VELOCITY "), "matching is case and space insensitive");
});

test("a retired venue is refused with the contract's own reason", () => {
  assert.ok(Object.keys(VENUE_RETIRED).length > 0, "the contract lists retired venues");
  for (const [name, reason] of Object.entries(VENUE_RETIRED)) {
    assert.throws(
      () => venueIdFromName(name),
      (error) => error.message.includes(reason),
      `${name} must be refused with the published reason`,
    );
    assert.equal(Object.values(VENUE_NAMES).includes(name), false, `${name} must have no slot`);
  }
  assert.throws(() => venueIdFromName("nonesuch"), /unknown hedge venue/);
});

test("venue_flags bit index is the venue id, and bit 0 is never a venue", () => {
  const velocityOnly = VENUE_FLAGS_DEFAULT;
  assert.equal(velocityOnly, 0b0000_0010, "the contract's default enables velocity only");
  assert.equal(isVenueEnabled(velocityOnly, 1), true);
  assert.equal(isVenueEnabled(velocityOnly, 2), false);
  assert.equal(isVenueEnabled(velocityOnly, 0), false, "slot 0 can never be enabled");
  assert.deepEqual(enabledVenues(velocityOnly), [1]);
  assert.deepEqual(enabledVenues(0b0000_0110), [1, 2]);
  assert.deepEqual(enabledVenues(0b0000_0001), [], "bit 0 is not a venue");
});

test("oracle price scaling follows the feed exponent", () => {
  assert.equal(oracleToDecimal(20_000_000_000n, -8), 200);
  assert.equal(oracleToDecimal(1n, 0), 1);
});

test("decimal parsing is exact where floating point is not", () => {
  assert.equal(parseDecimalToBaseUnits("0.1", 9), 100_000_000n);
  assert.equal(parseDecimalToBaseUnits("1234567.123456789", 9), 1_234_567_123_456_789n);
  assert.equal(parseDecimalToBaseUnits("-2.5", 6), -2_500_000n);
  assert.equal(decimalToBaseUnits(0.1, 9), 100_000_000n);
});

test("decimal parsing refuses precision it cannot represent", () => {
  assert.throws(() => parseDecimalToBaseUnits("0.0000000001", 9), /fractional digits/);
  assert.equal(parseDecimalToBaseUnits("0.1000000000", 9), 100_000_000n, "trailing zeros are not a loss");
  assert.throws(() => parseDecimalToBaseUnits("abc", 9), /is not a decimal number/);
});

test("base unit formatting is exact for values a double cannot hold", () => {
  const big = 18_446_744_073_709_551_615n;
  assert.equal(formatBaseUnits(big, 9), "18446744073.709551615");
  assert.equal(formatBaseUnits(big, 9, 2), "18446744073.7");
  assert.equal(formatBaseUnits(1_000_000_000n, 9), "1");
  assert.equal(formatBaseUnits(-1_500_000_000n, 9), "-1.5");
});

test("sol and lamport helpers agree", () => {
  assert.equal(solToLamports("1.5"), 1_500_000_000n);
  assert.equal(lamportsToSol(1_500_000_000n), "1.5");
  assert.equal(baseUnitsToDecimal(1_500_000_000n, 9), 1.5);
});

test("quoteMint applies the haircut before the fee", () => {
  const asset = { symbol: "SOL", mint: WSOL, decimals: 9, haircutBps: 100 };
  const quote = quoteMint({ asset, collateralAmount: 10, collateralPriceUsd: 200, mintFeeBps: 50 });
  assert.equal(quote.collateralValueUsd, 2000);
  assert.equal(quote.haircutUsd, 20);
  assert.equal(quote.feeUsd, 9.9);
  assert.equal(quote.syntheticDollarsOut, 1970.1);
  assert.ok(Math.abs(quote.totalCostRatio - 0.01495) < 1e-12);
});

test("quoteRedeem does not charge the haircut twice", () => {
  const asset = { symbol: "SOL", mint: WSOL, decimals: 9, haircutBps: 100 };
  const quote = quoteRedeem({ asset, syntheticDollarsIn: 1000, collateralPriceUsd: 200, redeemFeeBps: 25 });
  assert.equal(quote.feeUsd, 2.5);
  assert.equal(quote.netValueUsd, 997.5);
  assert.equal(quote.collateralOut, 4.9875);
});

test("quotes reject malformed inputs rather than returning NaN", () => {
  const asset = { symbol: "SOL", mint: WSOL, decimals: 9, haircutBps: 100 };
  assert.throws(
    () => quoteMint({ asset, collateralAmount: -1, collateralPriceUsd: 200, mintFeeBps: 0 }),
    RangeError,
  );
  assert.throws(
    () => quoteMint({ asset, collateralAmount: 1, collateralPriceUsd: 0, mintFeeBps: 0 }),
    RangeError,
  );
});

test("funding annualization is simple, not compounded", () => {
  assert.ok(Math.abs(annualizeFundingRate(0.0001, 1) - 0.876) < 1e-12);
  assert.ok(Math.abs(annualizeFundingRate(-0.0001, 8) + 0.1095) < 1e-12);
});

test("every instruction the SDK builds has a discriminator from the IDL", () => {
  const wrapped = [
    "mint_request",
    "mint_confirm",
    "mint_cancel",
    "redeem_request",
    "redeem_confirm",
    "redeem_cancel",
    "stake",
    "request_unstake",
    "unstake",
    "claim_funding",
    "keeper_register",
    "keeper_bond",
    "keeper_unbond",
    "commit_rebalance_proof",
    "buffer_deposit",
  ];
  for (const name of wrapped) {
    assert.equal(INSTRUCTION_DISCRIMINATORS[name]?.length, 8, `${name} discriminator`);
  }
});
