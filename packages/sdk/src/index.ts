/**
 * @poyz/sdk
 *
 * TypeScript SDK for POYZ, a delta-neutral synthetic dollar on Solana.
 *
 * POYZ takes SOL or LST collateral, holds an offsetting perpetual short of the
 * same notional, and issues a synthetic dollar against the pair. The offset is
 * what holds the dollar value; the funding paid to the short is the yield, and
 * that rate is a market rate that can and does go negative.
 *
 * Issuance and redemption are two-legged: a user posts a request, and a bonded
 * keeper settles it once the hedge is filled or unwound. This SDK models that
 * honestly -- `mintRequest` escrows collateral and opens a request, and nothing
 * in it calls that a completed mint.
 *
 * The package runs in a browser and in Node, ships ESM and CommonJS, and has a
 * single runtime dependency (`@solana/web3.js`). Reads work against the POYZ
 * status API, the chain, or both. Writes are built and handed back unsigned by
 * default, so an integrating protocol signs with its own wallet and this SDK
 * never holds a key.
 *
 * @example Read the current delta
 * ```ts
 * import { PoyzClient } from "@poyz/sdk";
 *
 * const poyz = PoyzClient.create();
 * const delta = await poyz.getDelta();
 * if (delta.available && delta.data !== null) {
 *   console.log(`${delta.data.deviationBps} bps off neutral`);
 * } else {
 *   console.log(`no delta reading: ${delta.detail}`);
 * }
 * ```
 */

export { SDK_VERSION } from "./version.js";

export {
  DEFAULT_API_BASE_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RPC_ENDPOINTS,
  POYZ_PROGRAM_ID,
  assertPublicRpcUrl,
  explorerUrl,
  resolveConfig,
  type PoyzClientConfig,
  type PoyzCluster,
  type PoyzCommitment,
} from "./config.js";

export {
  POYZ_IDL_ERRORS,
  PoyzAccountNotFoundError,
  PoyzApiError,
  PoyzChainError,
  PoyzConfigError,
  PoyzError,
  PoyzProgramError,
  PoyzUnavailableError,
  PoyzUnsupportedError,
  describeProgramError,
  extractProgramErrorCode,
} from "./errors.js";

export {
  VENUE_ALIASES,
  VENUE_FLAGS_DEFAULT,
  VENUE_FLAGS_MASK,
  VENUE_ID_BASE,
  VENUE_ID_MAX_ASSIGNABLE,
  VENUE_ID_UNSET,
  VENUE_RETIRED,
  VENUE_SLOTS,
} from "./generated/venues.js";

export {
  ACCOUNT_DISCRIMINATORS,
  EVENT_DISCRIMINATORS,
  IDL_METADATA,
  INSTRUCTION_DISCRIMINATORS,
  POYZ_IDL,
  type PoyzIdlError,
  type PoyzIdlMetadata,
  type PoyzIdlRaw,
} from "./generated/idl.js";

export {
  isPresent,
  requireAvailable,
  type CollateralAssetView,
  type CollateralStatusView,
  type DeltaStatusView,
  type FundingStatusView,
  type KeeperView,
  type MintRequestView,
  type ProtocolConfigView,
  type ProtocolStatsView,
  type ReadOptions,
  type ReadSource,
  type RebalanceRecordView,
  type RedeemRequestView,
  type SourcedValue,
  type StakePositionView,
  type VenueCarryModel,
  type VenueExposureView,
  type VenueFundingView,
} from "./types.js";

export {
  POYZ_API_ROUTES,
  PoyzApiClient,
  buildApiUrl,
  type ApiChainInfo,
  type ApiIndicator,
  type ApiStats,
  type FetchInit,
  type FetchLike,
  type FetchResponseLike,
  type PoyzApiRouteName,
} from "./api.js";

export { PoyzChainClient } from "./chain.js";

export {
  PoyzClient,
  type PoyzClientOptions,
  type SendResult,
  type SimulationResult,
} from "./client.js";

export {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  PDA_SEEDS,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  deriveAssociatedTokenAddress,
  deriveBondVault,
  deriveBondVaultAddress,
  deriveBufferBondVault,
  deriveBufferBondVaultAddress,
  deriveBufferVault,
  deriveBufferVaultAddress,
  deriveCollateralVault,
  deriveCollateralVaultAddress,
  deriveConfig,
  deriveConfigAddress,
  deriveFundingVault,
  deriveFundingVaultAddress,
  deriveKeeper,
  deriveKeeperAddress,
  deriveMintRequest,
  deriveMintRequestAddress,
  deriveRebalanceProof,
  deriveRebalanceProofAddress,
  deriveRedeemEscrow,
  deriveRedeemEscrowAddress,
  deriveRedeemRequest,
  deriveRedeemRequestAddress,
  deriveStakePosition,
  deriveStakePositionAddress,
  deriveStakeVault,
  deriveStakeVaultAddress,
  toPublicKey,
} from "./pda.js";

export {
  ACCOUNT_LAYOUTS,
  RETIRED_VENUES,
  VAULT_FLAGS,
  VAULT_FLAGS_ALL,
  VENUE_IDS,
  VENUE_NAMES,
  decodeConfig,
  decodeKeeper,
  decodeMintRequest,
  decodeRebalanceProof,
  decodeRedeemRequest,
  decodeStakePosition,
  enabledVenues,
  isVenueEnabled,
  oracleToDecimal,
  venueIdFromName,
  venueName,
} from "./accounts.js";

export {
  KEEPER_ATTESTATION_WARNING,
  POYZ_INSTRUCTION_SUPPORT,
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
  type PoyzInstructionSummary,
  type RedeemCancelParams,
  type RedeemConfirmParams,
  type RedeemRequestParams,
  type ReportVenueStateParams,
  type RequestUnstakeParams,
  type StakeParams,
  type UnstakeParams,
} from "./instructions.js";

export {
  computeProofHash,
  computeVenuesHash,
  encodeExecutionPayload,
  sha256,
  verifyProof,
  verifyProofChain,
  type ExecutionFill,
  type ExecutionPayload,
  type ProofChainLink,
  type ProofVerification,
} from "./proof.js";

export {
  keypairSigner,
  signWith,
  walletAdapterSigner,
  type PoyzMessageSigner,
  type PoyzSigner,
  type PoyzTransactionSigner,
  type WalletAdapterLike,
} from "./signer.js";

export {
  FUNDING_SIMULATION_DISCLAIMER,
  simulateFunding,
  type FundingBufferProjection,
  type FundingScenarioInput,
  type FundingSimulationInput,
  type FundingSimulationResult,
  type PoyzPlaybookStage,
} from "./simulate.js";

export {
  annualizeFundingRate,
  quoteMint,
  quoteRedeem,
  type CollateralAsset,
  type MintQuote,
  type MintQuoteInput,
  type RedeemQuote,
  type RedeemQuoteInput,
} from "./quotes.js";

export {
  LAMPORTS_PER_SOL,
  baseUnitsToDecimal,
  decimalToBaseUnits,
  formatBaseUnits,
  lamportsToSol,
  parseDecimalToBaseUnits,
  solToLamports,
} from "./units.js";

export { BorshReader, BorshWriter, fromHex, hasDiscriminator, toHex, u64Seed } from "./borsh.js";
