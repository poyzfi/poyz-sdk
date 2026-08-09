/**
 * Read model.
 *
 * Every numeric field the protocol might not know yet is `T | null`, not `T`
 * with a zero default. A zero delta and an unknown delta are different facts and
 * a consumer must be able to tell them apart; rendering `0.00%` for "we have not
 * measured this" is the failure mode this shape exists to prevent.
 *
 * Amounts that come off the chain as u64 are carried as decimal strings in base
 * units rather than `number`, because a u64 does not fit in a double and
 * silently rounding a balance is worse than making the caller convert it. Use
 * `formatBaseUnits` with the decimals reported by the config.
 */

import type { PoyzCluster } from "./config.js";
import { PoyzUnavailableError } from "./errors.js";

/**
 * A value together with where it came from and whether it exists.
 *
 * `available: false` means the source answered and had nothing; `detail` then
 * carries the reason. `detail` can also be set on an available value, to attach
 * a caveat about how it was derived.
 */
export interface SourcedValue<T> {
  readonly source: "api" | "chain";
  readonly available: boolean;
  readonly observedAtMs: number | null;
  readonly detail: string | null;
  readonly data: T | null;
}

/**
 * How a venue charges or pays the short leg.
 *
 * These are not two flavours of the same thing. On a funding venue the short can
 * receive or pay depending on the market; on a borrow-fee venue the position
 * holder always pays, so that leg is a cost line and never a yield line.
 */
export type VenueCarryModel = "funding-receiving" | "borrow-fee-paying" | (string & {});

/**
 * One hedge venue.
 *
 * Exposure is nullable because the protocol publishes venue market data long
 * before it holds a position on any of them, and withholding the size is the
 * honest answer there. A `null` notional means "no position, or not published",
 * never "zero notional".
 */
export interface VenueExposureView {
  readonly venue: string;
  readonly displayName: string | null;
  /**
   * Venue slot, 1-based, resolved from the name through the program's contract.
   * `0` means the name maps to no slot -- a retired venue or one this build does
   * not know -- and 0 is never addressable on chain.
   */
  readonly venueId: number;
  /** `live` | `candidate` | `discontinued` | `unavailable`, as the API reports it. */
  readonly status: string | null;
  readonly market: string | null;
  readonly shortNotionalUsd: number | null;
  /** Share of the total hedge carried by this venue, 0..1. */
  readonly weight: number | null;
  /**
   * Annualized carry at this venue, as a decimal, signed from the protocol's
   * point of view. Negative means the protocol pays.
   */
  readonly carryAnnualizedRate: number | null;
  readonly carryModel: VenueCarryModel | null;
  /** `received` | `paid`, when the API states the direction outright. */
  readonly carryDirection: string | null;
  /** Why a venue is not carrying hedge, when the API says so. */
  readonly detail: string | null;
}

export interface DeltaStatusView {
  readonly capturedAtMs: number;
  /** Signed deviation as a decimal. `0.0042` is 0.42 percent long of neutral. */
  readonly deviationRatio: number | null;
  /** The same deviation in basis points, signed. */
  readonly deviationBps: number | null;
  /**
   * The band this reading was judged against, in basis points.
   *
   * For a chain-attested delta this is the **exit** band: the program requires a
   * committed proof to land inside it, so it is what the number was actually
   * held to. It is narrower than {@link DeltaStatusView.triggerBps}.
   */
  readonly thresholdBps: number | null;
  /**
   * Deviation at which a rebalance becomes necessary, in basis points.
   *
   * Wider than `thresholdBps` on purpose: the trigger is where a rebalance
   * starts, the exit band is where it has to finish. Reporting the trigger as
   * the tolerance would accept a keeper that stopped as soon as it began.
   */
  readonly triggerBps: number | null;
  readonly withinThreshold: boolean | null;
  readonly spotNotionalUsd: number | null;
  readonly shortNotionalUsd: number | null;
  readonly rebalanceCount: number | null;
  readonly lastRebalanceAtMs: number | null;
  /** How carry is assembled across the venue mix, when the source states it. */
  readonly carryModel: string | null;
  readonly venues: readonly VenueExposureView[];
}

export interface VenueFundingView {
  readonly venue: string;
  /** Annualized rate as a decimal, signed. Negative means the protocol pays. */
  readonly annualizedRate: number;
  readonly market: string | null;
  readonly carryModel: VenueCarryModel | null;
}

/**
 * Carry on the hedged book.
 *
 * Named carry, not yield, because it is signed and is negative in the current
 * regime: the short leg pays. The representative number is `netCarryRate` --
 * funding received on the funding venue, less the borrow fee paid on the
 * LP-pool venue. Presenting the two legs as one summed yield would read as
 * income when the total is a cost.
 */
export interface FundingStatusView {
  readonly capturedAtMs: number;
  /**
   * Net annualized carry as a decimal, signed. `-0.358` is 35.8 percent paid
   * out per year. This is the representative figure; show it with its sign.
   */
  readonly netCarryRate: number | null;
  /** Funding received on funding-model venues, before hedge costs. */
  readonly grossFundingRate: number | null;
  /** Borrow fee paid on borrow-fee venues, as a positive cost. */
  readonly hedgeCostRate: number | null;
  /**
   * Alias of {@link FundingStatusView.netCarryRate}, kept because "annualized
   * rate" is what most call sites ask for. It is the net, never the gross.
   */
  readonly annualizedRate: number | null;
  /**
   * True when the figure is projected from an instantaneous rate rather than
   * realised over a window. A consumer showing an estimate must label it one.
   */
  readonly isEstimate: boolean;
  readonly windowHours: number | null;
  /** True while the book pays carry instead of receiving it. */
  readonly negativeCarry: boolean | null;
  /** How the reported figure was assembled, when the API states it. */
  readonly carryModel: string | null;
  readonly venues: readonly VenueFundingView[];
}

export interface CollateralAssetView {
  readonly symbol: string;
  readonly amount: number;
  readonly usdValue: number;
  /** Share of total collateral value, 0..1. */
  readonly weight: number;
}

export interface CollateralStatusView {
  readonly capturedAtMs: number;
  readonly totalUsd: number | null;
  /** Outstanding synthetic dollar supply. */
  readonly supplyUsd: number | null;
  readonly bufferUsd: number | null;
  readonly assets: readonly CollateralAssetView[];
}

/**
 * One committed rebalance, read from the on-chain proof chain.
 *
 * Notionals are stored by the program in synthetic base units, and the synthetic
 * is the dollar, so `collateralNotionalUsd` and `hedgedNotionalUsd` are real
 * dollar figures rather than a guessed scale. The raw base-unit strings are kept
 * alongside them for exactness.
 */
export interface RebalanceRecordView {
  readonly sequence: number;
  readonly address: string;
  readonly keeper: string;
  readonly venueId: number;
  readonly venue: string;
  readonly deltaBpsBefore: number;
  readonly deltaBpsAfter: number;
  readonly hedgedNotional: string;
  readonly collateralNotional: string;
  readonly hedgedNotionalUsd: number | null;
  readonly collateralNotionalUsd: number | null;
  readonly slot: number;
  readonly timestampMs: number;
  /** Hash of the venue-side execution payload the keeper attested to. */
  readonly venuesHashHex: string;
  /** Previous link in the proof chain, so the history is tamper-evident. */
  readonly prevHashHex: string;
  readonly thisHashHex: string;
  /** Oracle price used for the proof, as the raw feed integer. */
  readonly oraclePrice: string;
  /** Oracle confidence interval at the same exponent as the price. */
  readonly oracleConf: string;
  readonly oracleExpo: number;
  /** The same price as a decimal, `oraclePrice * 10^oracleExpo`. */
  readonly oraclePriceUsd: number;
  readonly oraclePublishTimeMs: number;
  readonly oraclePostedSlot: number;
}

/** Decoded `Config`, the protocol singleton. */
export interface ProtocolConfigView {
  readonly address: string;
  readonly authority: string;
  readonly pendingAuthority: string | null;
  /** Key allowed to pause but never to unpause. Null when unset. */
  readonly guardian: string | null;
  readonly collateralMint: string;
  readonly syntheticMint: string;
  readonly bondMint: string;
  readonly oracle: string;
  readonly tokenProgram: string;
  readonly feedIdHex: string;
  /** Head of the rebalance proof hash chain. */
  readonly lastProofHashHex: string;

  readonly totalCollateral: string;
  readonly pendingCollateral: string;
  readonly totalSynthetic: string;
  readonly pendingRedeemSynthetic: string;
  readonly hedgedNotional: string;
  readonly totalStaked: string;
  readonly stakerFundingBalance: string;
  readonly bufferBalance: string;
  readonly bondedTotal: string;
  readonly slashedTotal: string;
  readonly minKeeperBond: string;
  readonly maxSyntheticSupply: string;
  readonly accFundingPerShare: string;
  /** Hedge capacity last reported for the active venue. */
  readonly venueCapacityNotional: string;
  /**
   * Ceiling on a single capacity report.
   *
   * A reporter cannot claim more headroom than this, which bounds how much
   * issuance one bad or compromised report can unlock.
   */
  readonly maxReportableCapacityNotional: string;

  readonly rebalanceCount: number;
  readonly lastProofSlot: number;
  readonly keeperCount: number;

  readonly maxPriceAgeSec: number;
  readonly requestTtlSec: number;
  readonly minSettlementDelaySec: number;
  readonly unbondCooldownSec: number;
  readonly bufferUnlockDelaySec: number;
  readonly unstakeCooldownSec: number;
  /** How old a venue-state report may be before it is treated as stale. */
  readonly maxVenueStateAgeSec: number;

  /** Net carry last reported for the active venue, in basis points. */
  readonly lastNetCarryBps: number;
  /** Net carry below which the protocol stops adding hedge at that venue. */
  readonly minNetCarryBps: number;
  readonly maxConfBps: number;
  readonly collateralRatioBps: number;
  readonly mintFeeBps: number;
  readonly redeemFeeBps: number;
  /** Deviation that triggers a rebalance, and the ceiling a proof must be under. */
  readonly deltaBandBps: number;
  /** Inner hysteresis target the keeper rebalances back to. */
  readonly deltaExitBps: number;
  /** Deviation past which the protocol treats the book as breached, not drifting. */
  readonly deltaHardBps: number;
  readonly maxHedgeSlippageBps: number;
  readonly bufferShareBps: number;
  readonly bufferMaxDrawBps: number;
  /** Supply cap as a share of reported venue capacity, in basis points. */
  readonly maxSupplyVsCapacityBps: number;

  /** Unix ms since funding turned negative, or null while it has not. */
  readonly negativeFundingSinceMs: number | null;
  readonly lastSettleAtMs: number | null;
  /** When the active venue's state was last reported. Null when never. */
  readonly venueStateAtMs: number | null;

  readonly collateralDecimals: number;
  readonly syntheticDecimals: number;
  readonly bondDecimals: number;
  readonly mintPaused: boolean;
  readonly redeemPaused: boolean;
  /** Bitfield of initialised vault groups. */
  readonly vaultFlags: number;
  /** True once all four vault groups exist; the protocol rejects flow until then. */
  readonly vaultsReady: boolean;
  /** Bitfield of venues the authority has enabled. */
  readonly venueFlags: number;
  /** Venue id the last reported state belongs to. */
  readonly lastVenueId: number;
}

/** Decoded `Keeper`. */
export interface KeeperView {
  readonly address: string;
  readonly keeper: string;
  readonly bonded: string;
  readonly slashed: string;
  readonly proofsCommitted: number;
  readonly registeredAtMs: number;
  readonly lastProofAtMs: number | null;
  readonly lastProofSlot: number;
  readonly lastBondAtMs: number | null;
  readonly active: boolean;
}

/** Decoded `StakePosition`. */
export interface StakePositionView {
  readonly address: string;
  readonly owner: string;
  readonly amount: string;
  readonly unclaimed: string;
  readonly claimedTotal: string;
  /** Amount whose unstake cooldown is running, withdrawable once it ends. */
  readonly pendingUnstake: string;
  readonly rewardDebt: string;
  readonly lastUpdateMs: number | null;
  /** When the pending unstake becomes withdrawable. Null when none is pending. */
  readonly cooldownEndMs: number | null;
}

/** Decoded `MintRequest`, the first leg of a two-step issuance. */
export interface MintRequestView {
  readonly address: string;
  readonly user: string;
  readonly nonce: string;
  readonly collateralAmount: string;
  readonly quotedNotional: string;
  readonly minSyntheticOut: string;
  readonly quotedPrice: string;
  readonly quotedExpo: number;
  readonly quotedPriceUsd: number;
  readonly quotedSlot: number;
  readonly createdAtMs: number;
  readonly deadlineMs: number;
  /** True once the deadline has passed, at the clock reading supplied. */
  readonly expired: boolean;
}

/** Decoded `RedeemRequest`, the first leg of a two-step redemption. */
export interface RedeemRequestView {
  readonly address: string;
  readonly user: string;
  readonly nonce: string;
  readonly syntheticAmount: string;
  readonly quotedCollateral: string;
  readonly minCollateralOut: string;
  readonly quotedPrice: string;
  readonly quotedExpo: number;
  readonly quotedPriceUsd: number;
  readonly quotedSlot: number;
  readonly createdAtMs: number;
  readonly deadlineMs: number;
  readonly expired: boolean;
}

export interface ProtocolStatsView {
  readonly cluster: PoyzCluster;
  readonly programId: string;
  readonly anchorVersion: string | null;
  readonly delta: DeltaStatusView | null;
  readonly funding: FundingStatusView | null;
  readonly collateral: CollateralStatusView | null;
  readonly config: ProtocolConfigView | null;
  /**
   * Caveats attached to this snapshot, in plain language.
   *
   * Populated when part of the picture is missing, so a consumer can explain the
   * gap instead of presenting a partial view as a complete one.
   */
  readonly notes: readonly string[];
}

/** Which backend a read should come from. */
export type ReadSource = "api" | "chain" | "auto";

export interface ReadOptions {
  readonly source?: ReadSource;
  readonly signal?: AbortSignal;
}

/** Guard for the nullable fields above. Gate rendering on this. */
export function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * Unwrap a reading, or throw with the reason it has no value.
 *
 * Reads return `SourcedValue` rather than throwing, because "the protocol has
 * not published this yet" is a state a UI must render. In a script that has
 * nothing to render, branching on it is noise; this turns the same state into a
 * {@link PoyzUnavailableError} carrying the same reason.
 *
 * @throws PoyzUnavailableError when the value is not available.
 */
export function requireAvailable<T>(value: SourcedValue<T>, metric: string): T {
  if (!value.available || value.data === null) {
    throw new PoyzUnavailableError(metric, value.detail ?? "the source published no value");
  }
  return value.data;
}
