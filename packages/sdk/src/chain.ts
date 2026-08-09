/**
 * On-chain reader.
 *
 * Reads the program's own accounts, so nothing here depends on the indexer being
 * up. What it can answer is bounded by what the program stores: the config
 * carries balances, parameters and the rebalance counter, and each rebalance
 * leaves a `RebalanceProof` recording the delta before and after together with
 * the oracle price it was computed against.
 */

import { Connection, PublicKey } from "@solana/web3.js";

import {
  decodeConfig,
  decodeKeeper,
  decodeMintRequest,
  decodeRebalanceProof,
  decodeRedeemRequest,
  decodeStakePosition,
} from "./accounts.js";
import type { PoyzClientConfig } from "./config.js";
import { PoyzAccountNotFoundError, PoyzChainError } from "./errors.js";
import {
  deriveConfig,
  deriveKeeper,
  deriveMintRequest,
  deriveRebalanceProof,
  deriveRedeemRequest,
  deriveStakePosition,
  toPublicKey,
} from "./pda.js";
import { baseUnitsToDecimal } from "./units.js";
import type {
  CollateralStatusView,
  DeltaStatusView,
  KeeperView,
  MintRequestView,
  ProtocolConfigView,
  RebalanceRecordView,
  RedeemRequestView,
  SourcedValue,
  StakePositionView,
} from "./types.js";

function unavailable<T>(detail: string): SourcedValue<T> {
  return { source: "chain", available: false, observedAtMs: null, detail, data: null };
}

/** Reads POYZ program state directly from a Solana RPC endpoint. */
export class PoyzChainClient {
  readonly connection: Connection;
  readonly programId: PublicKey;

  constructor(
    config: Pick<PoyzClientConfig, "rpcUrl" | "programId" | "commitment">,
    connection?: Connection,
  ) {
    this.connection = connection ?? new Connection(config.rpcUrl, config.commitment);
    this.programId = toPublicKey(config.programId, "programId");
  }

  private get program(): string {
    return this.programId.toBase58();
  }

  private async getAccountData(address: PublicKey, what: string): Promise<Uint8Array> {
    let info;
    try {
      info = await this.connection.getAccountInfo(address);
    } catch (cause) {
      throw new PoyzChainError(
        `RPC call for the ${what} account failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
    if (info === null) {
      throw new PoyzAccountNotFoundError(address.toBase58(), what);
    }
    if (!info.owner.equals(this.programId)) {
      throw new PoyzChainError(
        `${what} account ${address.toBase58()} is owned by ${info.owner.toBase58()}, not by the POYZ program`,
      );
    }
    return Uint8Array.from(info.data);
  }

  /**
   * Decode the protocol config.
   *
   * @throws PoyzAccountNotFoundError before `initialize` has been called on this
   *   cluster, which is also what a wrong program id looks like.
   */
  async getConfig(): Promise<ProtocolConfigView> {
    const [config] = deriveConfig(this.program);
    return decodeConfig(config.toBase58(), await this.getAccountData(config, "config"));
  }

  /** Decode a keeper account. */
  async getKeeper(keeper: string): Promise<KeeperView> {
    const [address] = deriveKeeper(keeper, this.program);
    return decodeKeeper(address.toBase58(), await this.getAccountData(address, "keeper"));
  }

  /** Decode a stake position. */
  async getStakePosition(owner: string): Promise<StakePositionView> {
    const [address] = deriveStakePosition(owner, this.program);
    return decodeStakePosition(address.toBase58(), await this.getAccountData(address, "stake position"));
  }

  /** Decode an open mint request. */
  async getMintRequest(user: string, nonce: bigint, nowMs = Date.now()): Promise<MintRequestView> {
    const [address] = deriveMintRequest(user, nonce, this.program);
    return decodeMintRequest(
      address.toBase58(),
      await this.getAccountData(address, "mint request"),
      nowMs,
    );
  }

  /** Decode an open redeem request. */
  async getRedeemRequest(user: string, nonce: bigint, nowMs = Date.now()): Promise<RedeemRequestView> {
    const [address] = deriveRedeemRequest(user, nonce, this.program);
    return decodeRedeemRequest(
      address.toBase58(),
      await this.getAccountData(address, "redeem request"),
      nowMs,
    );
  }

  /** Decode one rebalance proof by sequence number. */
  async getRebalanceProof(sequence: bigint, syntheticDecimals?: number): Promise<RebalanceRecordView> {
    const [address] = deriveRebalanceProof(sequence, this.program);
    return decodeRebalanceProof(
      address.toBase58(),
      await this.getAccountData(address, "rebalance proof"),
      syntheticDecimals,
    );
  }

  /**
   * Read the most recent proofs, newest first.
   *
   * Sequences run from 0 to `config.rebalanceCount - 1`. Addresses are derived
   * rather than scanned, so this costs one config read plus one multi-account
   * read regardless of how long the chain is. A missing account in the range is
   * skipped rather than silently filled.
   *
   * @param limit How many proofs to fetch, newest first. Capped at 100.
   */
  async getRebalances(
    limit = 10,
    config?: ProtocolConfigView,
  ): Promise<{ config: ProtocolConfigView; records: readonly RebalanceRecordView[] }> {
    const resolved = config ?? (await this.getConfig());
    const count = resolved.rebalanceCount;
    if (count <= 0) {
      return { config: resolved, records: [] };
    }

    const take = Math.max(1, Math.min(Math.trunc(limit), 100));
    const addresses: PublicKey[] = [];
    for (let i = 0; i < take && count - 1 - i >= 0; i += 1) {
      addresses.push(deriveRebalanceProof(BigInt(count - 1 - i), this.program)[0]);
    }

    let infos;
    try {
      infos = await this.connection.getMultipleAccountsInfo(addresses);
    } catch (cause) {
      throw new PoyzChainError(
        `RPC call for rebalance proofs failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }

    const records: RebalanceRecordView[] = [];
    for (let i = 0; i < addresses.length; i += 1) {
      const info = infos[i];
      const address = addresses[i];
      if (info === null || info === undefined || address === undefined) {
        continue;
      }
      records.push(
        decodeRebalanceProof(
          address.toBase58(),
          Uint8Array.from(info.data),
          resolved.syntheticDecimals,
        ),
      );
    }
    return { config: resolved, records };
  }

  /**
   * Delta as the chain last attested it.
   *
   * The authoritative on-chain delta is `delta_bps_after` on the newest proof:
   * the keeper committed it, and the program refused to record it unless it was
   * inside the band. Until the first proof exists there is no on-chain delta,
   * and this says so rather than returning a zero.
   */
  async getDelta(config?: ProtocolConfigView): Promise<SourcedValue<DeltaStatusView>> {
    const { config: resolved, records } = await this.getRebalances(1, config);
    const latest = records[0];
    if (latest === undefined) {
      return unavailable(
        resolved.rebalanceCount === 0
          ? "No rebalance proof has been committed yet, so the chain carries no attested delta."
          : "The newest rebalance proof account could not be read.",
      );
    }

    return {
      source: "chain",
      available: true,
      observedAtMs: latest.timestampMs,
      detail:
        `Attested by rebalance proof ${latest.sequence} on venue slot ${latest.venueId} (${latest.venue}), ` +
        `at oracle price ` +
        `${latest.oraclePriceUsd}. Per-venue exposure is not stored on chain; read the status API ` +
        "for that breakdown.",
      data: {
        capturedAtMs: latest.timestampMs,
        deviationRatio: latest.deltaBpsAfter / 10_000,
        deviationBps: latest.deltaBpsAfter,
        thresholdBps: resolved.deltaBandBps,
        withinThreshold: Math.abs(latest.deltaBpsAfter) <= resolved.deltaBandBps,
        spotNotionalUsd: latest.collateralNotionalUsd,
        shortNotionalUsd: latest.hedgedNotionalUsd,
        rebalanceCount: resolved.rebalanceCount,
        lastRebalanceAtMs: latest.timestampMs,
        // The chain records which venue executed a rebalance, not how carry is
        // assembled across the mix. That belongs to the status API.
        carryModel: null,
        venues: [],
      },
    };
  }

  /**
   * Collateral and supply, as the config records them.
   *
   * Supply and buffer are exact: both are denominated in the synthetic dollar.
   * The dollar value of the collateral itself needs an oracle price, which the
   * config does not carry, so it is taken from the newest rebalance proof and
   * timestamped accordingly, or left null when no proof exists.
   */
  async getCollateral(config?: ProtocolConfigView): Promise<SourcedValue<CollateralStatusView>> {
    const { config: resolved, records } = await this.getRebalances(1, config);
    const latest = records[0];
    const supplyUsd = baseUnitsToDecimal(BigInt(resolved.totalSynthetic), resolved.syntheticDecimals);
    const bufferUsd = baseUnitsToDecimal(BigInt(resolved.bufferBalance), resolved.syntheticDecimals);
    const collateralAmount = baseUnitsToDecimal(
      BigInt(resolved.totalCollateral),
      resolved.collateralDecimals,
    );

    const totalUsd = latest?.collateralNotionalUsd ?? null;
    return {
      source: "chain",
      available: true,
      observedAtMs: latest?.timestampMs ?? null,
      detail:
        totalUsd === null
          ? "Supply and buffer are exact. The dollar value of the collateral needs an oracle price, " +
            "and no rebalance proof has recorded one yet."
          : `Supply and buffer are exact. The collateral dollar value is the one attested by ` +
            `rebalance proof ${latest?.sequence}, not a live mark.`,
      data: {
        capturedAtMs: latest?.timestampMs ?? Date.now(),
        totalUsd,
        supplyUsd,
        bufferUsd,
        assets:
          totalUsd === null
            ? []
            : [
                {
                  symbol: resolved.collateralMint,
                  amount: collateralAmount,
                  usdValue: totalUsd,
                  weight: 1,
                },
              ],
      },
    };
  }
}
