/**
 * The slice of the SDK client this CLI uses.
 *
 * Declared structurally rather than imported as a class so the commands can be
 * driven by a stub in the tests. `PoyzClient` satisfies it; nothing else in the
 * CLI depends on the concrete class.
 */

import type {
  ClaimFundingParams,
  CollateralStatusView,
  DeltaStatusView,
  FundingStatusView,
  KeeperBondParams,
  KeeperRegisterParams,
  KeeperUnbondParams,
  KeeperView,
  MintCancelParams,
  MintRequestParams,
  MintRequestView,
  PoyzClientConfig,
  PoyzSigner,
  PoyzTransactionPlan,
  ProtocolConfigView,
  ProtocolStatsView,
  ReadOptions,
  RedeemCancelParams,
  RedeemRequestParams,
  RequestUnstakeParams,
  RedeemRequestView,
  SendResult,
  SimulationResult,
  SourcedValue,
  StakeParams,
  StakePositionView,
  UnstakeParams,
} from "@poyz/sdk";

type Signed<T> = T & { signer: PoyzSigner };

export interface PoyzClientLike {
  readonly config: PoyzClientConfig;

  // reads
  getDelta(options?: ReadOptions): Promise<SourcedValue<DeltaStatusView>>;
  getCollateral(options?: ReadOptions): Promise<SourcedValue<CollateralStatusView>>;
  getFunding(options?: ReadOptions): Promise<SourcedValue<FundingStatusView>>;
  getStats(options?: ReadOptions): Promise<SourcedValue<ProtocolStatsView>>;
  getConfig(): Promise<ProtocolConfigView>;
  getKeeper(keeper: string): Promise<KeeperView>;
  getStakePosition(owner: string): Promise<StakePositionView>;
  getMintRequest(user: string, nonce: bigint): Promise<MintRequestView>;
  getRedeemRequest(user: string, nonce: bigint): Promise<RedeemRequestView>;

  // plans
  buildMintRequest(params: MintRequestParams): Promise<PoyzTransactionPlan>;
  buildMintCancel(params: MintCancelParams): Promise<PoyzTransactionPlan>;
  buildRedeemRequest(params: RedeemRequestParams): Promise<PoyzTransactionPlan>;
  buildRedeemCancel(params: RedeemCancelParams): Promise<PoyzTransactionPlan>;
  buildStake(params: StakeParams): Promise<PoyzTransactionPlan>;
  buildRequestUnstake(params: RequestUnstakeParams): Promise<PoyzTransactionPlan>;
  buildUnstake(params: UnstakeParams): Promise<PoyzTransactionPlan>;
  buildClaimFunding(params: ClaimFundingParams): Promise<PoyzTransactionPlan>;
  buildKeeperRegister(params: KeeperRegisterParams): Promise<PoyzTransactionPlan>;
  buildKeeperBond(params: KeeperBondParams): Promise<PoyzTransactionPlan>;
  buildKeeperUnbond(params: KeeperUnbondParams): Promise<PoyzTransactionPlan>;

  // sends
  mintRequest(params: Signed<MintRequestParams>): Promise<SendResult>;
  mintCancel(params: Signed<MintCancelParams>): Promise<SendResult>;
  redeemRequest(params: Signed<RedeemRequestParams>): Promise<SendResult>;
  redeemCancel(params: Signed<RedeemCancelParams>): Promise<SendResult>;
  stake(params: Signed<StakeParams>): Promise<SendResult>;
  requestUnstake(params: Signed<RequestUnstakeParams>): Promise<SendResult>;
  unstake(params: Signed<UnstakeParams>): Promise<SendResult>;
  claimFunding(params: Signed<ClaimFundingParams>): Promise<SendResult>;
  keeperRegister(params: Signed<KeeperRegisterParams>): Promise<SendResult>;
  keeperBond(params: Signed<KeeperBondParams>): Promise<SendResult>;
  keeperUnbond(params: Signed<KeeperUnbondParams>): Promise<SendResult>;

  simulate(plan: PoyzTransactionPlan): Promise<SimulationResult>;
}
