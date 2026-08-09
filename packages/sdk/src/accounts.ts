/**
 * Account decoders.
 *
 * Field order follows the `types` section of the IDL exactly, which is the order
 * Anchor's Borsh derive writes them in. The eight byte discriminator is checked
 * before decoding, so a wrong-account-type mixup fails loudly here instead of
 * producing plausible nonsense downstream.
 */

import { PublicKey } from "@solana/web3.js";

import { BorshReader, hasDiscriminator, toHex } from "./borsh.js";
import { PoyzChainError, PoyzConfigError } from "./errors.js";
import { ACCOUNT_DISCRIMINATORS } from "./generated/idl.js";
import {
  VENUE_ALIASES,
  VENUE_ID_BASE,
  VENUE_ID_MAX_ASSIGNABLE,
  VENUE_ID_UNSET,
  VENUE_RETIRED,
  VENUE_SLOTS,
} from "./generated/venues.js";
import { baseUnitsToDecimal } from "./units.js";
import type {
  KeeperView,
  MintRequestView,
  ProtocolConfigView,
  RebalanceRecordView,
  RedeemRequestView,
  StakePositionView,
} from "./types.js";

const DISCRIMINATOR_LEN = 8;

/** Bit flags on `Config.vault_flags`, from `state.rs`. */
export const VAULT_FLAGS = {
  collateral: 1 << 0,
  bond: 1 << 1,
  funding: 1 << 2,
  stake: 1 << 3,
} as const;

/** All four vault groups initialised. */
export const VAULT_FLAGS_ALL =
  VAULT_FLAGS.collateral | VAULT_FLAGS.bond | VAULT_FLAGS.funding | VAULT_FLAGS.stake;

/**
 * Hedge venue slots, by the `venue_id` the program stores.
 *
 * Derived from the contract the program publishes beside its IDL, never from a
 * table kept here. The numbering is 1-based on purpose: slot `0` is the u8 zero
 * value, so a field that was never set is indistinguishable from a deliberate
 * choice if the primary venue lives at 0 -- a proof would then be silently
 * attributed to a venue nobody picked. The program rejects 0, and so does this.
 */
export const VENUE_NAMES: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(VENUE_SLOTS)
      .filter(([, id]) => id !== VENUE_ID_UNSET)
      .map(([name, id]) => [id, name]),
  ),
);

/** Canonical venue name to slot, including the accepted aliases. */
export const VENUE_IDS: Readonly<Record<string, number>> = Object.freeze({
  ...VENUE_SLOTS,
  ...Object.fromEntries(
    Object.entries(VENUE_ALIASES).flatMap(([alias, canonical]) => {
      const id = VENUE_SLOTS[canonical];
      return id === undefined ? [] : [[alias, id] as const];
    }),
  ),
});

/**
 * Venues that no longer operate, with the reason.
 *
 * Kept as data rather than dropped, so a string arriving from an old config or
 * an old proof is refused with an explanation instead of falling through to
 * "unknown venue".
 */
export const RETIRED_VENUES: Readonly<Record<string, string>> = VENUE_RETIRED;

/**
 * Name for a venue slot.
 *
 * Slot 0 is reported as `none`, not as a venue: it is the unset value, and
 * naming it after a real venue is how an unset field turns into a false
 * attribution.
 */
export function venueName(venueId: number): string {
  if (venueId === VENUE_ID_UNSET) {
    return "none";
  }
  return VENUE_NAMES[venueId] ?? `venue-${venueId}`;
}

/**
 * Resolve a venue name to its slot.
 *
 * An unrecognised name -- a typo, a venue that wound down, anything not in the
 * contract -- resolves to {@link VENUE_ID_UNSET}, which is 0. That is
 * deliberate and it is the same behaviour every other package in this system
 * has: 0 is not a venue, the program rejects it, and so a name nobody
 * registered can never be attributed to a real venue. The alternative, picking
 * the nearest plausible id, is the exact bug the 1-based numbering exists to
 * prevent.
 *
 * Use {@link requireVenueId} where a name came from a human and a typo should
 * be reported at the point of entry rather than deferred to the instruction.
 */
export function venueIdFromName(name: string): number {
  return VENUE_IDS[name.trim().toLowerCase()] ?? VENUE_ID_UNSET;
}

/**
 * Resolve a venue name, refusing anything the contract does not list.
 *
 * The strict counterpart of {@link venueIdFromName}, for input a person typed:
 * a misspelled venue is worth saying out loud at the flag rather than surfacing
 * later as "venue id 0 is the unset value".
 *
 * @throws PoyzConfigError for a retired venue, with why it was retired, and for
 *   a name the contract does not carry.
 */
export function requireVenueId(name: string): number {
  const key = name.trim().toLowerCase();
  const retired = RETIRED_VENUES[key];
  if (retired !== undefined) {
    throw new PoyzConfigError(`${name} is not a hedge venue: ${retired}`);
  }
  const id = VENUE_IDS[key];
  if (id === undefined || id === VENUE_ID_UNSET) {
    throw new PoyzConfigError(
      `unknown hedge venue "${name}". Known venues: ${Object.entries(VENUE_IDS)
        .filter(([, slot]) => slot !== VENUE_ID_UNSET)
        .map(([venue, slot]) => `${slot}=${venue}`)
        .join(", ")}`,
    );
  }
  return id;
}

/**
 * Whether the authority has enabled a venue slot.
 *
 * `venue_flags` is a bitmask whose bit index is the venue id, so bit 0 is
 * permanently unused.
 */
export function isVenueEnabled(venueFlags: number, venueId: number): boolean {
  if (venueId <= VENUE_ID_UNSET || venueId > VENUE_ID_MAX_ASSIGNABLE) {
    return false;
  }
  return (venueFlags & (1 << venueId)) !== 0;
}

/** Enabled venue slots, decoded from a `venue_flags` bitmask. */
export function enabledVenues(venueFlags: number): readonly number[] {
  const out: number[] = [];
  for (let id = VENUE_ID_BASE; id <= VENUE_ID_MAX_ASSIGNABLE; id += 1) {
    if (isVenueEnabled(venueFlags, id)) {
      out.push(id);
    }
  }
  return out;
}

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/**
 * The field sequence each decoder above assumes, in IDL terms.
 *
 * This is a hand-written mirror of what the readers actually consume, not a
 * derivation from the IDL. Its whole value is that it can disagree with the IDL:
 * `test/layout.test.mjs` compares the two, so a program change that reorders,
 * renames, inserts or retypes a field fails as a named mismatch instead of
 * silently decoding one field into the next one's slot.
 */
export const ACCOUNT_LAYOUTS: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  Config: [
    ["authority", "pubkey"],
    ["pending_authority", "pubkey"],
    ["guardian", "pubkey"],
    ["collateral_mint", "pubkey"],
    ["synthetic_mint", "pubkey"],
    ["bond_mint", "pubkey"],
    ["oracle", "pubkey"],
    ["token_program", "pubkey"],
    ["feed_id", "[u8;32]"],
    ["last_proof_hash", "[u8;32]"],
    ["acc_funding_per_share", "u128"],
    ["total_collateral", "u64"],
    ["pending_collateral", "u64"],
    ["total_synthetic", "u64"],
    ["pending_redeem_synthetic", "u64"],
    ["hedged_notional", "u64"],
    ["total_staked", "u64"],
    ["staker_funding_balance", "u64"],
    ["buffer_balance", "u64"],
    ["bonded_total", "u64"],
    ["slashed_total", "u64"],
    ["min_keeper_bond", "u64"],
    ["max_synthetic_supply", "u64"],
    ["rebalance_count", "u64"],
    ["last_proof_slot", "u64"],
    ["negative_funding_since", "i64"],
    ["last_settle_at", "i64"],
    ["venue_state_at", "i64"],
    ["venue_capacity_notional", "u64"],
    ["max_reportable_capacity_notional", "u64"],
    ["max_price_age_sec", "u32"],
    ["request_ttl_sec", "u32"],
    ["min_settlement_delay_sec", "u32"],
    ["unbond_cooldown_sec", "u32"],
    ["buffer_unlock_delay_sec", "u32"],
    ["unstake_cooldown_sec", "u32"],
    ["max_venue_state_age_sec", "u32"],
    ["keeper_count", "u32"],
    ["last_net_carry_bps", "i32"],
    ["min_net_carry_bps", "i32"],
    ["max_conf_bps", "u16"],
    ["collateral_ratio_bps", "u16"],
    ["mint_fee_bps", "u16"],
    ["redeem_fee_bps", "u16"],
    ["delta_band_bps", "u16"],
    ["delta_exit_bps", "u16"],
    ["delta_hard_bps", "u16"],
    ["max_hedge_slippage_bps", "u16"],
    ["buffer_share_bps", "u16"],
    ["buffer_max_draw_bps", "u16"],
    ["max_supply_vs_capacity_bps", "u16"],
    ["collateral_decimals", "u8"],
    ["synthetic_decimals", "u8"],
    ["bond_decimals", "u8"],
    ["mint_paused", "bool"],
    ["redeem_paused", "bool"],
    ["bump", "u8"],
    ["vault_flags", "u8"],
    ["venue_flags", "u8"],
    ["last_venue_id", "u8"],
    ["reserved", "[u8;25]"],
  ],
  Keeper: [
    ["keeper", "pubkey"],
    ["bonded", "u64"],
    ["slashed", "u64"],
    ["proofs_committed", "u64"],
    ["registered_at", "i64"],
    ["last_proof_at", "i64"],
    ["last_proof_slot", "u64"],
    ["last_bond_at", "i64"],
    ["active", "bool"],
    ["bump", "u8"],
    ["reserved", "[u8;14]"],
  ],
  StakePosition: [
    ["owner", "pubkey"],
    ["reward_debt", "u128"],
    ["amount", "u64"],
    ["unclaimed", "u64"],
    ["claimed_total", "u64"],
    ["last_update", "i64"],
    ["cooldown_end", "i64"],
    ["pending_unstake", "u64"],
    ["bump", "u8"],
    ["reserved", "[u8;7]"],
  ],
  MintRequest: [
    ["user", "pubkey"],
    ["nonce", "u64"],
    ["collateral_amount", "u64"],
    ["quoted_notional", "u64"],
    ["min_synthetic_out", "u64"],
    ["quoted_price", "i64"],
    ["created_at", "i64"],
    ["deadline", "i64"],
    ["quoted_slot", "u64"],
    ["quoted_expo", "i32"],
    ["bump", "u8"],
    ["reserved", "[u8;11]"],
  ],
  RedeemRequest: [
    ["user", "pubkey"],
    ["nonce", "u64"],
    ["synthetic_amount", "u64"],
    ["quoted_collateral", "u64"],
    ["min_collateral_out", "u64"],
    ["quoted_price", "i64"],
    ["created_at", "i64"],
    ["deadline", "i64"],
    ["quoted_slot", "u64"],
    ["quoted_expo", "i32"],
    ["bump", "u8"],
    ["reserved", "[u8;11]"],
  ],
  RebalanceProof: [
    ["keeper", "pubkey"],
    ["venues_hash", "[u8;32]"],
    ["prev_hash", "[u8;32]"],
    ["this_hash", "[u8;32]"],
    ["sequence", "u64"],
    ["hedged_notional", "u64"],
    ["collateral_notional", "u64"],
    ["oracle_publish_time", "i64"],
    ["oracle_posted_slot", "u64"],
    ["slot", "u64"],
    ["timestamp", "i64"],
    ["oracle_price", "i64"],
    ["oracle_conf", "u64"],
    ["delta_bps_before", "i32"],
    ["delta_bps_after", "i32"],
    ["oracle_expo", "i32"],
    ["venue_id", "u8"],
    ["bump", "u8"],
    ["reserved", "[u8;18]"],
  ],
};


function requireDiscriminator(data: Uint8Array, account: string): void {
  const discriminator = ACCOUNT_DISCRIMINATORS[account];
  if (discriminator === undefined) {
    throw new PoyzChainError(`no discriminator for account type ${account} in the compiled IDL`);
  }
  if (!hasDiscriminator(data, discriminator)) {
    throw new PoyzChainError(
      `account data does not carry the ${account} discriminator; ` +
        "the address holds a different account type or the program was rebuilt",
    );
  }
}

function base58(bytes: Uint8Array): string {
  return new PublicKey(bytes).toBase58();
}

/** Unix seconds to milliseconds, with zero meaning "never". */
function secondsToMs(seconds: bigint): number | null {
  return seconds === 0n ? null : Number(seconds) * 1000;
}

/** `price * 10^expo`, the decimal the oracle feed represents. */
export function oracleToDecimal(price: bigint, expo: number): number {
  return Number(price) * 10 ** expo;
}

/**
 * Decode `Config`, the protocol singleton.
 *
 * @throws PoyzChainError when the discriminator does not match.
 */
export function decodeConfig(address: string, data: Uint8Array): ProtocolConfigView {
  requireDiscriminator(data, "Config");
  const reader = new BorshReader(data, DISCRIMINATOR_LEN);

  const authority = base58(reader.publicKeyBytes());
  const pendingAuthority = base58(reader.publicKeyBytes());
  const guardian = base58(reader.publicKeyBytes());
  const collateralMint = base58(reader.publicKeyBytes());
  const syntheticMint = base58(reader.publicKeyBytes());
  const bondMint = base58(reader.publicKeyBytes());
  const oracle = base58(reader.publicKeyBytes());
  const tokenProgram = base58(reader.publicKeyBytes());
  const feedId = reader.fixedBytes(32);
  const lastProofHash = reader.fixedBytes(32);

  const accFundingPerShare = reader.u128();
  const totalCollateral = reader.u64();
  const pendingCollateral = reader.u64();
  const totalSynthetic = reader.u64();
  const pendingRedeemSynthetic = reader.u64();
  const hedgedNotional = reader.u64();
  const totalStaked = reader.u64();
  const stakerFundingBalance = reader.u64();
  const bufferBalance = reader.u64();
  const bondedTotal = reader.u64();
  const slashedTotal = reader.u64();
  const minKeeperBond = reader.u64();
  const maxSyntheticSupply = reader.u64();
  const rebalanceCount = reader.u64();
  const lastProofSlot = reader.u64();
  const negativeFundingSince = reader.i64();
  const lastSettleAt = reader.i64();
  const venueStateAt = reader.i64();
  const venueCapacityNotional = reader.u64();
  const maxReportableCapacityNotional = reader.u64();

  const maxPriceAgeSec = reader.u32();
  const requestTtlSec = reader.u32();
  const minSettlementDelaySec = reader.u32();
  const unbondCooldownSec = reader.u32();
  const bufferUnlockDelaySec = reader.u32();
  const unstakeCooldownSec = reader.u32();
  const maxVenueStateAgeSec = reader.u32();
  const keeperCount = reader.u32();
  const lastNetCarryBps = reader.i32();
  const minNetCarryBps = reader.i32();

  const maxConfBps = reader.u16();
  const collateralRatioBps = reader.u16();
  const mintFeeBps = reader.u16();
  const redeemFeeBps = reader.u16();
  const deltaBandBps = reader.u16();
  const deltaExitBps = reader.u16();
  const deltaHardBps = reader.u16();
  const maxHedgeSlippageBps = reader.u16();
  const bufferShareBps = reader.u16();
  const bufferMaxDrawBps = reader.u16();
  const maxSupplyVsCapacityBps = reader.u16();

  const collateralDecimals = reader.u8();
  const syntheticDecimals = reader.u8();
  const bondDecimals = reader.u8();
  const mintPaused = reader.bool();
  const redeemPaused = reader.bool();
  reader.u8(); // bump
  const vaultFlags = reader.u8();
  const venueFlags = reader.u8();
  const lastVenueId = reader.u8();

  return {
    address,
    authority,
    pendingAuthority: pendingAuthority === SYSTEM_PROGRAM ? null : pendingAuthority,
    guardian: guardian === SYSTEM_PROGRAM ? null : guardian,
    collateralMint,
    syntheticMint,
    bondMint,
    oracle,
    tokenProgram,
    feedIdHex: toHex(feedId),
    lastProofHashHex: toHex(lastProofHash),

    totalCollateral: totalCollateral.toString(),
    pendingCollateral: pendingCollateral.toString(),
    totalSynthetic: totalSynthetic.toString(),
    pendingRedeemSynthetic: pendingRedeemSynthetic.toString(),
    hedgedNotional: hedgedNotional.toString(),
    totalStaked: totalStaked.toString(),
    stakerFundingBalance: stakerFundingBalance.toString(),
    bufferBalance: bufferBalance.toString(),
    bondedTotal: bondedTotal.toString(),
    slashedTotal: slashedTotal.toString(),
    minKeeperBond: minKeeperBond.toString(),
    maxSyntheticSupply: maxSyntheticSupply.toString(),
    accFundingPerShare: accFundingPerShare.toString(),

    rebalanceCount: Number(rebalanceCount),
    lastProofSlot: Number(lastProofSlot),
    keeperCount,

    maxPriceAgeSec,
    requestTtlSec,
    minSettlementDelaySec,
    unbondCooldownSec,
    bufferUnlockDelaySec,
    unstakeCooldownSec,
    maxVenueStateAgeSec,

    lastNetCarryBps,
    minNetCarryBps,
    maxConfBps,
    collateralRatioBps,
    mintFeeBps,
    redeemFeeBps,
    deltaBandBps,
    deltaExitBps,
    deltaHardBps,
    maxHedgeSlippageBps,
    bufferShareBps,
    bufferMaxDrawBps,
    maxSupplyVsCapacityBps,

    negativeFundingSinceMs: secondsToMs(negativeFundingSince),
    lastSettleAtMs: secondsToMs(lastSettleAt),
    venueStateAtMs: secondsToMs(venueStateAt),
    venueCapacityNotional: venueCapacityNotional.toString(),
    maxReportableCapacityNotional: maxReportableCapacityNotional.toString(),

    collateralDecimals,
    syntheticDecimals,
    bondDecimals,
    mintPaused,
    redeemPaused,
    vaultFlags,
    vaultsReady: vaultFlags === VAULT_FLAGS_ALL,
    venueFlags,
    lastVenueId,
  };
}

/**
 * Decode `Keeper`.
 *
 * @throws PoyzChainError when the discriminator does not match.
 */
export function decodeKeeper(address: string, data: Uint8Array): KeeperView {
  requireDiscriminator(data, "Keeper");
  const reader = new BorshReader(data, DISCRIMINATOR_LEN);

  const keeper = base58(reader.publicKeyBytes());
  const bonded = reader.u64();
  const slashed = reader.u64();
  const proofsCommitted = reader.u64();
  const registeredAt = reader.i64();
  const lastProofAt = reader.i64();
  const lastProofSlot = reader.u64();
  const lastBondAt = reader.i64();
  const active = reader.bool();

  return {
    address,
    keeper,
    bonded: bonded.toString(),
    slashed: slashed.toString(),
    proofsCommitted: Number(proofsCommitted),
    registeredAtMs: Number(registeredAt) * 1000,
    lastProofAtMs: secondsToMs(lastProofAt),
    lastProofSlot: Number(lastProofSlot),
    lastBondAtMs: secondsToMs(lastBondAt),
    active,
  };
}

/**
 * Decode `StakePosition`.
 *
 * @throws PoyzChainError when the discriminator does not match.
 */
export function decodeStakePosition(address: string, data: Uint8Array): StakePositionView {
  requireDiscriminator(data, "StakePosition");
  const reader = new BorshReader(data, DISCRIMINATOR_LEN);

  const owner = base58(reader.publicKeyBytes());
  const rewardDebt = reader.u128();
  const amount = reader.u64();
  const unclaimed = reader.u64();
  const claimedTotal = reader.u64();
  const lastUpdate = reader.i64();
  const cooldownEnd = reader.i64();
  const pendingUnstake = reader.u64();

  return {
    address,
    owner,
    amount: amount.toString(),
    unclaimed: unclaimed.toString(),
    claimedTotal: claimedTotal.toString(),
    pendingUnstake: pendingUnstake.toString(),
    rewardDebt: rewardDebt.toString(),
    lastUpdateMs: secondsToMs(lastUpdate),
    cooldownEndMs: secondsToMs(cooldownEnd),
  };
}

/**
 * Decode `MintRequest`.
 *
 * @param nowMs Clock reading used to decide whether the deadline has passed.
 * @throws PoyzChainError when the discriminator does not match.
 */
export function decodeMintRequest(address: string, data: Uint8Array, nowMs: number): MintRequestView {
  requireDiscriminator(data, "MintRequest");
  const reader = new BorshReader(data, DISCRIMINATOR_LEN);

  const user = base58(reader.publicKeyBytes());
  const nonce = reader.u64();
  const collateralAmount = reader.u64();
  const quotedNotional = reader.u64();
  const minSyntheticOut = reader.u64();
  const quotedPrice = reader.i64();
  const createdAt = reader.i64();
  const deadline = reader.i64();
  const quotedSlot = reader.u64();
  const quotedExpo = reader.i32();

  const deadlineMs = Number(deadline) * 1000;
  return {
    address,
    user,
    nonce: nonce.toString(),
    collateralAmount: collateralAmount.toString(),
    quotedNotional: quotedNotional.toString(),
    minSyntheticOut: minSyntheticOut.toString(),
    quotedPrice: quotedPrice.toString(),
    quotedExpo,
    quotedPriceUsd: oracleToDecimal(quotedPrice, quotedExpo),
    quotedSlot: Number(quotedSlot),
    createdAtMs: Number(createdAt) * 1000,
    deadlineMs,
    expired: nowMs > deadlineMs,
  };
}

/**
 * Decode `RedeemRequest`.
 *
 * @param nowMs Clock reading used to decide whether the deadline has passed.
 * @throws PoyzChainError when the discriminator does not match.
 */
export function decodeRedeemRequest(
  address: string,
  data: Uint8Array,
  nowMs: number,
): RedeemRequestView {
  requireDiscriminator(data, "RedeemRequest");
  const reader = new BorshReader(data, DISCRIMINATOR_LEN);

  const user = base58(reader.publicKeyBytes());
  const nonce = reader.u64();
  const syntheticAmount = reader.u64();
  const quotedCollateral = reader.u64();
  const minCollateralOut = reader.u64();
  const quotedPrice = reader.i64();
  const createdAt = reader.i64();
  const deadline = reader.i64();
  const quotedSlot = reader.u64();
  const quotedExpo = reader.i32();

  const deadlineMs = Number(deadline) * 1000;
  return {
    address,
    user,
    nonce: nonce.toString(),
    syntheticAmount: syntheticAmount.toString(),
    quotedCollateral: quotedCollateral.toString(),
    minCollateralOut: minCollateralOut.toString(),
    quotedPrice: quotedPrice.toString(),
    quotedExpo,
    quotedPriceUsd: oracleToDecimal(quotedPrice, quotedExpo),
    quotedSlot: Number(quotedSlot),
    createdAtMs: Number(createdAt) * 1000,
    deadlineMs,
    expired: nowMs > deadlineMs,
  };
}

/**
 * Decode `RebalanceProof` into a rebalance record.
 *
 * The notionals are stored in synthetic base units, and the synthetic dollar is
 * the unit of account, so they convert to real dollars once `syntheticDecimals`
 * is known. Pass it when you have the config; without it the dollar fields are
 * left null rather than scaled by a guess.
 *
 * @throws PoyzChainError when the discriminator does not match.
 */
export function decodeRebalanceProof(
  address: string,
  data: Uint8Array,
  syntheticDecimals?: number,
): RebalanceRecordView {
  requireDiscriminator(data, "RebalanceProof");
  const reader = new BorshReader(data, DISCRIMINATOR_LEN);

  const keeper = base58(reader.publicKeyBytes());
  const venuesHash = reader.fixedBytes(32);
  const prevHash = reader.fixedBytes(32);
  const thisHash = reader.fixedBytes(32);
  const sequence = reader.u64();
  const hedgedNotional = reader.u64();
  const collateralNotional = reader.u64();
  const oraclePublishTime = reader.i64();
  const oraclePostedSlot = reader.u64();
  const slot = reader.u64();
  const timestamp = reader.i64();
  const oraclePrice = reader.i64();
  const oracleConf = reader.u64();
  const deltaBpsBefore = reader.i32();
  const deltaBpsAfter = reader.i32();
  const oracleExpo = reader.i32();
  const venueId = reader.u8();

  const usd = (value: bigint): number | null =>
    syntheticDecimals === undefined ? null : baseUnitsToDecimal(value, syntheticDecimals);

  return {
    sequence: Number(sequence),
    address,
    keeper,
    venueId,
    venue: venueName(venueId),
    deltaBpsBefore,
    deltaBpsAfter,
    hedgedNotional: hedgedNotional.toString(),
    collateralNotional: collateralNotional.toString(),
    hedgedNotionalUsd: usd(hedgedNotional),
    collateralNotionalUsd: usd(collateralNotional),
    slot: Number(slot),
    timestampMs: Number(timestamp) * 1000,
    venuesHashHex: toHex(venuesHash),
    prevHashHex: toHex(prevHash),
    thisHashHex: toHex(thisHash),
    oraclePrice: oraclePrice.toString(),
    oracleConf: oracleConf.toString(),
    oracleExpo,
    oraclePriceUsd: oracleToDecimal(oraclePrice, oracleExpo),
    oraclePublishTimeMs: Number(oraclePublishTime) * 1000,
    oraclePostedSlot: Number(oraclePostedSlot),
  };
}
