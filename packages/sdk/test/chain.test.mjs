/**
 * Chain read path, driven with encoded account bytes and a stubbed RPC.
 *
 * These build real `Config` and `RebalanceProof` account data with the same
 * writer the decoders read, hand them to a fake connection, and assert on what
 * comes out the other end. That covers the part of the SDK that no offline test
 * reaches: PDA derivation, ownership checks, decoding, and the judgements laid
 * on top of the decoded values.
 *
 * The band assertions are the reason this file exists. A committed proof is held
 * to the exit band, not the trigger band, and using the wrong one is invisible
 * in a type checker and almost invisible in a rendered table.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PublicKey } from "@solana/web3.js";

import {
  ACCOUNT_DISCRIMINATORS,
  BorshWriter,
  POYZ_PROGRAM_ID,
  PoyzChainClient,
  VAULT_FLAGS_ALL,
  deriveConfigAddress,
  deriveRebalanceProofAddress,
} from "../dist/esm/index.js";

const DELTA_BAND_BPS = 100; // trigger: a rebalance becomes necessary
const DELTA_EXIT_BPS = 25; // exit: where a rebalance has to land
const SYNTHETIC_DECIMALS = 6;

function encodeConfig({ rebalanceCount = 1 } = {}) {
  const writer = new BorshWriter().bytes(ACCOUNT_DISCRIMINATORS.Config);
  for (let i = 0; i < 8; i += 1) {
    writer.bytes(new Uint8Array(32).fill(i + 1)); // authority..token_program
  }
  writer.bytes(new Uint8Array(32).fill(0xab)); // feed_id
  writer.bytes(new Uint8Array(32).fill(0xcd)); // last_proof_hash
  writer.u64(0n).u64(0n); // acc_funding_per_share (u128)
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
    .u64(BigInt(rebalanceCount)) // rebalance_count
    .u64(987_654n) // last_proof_slot
    .i64(0n) // negative_funding_since
    .i64(1_765_000_000n) // last_settle_at
    .i64(1_765_000_200n) // venue_state_at
    .u64(5_000_000_000_000n) // venue_capacity_notional
    .u64(9_000_000_000_000n); // max_reportable_capacity_notional
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
    .u16(DELTA_BAND_BPS) // delta_band_bps -- the trigger
    .u16(DELTA_EXIT_BPS) // delta_exit_bps -- where a proof must land
    .u16(300) // delta_hard_bps
    .u16(30) // max_hedge_slippage_bps
    .u16(2_000) // buffer_share_bps
    .u16(500) // buffer_max_draw_bps
    .u16(5_000); // max_supply_vs_capacity_bps
  writer
    .u8(9) // collateral_decimals
    .u8(SYNTHETIC_DECIMALS) // synthetic_decimals
    .u8(6) // bond_decimals
    .bool(false) // mint_paused
    .bool(false) // redeem_paused
    .u8(255) // bump
    .u8(VAULT_FLAGS_ALL)
    .u8(0b0000_0010) // venue_flags: velocity only
    .u8(1) // last_venue_id
    .bytes(new Uint8Array(25));
  return writer.toUint8Array();
}

function encodeProof({ sequence = 0, deltaBpsAfter = 12 } = {}) {
  const writer = new BorshWriter().bytes(ACCOUNT_DISCRIMINATORS.RebalanceProof);
  writer
    .bytes(new Uint8Array(32).fill(1)) // keeper
    .bytes(new Uint8Array(32).fill(0xab)) // venues_hash
    .bytes(new Uint8Array(32).fill(0x11)) // prev_hash
    .bytes(new Uint8Array(32).fill(0x22)); // this_hash
  writer
    .u64(BigInt(sequence))
    .u64(399_000_000_000n) // hedged_notional
    .u64(400_000_000_000n) // collateral_notional
    .i64(1_765_000_100n) // oracle_publish_time
    .u64(300_100n) // oracle_posted_slot
    .u64(300_200n) // slot
    .i64(1_765_000_123n) // timestamp
    .i64(20_000_000_000n) // oracle_price
    .u64(5_000_000n) // oracle_conf
    .i32(-137) // delta_bps_before
    .i32(deltaBpsAfter)
    .i32(-8) // oracle_expo
    .u8(1); // venue_id: velocity
  writer.u8(253).bytes(new Uint8Array(18));
  return writer.toUint8Array();
}

/** A Connection stand-in that serves exactly the accounts it is given. */
function stubConnection(accounts) {
  const owner = new PublicKey(POYZ_PROGRAM_ID);
  const get = (address) => {
    const data = accounts[address];
    return data === undefined ? null : { data: Buffer.from(data), owner };
  };
  return {
    getAccountInfo: async (key) => get(key.toBase58()),
    getMultipleAccountsInfo: async (keys) => keys.map((key) => get(key.toBase58())),
  };
}

function clientWith(accounts) {
  return new PoyzChainClient(
    { rpcUrl: "http://127.0.0.1:8899", programId: POYZ_PROGRAM_ID, commitment: "confirmed" },
    stubConnection(accounts),
  );
}

test("config decodes end to end through the chain client", async () => {
  const client = clientWith({ [deriveConfigAddress()]: encodeConfig() });
  const config = await client.getConfig();
  assert.equal(config.deltaBandBps, DELTA_BAND_BPS);
  assert.equal(config.deltaExitBps, DELTA_EXIT_BPS);
  assert.equal(config.maxReportableCapacityNotional, "9000000000000");
  assert.equal(config.venueFlags, 0b0000_0010);
  assert.equal(config.lastVenueId, 1);
  assert.equal(config.vaultsReady, true);
});

test("an attested delta is judged against the exit band, not the trigger", async () => {
  // 50 bps is inside the trigger band and outside the exit band. The program
  // would refuse to record this proof, so reporting it as "within threshold"
  // would claim a tolerance the chain never granted -- and would call a keeper
  // that stopped the moment a rebalance became necessary finished.
  const client = clientWith({
    [deriveConfigAddress()]: encodeConfig({ rebalanceCount: 1 }),
    [deriveRebalanceProofAddress(0n)]: encodeProof({ sequence: 0, deltaBpsAfter: 50 }),
  });

  const delta = await client.getDelta();
  assert.equal(delta.available, true);
  assert.equal(delta.data.deviationBps, 50);
  assert.equal(delta.data.thresholdBps, DELTA_EXIT_BPS, "the band a proof is held to is the exit band");
  assert.equal(delta.data.triggerBps, DELTA_BAND_BPS, "the trigger is reported separately");
  assert.equal(
    delta.data.withinThreshold,
    false,
    "50 bps is outside the 25 bps exit band; the 100 bps trigger would have hidden that",
  );
});

test("a delta inside the exit band reads as within threshold", async () => {
  const client = clientWith({
    [deriveConfigAddress()]: encodeConfig({ rebalanceCount: 1 }),
    [deriveRebalanceProofAddress(0n)]: encodeProof({ sequence: 0, deltaBpsAfter: 12 }),
  });
  const delta = await client.getDelta();
  assert.equal(delta.data.withinThreshold, true);
  assert.equal(delta.data.deviationRatio, 0.0012);
});

test("notionals convert to dollars using the synthetic decimals from the config", async () => {
  const client = clientWith({
    [deriveConfigAddress()]: encodeConfig({ rebalanceCount: 1 }),
    [deriveRebalanceProofAddress(0n)]: encodeProof({ sequence: 0 }),
  });
  const delta = await client.getDelta();
  assert.equal(delta.data.spotNotionalUsd, 400_000);
  assert.equal(delta.data.shortNotionalUsd, 399_000);
});

test("no proof yet is reported as no attested delta, not as zero", async () => {
  const client = clientWith({ [deriveConfigAddress()]: encodeConfig({ rebalanceCount: 0 }) });
  const delta = await client.getDelta();
  assert.equal(delta.available, false);
  assert.equal(delta.data, null);
  assert.match(delta.detail, /No rebalance proof has been committed yet/);
});

test("rebalance history comes back newest first with the venue named", async () => {
  const client = clientWith({
    [deriveConfigAddress()]: encodeConfig({ rebalanceCount: 3 }),
    [deriveRebalanceProofAddress(0n)]: encodeProof({ sequence: 0 }),
    [deriveRebalanceProofAddress(1n)]: encodeProof({ sequence: 1 }),
    [deriveRebalanceProofAddress(2n)]: encodeProof({ sequence: 2 }),
  });
  const { records } = await client.getRebalances(10);
  assert.deepEqual(
    records.map((record) => record.sequence),
    [2, 1, 0],
  );
  assert.equal(records[0].venue, "velocity");
  assert.equal(records[0].venueId, 1);
  assert.equal(records[0].collateralNotionalUsd, 400_000);
});

test("a gap in the proof chain is skipped, not filled in", async () => {
  const client = clientWith({
    [deriveConfigAddress()]: encodeConfig({ rebalanceCount: 3 }),
    [deriveRebalanceProofAddress(2n)]: encodeProof({ sequence: 2 }),
    // sequence 1 deliberately absent
    [deriveRebalanceProofAddress(0n)]: encodeProof({ sequence: 0 }),
  });
  const { records } = await client.getRebalances(10);
  assert.deepEqual(
    records.map((record) => record.sequence),
    [2, 0],
    "the missing proof is left out rather than invented",
  );
});

test("an account owned by another program is refused, not decoded", async () => {
  const client = new PoyzChainClient(
    { rpcUrl: "http://127.0.0.1:8899", programId: POYZ_PROGRAM_ID, commitment: "confirmed" },
    {
      getAccountInfo: async () => ({
        data: Buffer.from(encodeConfig()),
        owner: new PublicKey("11111111111111111111111111111111"),
      }),
      getMultipleAccountsInfo: async (keys) => keys.map(() => null),
    },
  );
  await assert.rejects(() => client.getConfig(), /not by the POYZ program/);
});

test("a missing config is an account-not-found, with the address named", async () => {
  const client = clientWith({});
  await assert.rejects(() => client.getConfig(), (error) => {
    assert.equal(error.address, deriveConfigAddress());
    assert.match(error.message, /does not exist on this cluster/);
    return true;
  });
});
