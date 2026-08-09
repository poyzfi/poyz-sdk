/**
 * The client an integrator holds.
 *
 * Reads resolve from the status API, the chain, or both. `auto` prefers the
 * chain, because the chain is the record of account, and falls back to the API
 * for the numbers the chain does not store. A read never invents a value: when
 * neither source has one, the result says so and carries the reason.
 *
 * Writes are split in two. `build*` returns an unsigned plan so an integrating
 * protocol can inspect it and sign with its own wallet; the same name without
 * the prefix signs and sends. Nothing signs implicitly.
 */

import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type SimulatedTransactionResponse,
} from "@solana/web3.js";

import { PoyzApiClient, type ApiStats, type FetchLike } from "./api.js";
import { PoyzChainClient } from "./chain.js";
import { explorerUrl, resolveConfig, type PoyzCluster, type PoyzClientConfig } from "./config.js";
import {
  PoyzAccountNotFoundError,
  PoyzApiError,
  PoyzChainError,
  PoyzConfigError,
  PoyzProgramError,
  describeProgramError,
  extractProgramErrorCode,
} from "./errors.js";
import {
  KEEPER_ATTESTATION_WARNING,
  PROOF_RECOMPUTED_WARNING,
  PoyzTransactionPlan,
  TWO_STEP_WARNING,
  buildBufferDepositInstruction,
  buildClaimFundingInstruction,
  buildCommitRebalanceProofInstruction,
  buildKeeperBondInstruction,
  buildKeeperRegisterInstruction,
  buildKeeperUnbondInstruction,
  buildMintCancelInstruction,
  buildMintConfirmInstruction,
  buildMintRequestInstruction,
  buildRedeemCancelInstruction,
  buildRedeemConfirmInstruction,
  buildRedeemRequestInstruction,
  buildReportVenueStateInstruction,
  buildRequestUnstakeInstruction,
  buildStakeInstruction,
  buildUnstakeInstruction,
  refuseUnsupported,
  type BufferDepositParams,
  type BuiltInstruction,
  type ClaimFundingParams,
  type CommitRebalanceProofParams,
  type KeeperBondParams,
  type KeeperRegisterParams,
  type KeeperUnbondParams,
  type MintCancelParams,
  type MintConfirmParams,
  type MintRequestParams,
  type PoyzChainContext,
  type RedeemCancelParams,
  type RedeemConfirmParams,
  type RedeemRequestParams,
  type ReportVenueStateParams,
  type RequestUnstakeParams,
  type StakeParams,
  type UnstakeParams,
} from "./instructions.js";
import { deriveConfigAddress } from "./pda.js";
import { signWith, type PoyzSigner } from "./signer.js";
import type {
  CollateralStatusView,
  DeltaStatusView,
  FundingStatusView,
  KeeperView,
  MintRequestView,
  ProtocolConfigView,
  ProtocolStatsView,
  ReadOptions,
  RebalanceRecordView,
  RedeemRequestView,
  SourcedValue,
  StakePositionView,
  VenueExposureView,
} from "./types.js";

export interface SimulationResult {
  readonly ok: boolean;
  readonly unitsConsumed: number | null;
  readonly logs: readonly string[];
  /** IDL name of the program error, when the failure was one. */
  readonly errorName: string | null;
  readonly errorMessage: string | null;
}

export interface SendResult {
  readonly signature: string;
  readonly cluster: PoyzCluster;
  readonly explorerUrl: string;
}

export interface PoyzClientOptions extends Partial<PoyzClientConfig> {
  /** Injected `fetch`, for tests and runtimes without a global one. */
  readonly fetchImpl?: FetchLike;
  /** Pre-built RPC connection, for callers that already pool one. */
  readonly connection?: Connection;
  /**
   * Addresses that would otherwise be read from the protocol config.
   *
   * Supply these to build plans without an RPC round trip, for example in a dry
   * run against a cluster where the protocol is not deployed. Anything omitted
   * is read from the config on first use.
   */
  readonly context?: Partial<Omit<PoyzChainContext, "programId" | "config">>;
}

function unavailable<T>(source: "api" | "chain", detail: string): SourcedValue<T> {
  return { source, available: false, observedAtMs: null, detail, data: null };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PoyzClient {
  readonly config: PoyzClientConfig;
  readonly api: PoyzApiClient;
  readonly chain: PoyzChainClient;

  private readonly contextOverride: Partial<Omit<PoyzChainContext, "programId" | "config">>;
  private cachedConfig: ProtocolConfigView | null = null;

  private constructor(config: PoyzClientConfig, options: PoyzClientOptions) {
    this.config = config;
    this.api = new PoyzApiClient(config, options.fetchImpl);
    this.chain = new PoyzChainClient(config, options.connection);
    this.contextOverride = options.context ?? {};
  }

  /**
   * Build a client from a partial config, filling the rest from the defaults.
   *
   * @throws PoyzConfigError on an invalid field, including an RPC URL that
   *   carries an API key.
   */
  static create(options: PoyzClientOptions = {}): PoyzClient {
    return new PoyzClient(resolveConfig(options), options);
  }

  // ---------------------------------------------------------------- chain ctx

  /**
   * Protocol config, cached after the first read.
   *
   * @throws PoyzAccountNotFoundError when the protocol is not initialised on
   *   this cluster.
   */
  async getConfig(options: { refresh?: boolean } = {}): Promise<ProtocolConfigView> {
    if (this.cachedConfig === null || options.refresh === true) {
      this.cachedConfig = await this.chain.getConfig();
    }
    return this.cachedConfig;
  }

  /**
   * The addresses every instruction needs.
   *
   * Resolved from the overrides passed to {@link PoyzClient.create} when they
   * are complete, and read from the protocol config otherwise.
   */
  async getChainContext(): Promise<PoyzChainContext> {
    const override = this.contextOverride;
    const complete =
      override.collateralMint !== undefined &&
      override.syntheticMint !== undefined &&
      override.bondMint !== undefined &&
      override.oracle !== undefined &&
      override.tokenProgram !== undefined;

    if (complete) {
      return {
        programId: this.config.programId,
        config: deriveConfigAddress(this.config.programId),
        collateralMint: override.collateralMint as string,
        syntheticMint: override.syntheticMint as string,
        bondMint: override.bondMint as string,
        oracle: override.oracle as string,
        tokenProgram: override.tokenProgram as string,
      };
    }

    const config = await this.getConfig();
    return {
      programId: this.config.programId,
      config: config.address,
      collateralMint: override.collateralMint ?? config.collateralMint,
      syntheticMint: override.syntheticMint ?? config.syntheticMint,
      bondMint: override.bondMint ?? config.bondMint,
      oracle: override.oracle ?? config.oracle,
      tokenProgram: override.tokenProgram ?? config.tokenProgram,
    };
  }

  // ------------------------------------------------------------------ reads

  /** Net delta of the hedged book. */
  async getDelta(options: ReadOptions = {}): Promise<SourcedValue<DeltaStatusView>> {
    const source = options.source ?? "auto";
    if (source === "api") {
      return this.readApi("delta", (signal) => this.api.getDelta(signal));
    }
    const fromChain = await this.readChain<DeltaStatusView>(() => this.chain.getDelta());
    if (source === "chain" || fromChain.available) {
      return fromChain;
    }
    const fromApi = await this.readApi("delta", (signal) => this.api.getDelta(signal), options.signal);
    return fromApi.available ? fromApi : fromChain;
  }

  /** Collateral backing the synthetic dollar. */
  async getCollateral(options: ReadOptions = {}): Promise<SourcedValue<CollateralStatusView>> {
    const source = options.source ?? "auto";
    if (source === "api") {
      return this.readApi("collateral", (signal) => this.api.getCollateral(signal), options.signal);
    }
    const fromChain = await this.readChain<CollateralStatusView>(() => this.chain.getCollateral());
    if (source === "chain" || fromChain.available) {
      return fromChain;
    }
    return this.readApi("collateral", (signal) => this.api.getCollateral(signal), options.signal);
  }

  /**
   * Net carry across the hedge venues.
   *
   * Carry, not yield: it is signed, and the two venue kinds do not contribute
   * the same way. A funding venue can pay the short or charge it; an LP-pool
   * venue charges a borrow fee the holder always pays. The result keeps the
   * legs separate and reports the net as the representative figure.
   *
   * Only the status API has a series. The config records the last settled net
   * carry, which is a single sample rather than a series, so a chain-only read
   * reports that rather than annualising one reading.
   */
  async getFunding(options: ReadOptions = {}): Promise<SourcedValue<FundingStatusView>> {
    if (options.source === "chain") {
      return unavailable(
        "chain",
        "Funding is paid on the hedge venue. The program records the last settled rate but no series, " +
          "so there is no on-chain carry series to read. The config carries the last settled net carry " +
          "as a single sample; use the status API for the series.",
      );
    }
    return this.readApi("funding", (signal) => this.api.getFunding(signal), options.signal);
  }

  /**
   * Hedge venues, with their market and funding data.
   *
   * Served by the status API, which publishes venue data before the protocol
   * holds any position on them. An entry with a null notional means exactly
   * that; it is not a zero-size hedge.
   */
  async getHedgeVenues(options: ReadOptions = {}): Promise<SourcedValue<readonly VenueExposureView[]>> {
    if (options.source === "chain") {
      return unavailable(
        "chain",
        "Per-venue exposure is not stored on chain. The rebalance proof records which venue executed " +
          "each rebalance, but not a breakdown. Use the status API.",
      );
    }
    return this.readApi("hedge venues", (signal) => this.api.getVenues(signal), options.signal);
  }

  /**
   * Committed rebalances, newest first.
   *
   * Read from the on-chain proof chain, which is the only place the history
   * exists in a tamper-evident form.
   */
  async getRebalances(
    options: ReadOptions & { limit?: number } = {},
  ): Promise<SourcedValue<readonly RebalanceRecordView[]>> {
    try {
      const { config, records } = await this.chain.getRebalances(options.limit ?? 10);
      this.cachedConfig = config;
      if (records.length === 0) {
        return unavailable(
          "chain",
          config.rebalanceCount === 0
            ? "No rebalance has been committed yet."
            : "The config reports rebalances but none of their proof accounts could be read.",
        );
      }
      return {
        source: "chain",
        available: true,
        observedAtMs: records[0]?.timestampMs ?? null,
        detail: null,
        data: records,
      };
    } catch (error) {
      return this.chainFailure(error);
    }
  }

  /**
   * Everything the header needs, in one call.
   *
   * Partial results are normal: `notes` explains each gap, so a consumer can say
   * why an indicator is missing instead of rendering a zero.
   */
  async getStats(options: ReadOptions = {}): Promise<SourcedValue<ProtocolStatsView>> {
    const notes: string[] = [];
    let stats: ApiStats | null = null;
    let delta: DeltaStatusView | null = null;
    let funding: FundingStatusView | null = null;
    let collateral: CollateralStatusView | null = null;

    if (options.source !== "chain") {
      try {
        stats = await this.api.getStats(options.signal);
      } catch (error) {
        if (error instanceof PoyzApiError) {
          notes.push(`Status API unavailable: ${describeError(error)}`);
        } else {
          throw error;
        }
      }
      if (stats !== null) {
        for (const [label, indicator] of [
          ["Delta", stats.delta],
          ["Collateral", stats.collateralUsd],
          ["Funding", stats.fundingApy],
          ["Rebalances", stats.rebalanceCount],
        ] as const) {
          if (!indicator.available && indicator.detail !== null) {
            notes.push(`${label}: ${indicator.detail}`);
          }
        }
        const [apiDelta, apiFunding, apiCollateral] = await Promise.all([
          this.readApi("delta", (signal) => this.api.getDelta(signal), options.signal),
          this.readApi("funding", (signal) => this.api.getFunding(signal), options.signal),
          this.readApi("collateral", (signal) => this.api.getCollateral(signal), options.signal),
        ]);
        delta = apiDelta.data;
        funding = apiFunding.data;
        collateral = apiCollateral.data;
      }
    }

    let config: ProtocolConfigView | null = null;
    if (options.source !== "api") {
      try {
        config = await this.getConfig({ refresh: true });
        if (delta === null) {
          const chainDelta = await this.chain.getDelta(config);
          delta = chainDelta.data;
          if (!chainDelta.available && chainDelta.detail !== null) {
            notes.push(`Chain delta: ${chainDelta.detail}`);
          }
        }
        if (!config.vaultsReady) {
          notes.push(
            "Protocol vaults are not fully initialised yet, so issuance, redemption and staking are " +
              "rejected on chain.",
          );
        }
        if (config.mintPaused && config.redeemPaused) {
          notes.push("Protocol is paused: both issuance and redemption are halted.");
        } else if (config.mintPaused) {
          notes.push("Issuance is paused; redemption is open.");
        } else if (config.redeemPaused) {
          notes.push("Redemption is paused; issuance is open.");
        }
      } catch (error) {
        if (error instanceof PoyzChainError) {
          notes.push(`Chain state not read: ${describeError(error)}`);
        } else {
          throw error;
        }
      }
    }

    const observedAtMs =
      delta?.capturedAtMs ?? funding?.capturedAtMs ?? collateral?.capturedAtMs ?? stats?.generatedAtMs ?? null;

    const data: ProtocolStatsView = {
      cluster: this.config.cluster,
      programId: this.config.programId,
      anchorVersion: stats?.chain.anchorVersion ?? null,
      delta,
      funding,
      collateral,
      config,
      notes,
    };

    const anything = delta !== null || funding !== null || collateral !== null || config !== null;

    return {
      source: config !== null ? "chain" : "api",
      available: anything,
      observedAtMs,
      detail: anything ? null : notes.join(" "),
      data: anything ? data : null,
    };
  }

  /** Decoded keeper account. @throws PoyzAccountNotFoundError when unregistered. */
  getKeeper(keeper: string): Promise<KeeperView> {
    return this.chain.getKeeper(keeper);
  }

  /** Decoded stake position. @throws PoyzAccountNotFoundError when there is none. */
  getStakePosition(owner: string): Promise<StakePositionView> {
    return this.chain.getStakePosition(owner);
  }

  /** Decoded mint request. @throws PoyzAccountNotFoundError when there is none. */
  getMintRequest(user: string, nonce: bigint): Promise<MintRequestView> {
    return this.chain.getMintRequest(user, nonce);
  }

  /** Decoded redeem request. @throws PoyzAccountNotFoundError when there is none. */
  getRedeemRequest(user: string, nonce: bigint): Promise<RedeemRequestView> {
    return this.chain.getRedeemRequest(user, nonce);
  }

  private async readApi<T>(
    metric: string,
    read: (signal?: AbortSignal) => Promise<SourcedValue<T>>,
    signal?: AbortSignal,
  ): Promise<SourcedValue<T>> {
    try {
      return await read(signal);
    } catch (error) {
      if (error instanceof PoyzApiError) {
        return unavailable("api", `${metric} could not be read from the status API: ${describeError(error)}`);
      }
      throw error;
    }
  }

  private async readChain<T>(read: () => Promise<SourcedValue<T>>): Promise<SourcedValue<T>> {
    try {
      return await read();
    } catch (error) {
      return this.chainFailure<T>(error);
    }
  }

  private chainFailure<T>(error: unknown): SourcedValue<T> {
    if (error instanceof PoyzAccountNotFoundError) {
      return unavailable(
        "chain",
        `The POYZ protocol is not initialised on ${this.config.cluster} at program ` +
          `${this.config.programId} (missing account ${error.address}).`,
      );
    }
    if (error instanceof PoyzChainError) {
      return unavailable("chain", describeError(error));
    }
    throw error;
  }

  // ----------------------------------------------------------- write: build

  private async plan(
    description: string,
    feePayer: string,
    warnings: readonly string[],
    build: (ctx: PoyzChainContext) => BuiltInstruction,
  ): Promise<PoyzTransactionPlan> {
    const ctx = await this.getChainContext();
    return new PoyzTransactionPlan({ description, feePayer, warnings, entries: [build(ctx)] });
  }

  /** Build an unsigned `mint_request`. This escrows collateral; it does not mint. */
  buildMintRequest(params: MintRequestParams): Promise<PoyzTransactionPlan> {
    return this.plan(
      `Escrow ${params.collateralAmount} collateral base units and open mint request ${params.nonce}`,
      params.user,
      [TWO_STEP_WARNING],
      (ctx) => buildMintRequestInstruction(ctx, params),
    );
  }

  /** Build an unsigned `mint_cancel`. */
  buildMintCancel(params: MintCancelParams): Promise<PoyzTransactionPlan> {
    return this.plan(
      `Cancel mint request ${params.nonce} and reclaim the escrowed collateral`,
      params.user,
      ["The program rejects this before the request deadline has passed."],
      (ctx) => buildMintCancelInstruction(ctx, params),
    );
  }

  /** Build an unsigned `mint_confirm`. Keeper-only. */
  buildMintConfirm(params: MintConfirmParams): Promise<PoyzTransactionPlan> {
    return this.plan(
      `Confirm mint request ${params.nonce} for ${params.user} against a filled hedge`,
      params.keeper,
      [KEEPER_ATTESTATION_WARNING],
      (ctx) => buildMintConfirmInstruction(ctx, params),
    );
  }

  /** Build an unsigned `redeem_request`. This escrows the synthetic; it does not settle. */
  buildRedeemRequest(params: RedeemRequestParams): Promise<PoyzTransactionPlan> {
    return this.plan(
      `Escrow ${params.syntheticAmount} synthetic base units and open redeem request ${params.nonce}`,
      params.user,
      [TWO_STEP_WARNING],
      (ctx) => buildRedeemRequestInstruction(ctx, params),
    );
  }

  /** Build an unsigned `redeem_cancel`. */
  buildRedeemCancel(params: RedeemCancelParams): Promise<PoyzTransactionPlan> {
    return this.plan(
      `Cancel redeem request ${params.nonce} and reclaim the escrowed synthetic dollars`,
      params.user,
      ["The program rejects this before the request deadline has passed."],
      (ctx) => buildRedeemCancelInstruction(ctx, params),
    );
  }

  /** Build an unsigned `redeem_confirm`. Keeper-only. */
  buildRedeemConfirm(params: RedeemConfirmParams): Promise<PoyzTransactionPlan> {
    return this.plan(
      `Confirm redeem request ${params.nonce} for ${params.user} against an unwound hedge`,
      params.keeper,
      [KEEPER_ATTESTATION_WARNING],
      (ctx) => buildRedeemConfirmInstruction(ctx, params),
    );
  }

  /** Build an unsigned `stake_synthetic`. */
  buildStake(params: StakeParams): Promise<PoyzTransactionPlan> {
    return this.plan(
      `Stake ${params.amount} synthetic base units`,
      params.owner,
      [
        "Staking takes the funding exposure. Funding is a market rate: in a negative regime the reward " +
          "index moves down and staked balances carry that.",
      ],
      (ctx) => buildStakeInstruction(ctx, params),
    );
  }

  /** Build an unsigned `request_unstake`, which starts the cooldown. */
  buildRequestUnstake(params: RequestUnstakeParams): Promise<PoyzTransactionPlan> {
    return this.plan(
      `Start the unstake cooldown on ${params.amount} synthetic base units`,
      params.owner,
      [
        "Nothing is withdrawn here. The amount moves into a pending balance and the unstake cooldown " +
          "starts; call unstake once it ends. The delay is what lets the keeper unwind hedge against " +
          "staker outflow.",
      ],
      (ctx) => buildRequestUnstakeInstruction(ctx, params),
    );
  }

  /** Build an unsigned `unstake`, which withdraws the pending amount. */
  buildUnstake(params: UnstakeParams): Promise<PoyzTransactionPlan> {
    return this.plan(
      "Withdraw the pending unstake",
      params.owner,
      [
        "The program rejects this while the unstake cooldown is still running, and when nothing is " +
          "pending. Start one with requestUnstake first.",
      ],
      (ctx) => buildUnstakeInstruction(ctx, params),
    );
  }

  /** Build an unsigned `claim_funding`. */
  buildClaimFunding(params: ClaimFundingParams): Promise<PoyzTransactionPlan> {
    return this.plan(
      "Claim funding accrued to this stake position",
      params.owner,
      [],
      (ctx) => buildClaimFundingInstruction(ctx, params),
    );
  }

  /** Build an unsigned `keeper_register`. */
  buildKeeperRegister(params: KeeperRegisterParams): Promise<PoyzTransactionPlan> {
    return this.plan(
      `Register as a Delta Keeper with a bond of ${params.bondAmount} base units`,
      params.keeper,
      [
        "The bond moves into a program-owned vault and is at risk: the protocol authority can slash it " +
          "into the insurance buffer for a faulty or missing proof.",
        "Withdrawal is not immediate. The unbond cooldown since the last committed proof must elapse, " +
          "and a partial withdrawal that would leave the bond below the protocol minimum is rejected.",
      ],
      (ctx) => buildKeeperRegisterInstruction(ctx, params),
    );
  }

  /** Build an unsigned `keeper_bond`. */
  buildKeeperBond(params: KeeperBondParams): Promise<PoyzTransactionPlan> {
    return this.plan(
      `Add ${params.amount} base units to the keeper bond`,
      params.keeper,
      ["Bond added here is subject to the same slashing and cooldown rules as the opening bond."],
      (ctx) => buildKeeperBondInstruction(ctx, params),
    );
  }

  /** Build an unsigned `keeper_unbond`. */
  buildKeeperUnbond(params: KeeperUnbondParams): Promise<PoyzTransactionPlan> {
    return this.plan(
      `Withdraw ${params.amount} base units of keeper bond`,
      params.keeper,
      [
        "Rejected while the unbond cooldown since your last committed proof is still running, and " +
          "rejected if it would drop the bond below the protocol minimum without a full exit.",
      ],
      (ctx) => buildKeeperUnbondInstruction(ctx, params),
    );
  }

  /** Build an unsigned `commit_rebalance_proof`. Keeper-only. */
  buildCommitRebalanceProof(params: CommitRebalanceProofParams): Promise<PoyzTransactionPlan> {
    return this.plan(
      `Commit rebalance proof ${params.sequence} on venue ${params.venueId}`,
      params.keeper,
      [
        KEEPER_ATTESTATION_WARNING,
        PROOF_RECOMPUTED_WARNING,
        "The program rejects the proof unless the sequence matches the protocol counter, the slot is " +
          "strictly newer than the last proof, the oracle is fresh, and deltaBpsAfter is inside the band.",
      ],
      (ctx) => buildCommitRebalanceProofInstruction(ctx, params),
    );
  }

  /**
   * Build an unsigned `report_venue_state`.
   *
   * Authority-signed. The protocol is fail-closed on this reading, so it is an
   * operational feed rather than a one-off setting.
   */
  buildReportVenueState(params: ReportVenueStateParams): Promise<PoyzTransactionPlan> {
    return this.plan(
      `Report venue ${params.venueId} at ${params.netCarryBps} bps net carry`,
      params.authority,
      [
        "Issuance is rejected while this reading is missing or older than max_venue_state_age_sec, " +
          "and while supply would exceed the reported capacity. Stopping this feed stops minting.",
        "Report what the venue actually offers. Overstating capacity lets the protocol issue more " +
          "than the hedge can absorb, which is the failure the cap exists to prevent.",
      ],
      (ctx) => buildReportVenueStateInstruction(ctx, params),
    );
  }

  /** Build, sign and send a venue state report. */
  async reportVenueState(params: ReportVenueStateParams & { signer: PoyzSigner }): Promise<SendResult> {
    return this.sendTransaction(await this.buildReportVenueState(params), params.signer);
  }

  /** Build an unsigned `buffer_deposit`. */
  buildBufferDeposit(params: BufferDepositParams): Promise<PoyzTransactionPlan> {
    return this.plan(
      `Deposit ${params.amount} synthetic base units into the insurance buffer`,
      params.depositor,
      [
        "This is first-loss capital. Withdrawal is authority-gated and only unlocks in a sustained " +
          "negative funding regime, so treat it as a one-way contribution.",
      ],
      (ctx) => buildBufferDepositInstruction(ctx, params),
    );
  }

  /** @throws PoyzUnsupportedError always: this SDK does not wrap admin setup. */
  async buildInitialize(_params?: unknown): Promise<never> {
    return refuseUnsupported("initialize");
  }

  /** @throws PoyzUnsupportedError always: this SDK does not wrap slashing. */
  async buildKeeperSlash(_params?: unknown): Promise<never> {
    return refuseUnsupported("keeperSlash");
  }

  /** @throws PoyzUnsupportedError always: this SDK does not wrap funding settlement. */
  async buildSettleFunding(_params?: unknown): Promise<never> {
    return refuseUnsupported("settleFunding");
  }

  // ------------------------------------------------------------ write: send

  /** Build, sign and send a mint request. */
  async mintRequest(params: MintRequestParams & { signer: PoyzSigner }): Promise<SendResult> {
    return this.sendTransaction(await this.buildMintRequest(params), params.signer);
  }

  /** Build, sign and send a mint cancellation. */
  async mintCancel(params: MintCancelParams & { signer: PoyzSigner }): Promise<SendResult> {
    return this.sendTransaction(await this.buildMintCancel(params), params.signer);
  }

  /** Build, sign and send a mint confirmation. Keeper-only. */
  async mintConfirm(params: MintConfirmParams & { signer: PoyzSigner }): Promise<SendResult> {
    return this.sendTransaction(await this.buildMintConfirm(params), params.signer);
  }

  /** Build, sign and send a redeem request. */
  async redeemRequest(params: RedeemRequestParams & { signer: PoyzSigner }): Promise<SendResult> {
    return this.sendTransaction(await this.buildRedeemRequest(params), params.signer);
  }

  /** Build, sign and send a redeem cancellation. */
  async redeemCancel(params: RedeemCancelParams & { signer: PoyzSigner }): Promise<SendResult> {
    return this.sendTransaction(await this.buildRedeemCancel(params), params.signer);
  }

  /** Build, sign and send a redeem confirmation. Keeper-only. */
  async redeemConfirm(params: RedeemConfirmParams & { signer: PoyzSigner }): Promise<SendResult> {
    return this.sendTransaction(await this.buildRedeemConfirm(params), params.signer);
  }

  /** Build, sign and send a stake. */
  async stake(params: StakeParams & { signer: PoyzSigner }): Promise<SendResult> {
    return this.sendTransaction(await this.buildStake(params), params.signer);
  }

  /** Build, sign and send an unstake request, starting the cooldown. */
  async requestUnstake(params: RequestUnstakeParams & { signer: PoyzSigner }): Promise<SendResult> {
    return this.sendTransaction(await this.buildRequestUnstake(params), params.signer);
  }

  /** Build, sign and send the withdrawal of a matured unstake. */
  async unstake(params: UnstakeParams & { signer: PoyzSigner }): Promise<SendResult> {
    return this.sendTransaction(await this.buildUnstake(params), params.signer);
  }

  /** Build, sign and send a funding claim. */
  async claimFunding(params: ClaimFundingParams & { signer: PoyzSigner }): Promise<SendResult> {
    return this.sendTransaction(await this.buildClaimFunding(params), params.signer);
  }

  /** Build, sign and send a keeper registration. */
  async keeperRegister(params: KeeperRegisterParams & { signer: PoyzSigner }): Promise<SendResult> {
    return this.sendTransaction(await this.buildKeeperRegister(params), params.signer);
  }

  /** Build, sign and send a bond top-up. */
  async keeperBond(params: KeeperBondParams & { signer: PoyzSigner }): Promise<SendResult> {
    return this.sendTransaction(await this.buildKeeperBond(params), params.signer);
  }

  /** Build, sign and send a bond withdrawal. */
  async keeperUnbond(params: KeeperUnbondParams & { signer: PoyzSigner }): Promise<SendResult> {
    return this.sendTransaction(await this.buildKeeperUnbond(params), params.signer);
  }

  /** Build, sign and send a rebalance proof. Keeper-only. */
  async commitRebalanceProof(
    params: CommitRebalanceProofParams & { signer: PoyzSigner },
  ): Promise<SendResult> {
    return this.sendTransaction(await this.buildCommitRebalanceProof(params), params.signer);
  }

  /** Build, sign and send an insurance buffer deposit. */
  async bufferDeposit(params: BufferDepositParams & { signer: PoyzSigner }): Promise<SendResult> {
    return this.sendTransaction(await this.buildBufferDeposit(params), params.signer);
  }

  // ------------------------------------------------------- transaction glue

  private async compile(plan: PoyzTransactionPlan): Promise<VersionedTransaction> {
    let blockhash: string;
    try {
      ({ blockhash } = await this.chain.connection.getLatestBlockhash(this.config.commitment));
    } catch (cause) {
      throw new PoyzChainError(`could not fetch a recent blockhash: ${describeError(cause)}`, { cause });
    }
    const message = new TransactionMessage({
      payerKey: new PublicKey(plan.feePayer),
      recentBlockhash: blockhash,
      instructions: [...plan.ixs],
    }).compileToV0Message();
    return new VersionedTransaction(message);
  }

  /**
   * Simulate a plan against the cluster without signing it.
   *
   * This is the dry run: it reports what the program would do, including which
   * of its own errors it would return, without moving anything.
   */
  async simulate(plan: PoyzTransactionPlan): Promise<SimulationResult> {
    const transaction = await this.compile(plan);
    let response: SimulatedTransactionResponse;
    try {
      const result = await this.chain.connection.simulateTransaction(transaction, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: this.config.commitment,
      });
      response = result.value;
    } catch (cause) {
      throw new PoyzChainError(`simulation call failed: ${describeError(cause)}`, { cause });
    }

    const logs = response.logs ?? [];
    if (response.err === null || response.err === undefined) {
      return {
        ok: true,
        unitsConsumed: response.unitsConsumed ?? null,
        logs,
        errorName: null,
        errorMessage: null,
      };
    }

    const code = extractProgramErrorCode(response.err) ?? extractProgramErrorCode(logs.join("\n"));
    const described = code === null ? null : describeProgramError(code);
    return {
      ok: false,
      unitsConsumed: response.unitsConsumed ?? null,
      logs,
      errorName: described?.name ?? null,
      errorMessage:
        described !== null
          ? `${described.name} (${described.code}): ${described.msg}`
          : `transaction would fail: ${JSON.stringify(response.err)}`,
    };
  }

  /**
   * Sign a plan and send it.
   *
   * Preflight is on by default, so a transaction the program would reject fails
   * before it costs a fee.
   *
   * @throws PoyzConfigError when the signer is not the plan's fee payer.
   * @throws PoyzProgramError when the program rejected it with a known code.
   * @throws PoyzChainError on any other send failure.
   */
  async sendTransaction(
    plan: PoyzTransactionPlan,
    signer: PoyzSigner,
    options: { skipPreflight?: boolean } = {},
  ): Promise<SendResult> {
    if (signer.publicKey !== plan.feePayer) {
      throw new PoyzConfigError(
        `signer ${signer.publicKey} does not match the plan fee payer ${plan.feePayer}`,
      );
    }
    const transaction = await this.compile(plan);
    const signed = await signWith(signer, transaction);

    let signature: string;
    try {
      signature = await this.chain.connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: options.skipPreflight ?? false,
        preflightCommitment: this.config.commitment,
      });
    } catch (cause) {
      const code = extractProgramErrorCode(cause instanceof Error ? cause.message : cause);
      const described = code === null ? null : describeProgramError(code);
      if (described !== null) {
        throw new PoyzProgramError(
          described.code,
          described.name,
          `the program rejected the transaction: ${described.name} (${described.code}): ${described.msg}`,
        );
      }
      throw new PoyzChainError(`sending the transaction failed: ${describeError(cause)}`, { cause });
    }

    return {
      signature,
      cluster: this.config.cluster,
      explorerUrl: explorerUrl(signature, this.config.cluster),
    };
  }
}
