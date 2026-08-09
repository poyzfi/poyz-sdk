/**
 * Instruction builders.
 *
 * Account order, mutability, signer flags and argument encoding are transcribed
 * from the IDL. Discriminators come from the compiled IDL rather than being
 * re-derived, so an instruction this SDK builds is byte-identical to what the
 * program expects or it does not build at all.
 *
 * Issuance and redemption are two-legged on this program: the user posts a
 * request, and a bonded keeper confirms it once the hedge is filled, or the user
 * cancels it after the deadline. The builders mirror that; nothing here pretends
 * a request is a completed mint.
 *
 * Administrative instructions (`initialize`, `set_params`, `set_oracle`,
 * `set_paused`, `transfer_authority`, `accept_authority`, `init_*_vaults`,
 * `keeper_slash`, `settle_funding`, `buffer_withdraw`) are deliberately not
 * wrapped. They are authority-only, one-shot, and should be assembled
 * deliberately from `POYZ_IDL` rather than made convenient to script.
 */

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

import { BorshWriter, toHex } from "./borsh.js";
import { PoyzConfigError, PoyzUnsupportedError } from "./errors.js";
import { INSTRUCTION_DISCRIMINATORS } from "./generated/idl.js";
import {
  deriveAssociatedTokenAddress,
  deriveBondVault,
  deriveBufferVault,
  deriveCollateralVault,
  deriveFundingVault,
  deriveKeeper,
  deriveMintRequest,
  deriveRebalanceProof,
  deriveRedeemEscrow,
  deriveRedeemRequest,
  deriveStakePosition,
  deriveStakeVault,
  toPublicKey,
} from "./pda.js";

/** One instruction, rendered for a human to read before signing. */
export interface PoyzInstructionSummary {
  readonly name: string;
  readonly programId: string;
  readonly accounts: readonly {
    readonly pubkey: string;
    readonly isSigner: boolean;
    readonly isWritable: boolean;
    readonly name: string;
  }[];
  readonly dataHex: string;
}

/**
 * The addresses every instruction needs, resolved once.
 *
 * All of these live on the protocol `Config` account. A client reads it once and
 * caches it; a caller that wants to build a plan without an RPC round trip can
 * supply the context directly.
 */
export interface PoyzChainContext {
  readonly programId: string;
  readonly config: string;
  readonly collateralMint: string;
  readonly syntheticMint: string;
  readonly bondMint: string;
  readonly oracle: string;
  readonly tokenProgram: string;
}

/**
 * A built, unsigned transaction.
 *
 * The plan is what a caller inspects, logs or shows a user; `ixs` carries the
 * real instructions for signing and is deliberately non-enumerable, so that
 * `JSON.stringify(plan)` produces the readable summary and not a dump of
 * web3.js internals.
 */
export class PoyzTransactionPlan {
  readonly description: string;
  readonly feePayer: string;
  readonly instructions: readonly PoyzInstructionSummary[];
  readonly warnings: readonly string[];
  declare readonly ixs: readonly TransactionInstruction[];

  constructor(params: {
    description: string;
    feePayer: string;
    warnings: readonly string[];
    entries: readonly BuiltInstruction[];
  }) {
    this.description = params.description;
    this.feePayer = params.feePayer;
    this.warnings = params.warnings;
    this.instructions = params.entries.map((entry) => ({
      name: entry.name,
      programId: entry.ix.programId.toBase58(),
      accounts: entry.ix.keys.map((key, index) => ({
        pubkey: key.pubkey.toBase58(),
        isSigner: key.isSigner,
        isWritable: key.isWritable,
        name: entry.accountNames[index] ?? `account_${index}`,
      })),
      dataHex: toHex(Uint8Array.from(entry.ix.data)),
    }));
    Object.defineProperty(this, "ixs", {
      value: params.entries.map((entry) => entry.ix),
      enumerable: false,
      writable: false,
    });
  }

  toJSON(): {
    description: string;
    feePayer: string;
    instructions: readonly PoyzInstructionSummary[];
    warnings: readonly string[];
  } {
    return {
      description: this.description,
      feePayer: this.feePayer,
      instructions: this.instructions,
      warnings: this.warnings,
    };
  }
}

export interface BuiltInstruction {
  readonly name: string;
  readonly accountNames: readonly string[];
  readonly ix: TransactionInstruction;
}

/**
 * web3.js types instruction data as a Node `Buffer`.
 *
 * This package declares no Node types, and a browser only has `Buffer` when the
 * host application polyfills it. So the bytes are wrapped when a Buffer exists
 * and passed through as a `Uint8Array` when it does not, which is what every
 * downstream serialisation path in web3.js actually reads.
 */
type InstructionData = NonNullable<ConstructorParameters<typeof TransactionInstruction>[0]["data"]>;

function toInstructionData(bytes: Uint8Array): InstructionData {
  const bufferCtor = (globalThis as { Buffer?: { from(input: Uint8Array): unknown } }).Buffer;
  return (bufferCtor === undefined ? bytes : bufferCtor.from(bytes)) as InstructionData;
}

function discriminator(name: string): readonly number[] {
  const value = INSTRUCTION_DISCRIMINATORS[name];
  if (value === undefined) {
    throw new PoyzUnsupportedError(
      name,
      `the compiled IDL has no instruction called ${name}; the program does not expose it`,
    );
  }
  return value;
}

interface AccountSpec {
  readonly name: string;
  readonly pubkey: PublicKey | string;
  readonly isSigner?: boolean;
  readonly isWritable?: boolean;
}

function instruction(
  name: string,
  programId: string,
  accounts: readonly AccountSpec[],
  data: Uint8Array,
): BuiltInstruction {
  const keys = accounts.map((account) => ({
    pubkey:
      typeof account.pubkey === "string" ? toPublicKey(account.pubkey, account.name) : account.pubkey,
    isSigner: account.isSigner ?? false,
    isWritable: account.isWritable ?? false,
  }));
  return {
    name,
    accountNames: accounts.map((account) => account.name),
    ix: new TransactionInstruction({
      programId: toPublicKey(programId, "programId"),
      keys,
      data: toInstructionData(data),
    }),
  };
}

function assertPositive(value: bigint, label: string): void {
  if (value <= 0n) {
    throw new PoyzConfigError(`${label} must be greater than zero`);
  }
}

function assertNonNegative(value: bigint, label: string): void {
  if (value < 0n) {
    throw new PoyzConfigError(`${label} must not be negative`);
  }
}

function assertProofHash(hash: Uint8Array, label: string): void {
  if (hash.byteLength !== 32) {
    throw new PoyzConfigError(`${label} must be exactly 32 bytes`);
  }
  if (hash.every((byte) => byte === 0)) {
    throw new PoyzConfigError(`${label} must not be all zeroes; the program rejects an empty hash`);
  }
}

/**
 * Validate a venue slot before it is written into a proof.
 *
 * Slot 0 is refused here, not just on chain. It is the u8 zero value, so a field
 * that was never set looks exactly like a deliberate choice; letting it through
 * would attribute an execution to whichever venue sits at 0. The mapping is
 * 1-based precisely so that cannot happen, and this is the client-side half of
 * that guard.
 */
function assertVenueId(venueId: number): void {
  if (!Number.isInteger(venueId) || venueId < 0 || venueId > 255) {
    throw new PoyzConfigError("venueId must be an integer between 0 and 255");
  }
  if (venueId === 0) {
    throw new PoyzConfigError(
      "venueId 0 is the unset value and is rejected by the program. Venue slots are 1-based: " +
        "1 = velocity (the venue that traded as drift), 2 = jupiter-perps. Resolve a name with " +
        "venueIdFromName().",
    );
  }
}

function assertDeltaBps(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new PoyzConfigError(`${label} must be an integer number of basis points`);
  }
}

/** Token account for an owner, defaulting to their associated token account. */
function tokenAccount(
  explicit: string | undefined,
  owner: string,
  mint: string,
  tokenProgram: string,
): string {
  return explicit ?? deriveAssociatedTokenAddress(owner, mint, tokenProgram);
}

const SYSTEM_PROGRAM_ID = SystemProgram.programId.toBase58();

function configAccount(ctx: PoyzChainContext): AccountSpec {
  return { name: "config", pubkey: ctx.config, isWritable: true };
}

// --------------------------------------------------------------------- issuance

export interface MintRequestParams {
  /** Depositor and fee payer, base58. */
  readonly user: string;
  /** Caller-chosen request id. It is part of the request PDA seed. */
  readonly nonce: bigint;
  /** Collateral to deposit, in collateral base units. */
  readonly collateralAmount: bigint;
  /** Slippage floor on the synthetic dollars issued, in synthetic base units. */
  readonly minSyntheticOut: bigint;
  /** Source token account. Defaults to the user's associated token account. */
  readonly userCollateral?: string;
}

/**
 * Build `mint_request`: escrow collateral and quote the issuance.
 *
 * This does not mint anything. It moves collateral into the protocol vault and
 * records a quote; a bonded keeper mints against it with `mint_confirm` once the
 * hedge is filled, or the user reclaims the collateral with `mint_cancel` after
 * the deadline.
 *
 * @throws PoyzConfigError on a non-positive amount or a malformed address.
 */
export function buildMintRequestInstruction(
  ctx: PoyzChainContext,
  params: MintRequestParams,
): BuiltInstruction {
  assertPositive(params.collateralAmount, "collateralAmount");
  assertNonNegative(params.minSyntheticOut, "minSyntheticOut");

  const [request] = deriveMintRequest(params.user, params.nonce, ctx.programId);
  const [collateralVault] = deriveCollateralVault(ctx.collateralMint, ctx.programId);

  const data = new BorshWriter()
    .bytes(discriminator("mint_request"))
    .u64(params.nonce)
    .u64(params.collateralAmount)
    .u64(params.minSyntheticOut)
    .toUint8Array();

  return instruction(
    "mint_request",
    ctx.programId,
    [
      { name: "user", pubkey: params.user, isSigner: true, isWritable: true },
      configAccount(ctx),
      { name: "request", pubkey: request, isWritable: true },
      { name: "collateral_mint", pubkey: ctx.collateralMint },
      {
        name: "user_collateral",
        pubkey: tokenAccount(params.userCollateral, params.user, ctx.collateralMint, ctx.tokenProgram),
        isWritable: true,
      },
      { name: "collateral_vault", pubkey: collateralVault, isWritable: true },
      { name: "oracle", pubkey: ctx.oracle },
      { name: "token_program", pubkey: ctx.tokenProgram },
      { name: "system_program", pubkey: SYSTEM_PROGRAM_ID },
    ],
    data,
  );
}

export interface MintCancelParams {
  readonly user: string;
  readonly nonce: bigint;
  readonly userCollateral?: string;
}

/**
 * Build `mint_cancel`: return escrowed collateral for an expired request.
 *
 * @throws PoyzConfigError on a malformed address.
 */
export function buildMintCancelInstruction(
  ctx: PoyzChainContext,
  params: MintCancelParams,
): BuiltInstruction {
  const [request] = deriveMintRequest(params.user, params.nonce, ctx.programId);
  const [collateralVault] = deriveCollateralVault(ctx.collateralMint, ctx.programId);

  const data = new BorshWriter().bytes(discriminator("mint_cancel")).u64(params.nonce).toUint8Array();

  return instruction(
    "mint_cancel",
    ctx.programId,
    [
      { name: "user", pubkey: params.user, isSigner: true, isWritable: true },
      configAccount(ctx),
      { name: "request", pubkey: request, isWritable: true },
      { name: "collateral_mint", pubkey: ctx.collateralMint },
      { name: "collateral_vault", pubkey: collateralVault, isWritable: true },
      {
        name: "user_collateral",
        pubkey: tokenAccount(params.userCollateral, params.user, ctx.collateralMint, ctx.tokenProgram),
        isWritable: true,
      },
      { name: "token_program", pubkey: ctx.tokenProgram },
    ],
    data,
  );
}

export interface MintConfirmParams {
  /** Bonded keeper confirming the request. */
  readonly keeper: string;
  readonly user: string;
  readonly nonce: bigint;
  /** 32 byte hash of the venue-side hedge execution payload. */
  readonly hedgeProofHash: Uint8Array;
  readonly venueId: number;
  /** Hedge notional actually filled, in synthetic base units. */
  readonly filledNotional: bigint;
  readonly userSynthetic?: string;
}

/**
 * Build `mint_confirm`: mint against a request whose hedge is filled.
 *
 * Keeper-only, and the hash attests to a fill that happened. Confirming a hedge
 * that was not placed is what the bond is slashed for.
 *
 * @throws PoyzConfigError on a malformed hash, venue id or address.
 */
export function buildMintConfirmInstruction(
  ctx: PoyzChainContext,
  params: MintConfirmParams,
): BuiltInstruction {
  assertProofHash(params.hedgeProofHash, "hedgeProofHash");
  assertVenueId(params.venueId);
  assertNonNegative(params.filledNotional, "filledNotional");

  const [request] = deriveMintRequest(params.user, params.nonce, ctx.programId);
  const [keeperAccount] = deriveKeeper(params.keeper, ctx.programId);

  const data = new BorshWriter()
    .bytes(discriminator("mint_confirm"))
    .u64(params.nonce)
    .fixedBytes(params.hedgeProofHash, 32)
    .u8(params.venueId)
    .u64(params.filledNotional)
    .toUint8Array();

  return instruction(
    "mint_confirm",
    ctx.programId,
    [
      { name: "keeper", pubkey: params.keeper, isSigner: true, isWritable: true },
      configAccount(ctx),
      { name: "keeper_account", pubkey: keeperAccount, isWritable: true },
      { name: "request", pubkey: request, isWritable: true },
      { name: "user", pubkey: params.user, isWritable: true },
      { name: "synthetic_mint", pubkey: ctx.syntheticMint, isWritable: true },
      {
        name: "user_synthetic",
        pubkey: tokenAccount(params.userSynthetic, params.user, ctx.syntheticMint, ctx.tokenProgram),
        isWritable: true,
      },
      { name: "oracle", pubkey: ctx.oracle },
      { name: "token_program", pubkey: ctx.tokenProgram },
    ],
    data,
  );
}

// -------------------------------------------------------------------- redemption

export interface RedeemRequestParams {
  readonly user: string;
  readonly nonce: bigint;
  /** Synthetic dollars to burn, in synthetic base units. */
  readonly syntheticAmount: bigint;
  /** Slippage floor on the collateral returned, in collateral base units. */
  readonly minCollateralOut: bigint;
  readonly userSynthetic?: string;
}

/**
 * Build `redeem_request`: escrow synthetic dollars and quote the redemption.
 *
 * Nothing is released here. A keeper unwinds the matching hedge and settles with
 * `redeem_confirm`; the user reclaims the escrow with `redeem_cancel` after the
 * deadline.
 *
 * @throws PoyzConfigError on a non-positive amount or a malformed address.
 */
export function buildRedeemRequestInstruction(
  ctx: PoyzChainContext,
  params: RedeemRequestParams,
): BuiltInstruction {
  assertPositive(params.syntheticAmount, "syntheticAmount");
  assertNonNegative(params.minCollateralOut, "minCollateralOut");

  const [request] = deriveRedeemRequest(params.user, params.nonce, ctx.programId);
  const [redeemEscrow] = deriveRedeemEscrow(ctx.programId);

  const data = new BorshWriter()
    .bytes(discriminator("redeem_request"))
    .u64(params.nonce)
    .u64(params.syntheticAmount)
    .u64(params.minCollateralOut)
    .toUint8Array();

  return instruction(
    "redeem_request",
    ctx.programId,
    [
      { name: "user", pubkey: params.user, isSigner: true, isWritable: true },
      configAccount(ctx),
      { name: "request", pubkey: request, isWritable: true },
      { name: "synthetic_mint", pubkey: ctx.syntheticMint },
      {
        name: "user_synthetic",
        pubkey: tokenAccount(params.userSynthetic, params.user, ctx.syntheticMint, ctx.tokenProgram),
        isWritable: true,
      },
      { name: "redeem_escrow", pubkey: redeemEscrow, isWritable: true },
      { name: "oracle", pubkey: ctx.oracle },
      { name: "token_program", pubkey: ctx.tokenProgram },
      { name: "system_program", pubkey: SYSTEM_PROGRAM_ID },
    ],
    data,
  );
}

export interface RedeemCancelParams {
  readonly user: string;
  readonly nonce: bigint;
  readonly userSynthetic?: string;
}

/**
 * Build `redeem_cancel`: return escrowed synthetic dollars for an expired request.
 *
 * @throws PoyzConfigError on a malformed address.
 */
export function buildRedeemCancelInstruction(
  ctx: PoyzChainContext,
  params: RedeemCancelParams,
): BuiltInstruction {
  const [request] = deriveRedeemRequest(params.user, params.nonce, ctx.programId);
  const [redeemEscrow] = deriveRedeemEscrow(ctx.programId);

  const data = new BorshWriter().bytes(discriminator("redeem_cancel")).u64(params.nonce).toUint8Array();

  return instruction(
    "redeem_cancel",
    ctx.programId,
    [
      { name: "user", pubkey: params.user, isSigner: true, isWritable: true },
      configAccount(ctx),
      { name: "request", pubkey: request, isWritable: true },
      { name: "synthetic_mint", pubkey: ctx.syntheticMint },
      { name: "redeem_escrow", pubkey: redeemEscrow, isWritable: true },
      {
        name: "user_synthetic",
        pubkey: tokenAccount(params.userSynthetic, params.user, ctx.syntheticMint, ctx.tokenProgram),
        isWritable: true,
      },
      { name: "token_program", pubkey: ctx.tokenProgram },
    ],
    data,
  );
}

export interface RedeemConfirmParams {
  readonly keeper: string;
  readonly user: string;
  readonly nonce: bigint;
  /** 32 byte hash of the venue-side unwind payload. */
  readonly unwindProofHash: Uint8Array;
  readonly venueId: number;
  /** Hedge notional actually unwound, in synthetic base units. */
  readonly unwoundNotional: bigint;
  readonly userCollateral?: string;
}

/**
 * Build `redeem_confirm`: burn the escrow and release collateral.
 *
 * @throws PoyzConfigError on a malformed hash, venue id or address.
 */
export function buildRedeemConfirmInstruction(
  ctx: PoyzChainContext,
  params: RedeemConfirmParams,
): BuiltInstruction {
  assertProofHash(params.unwindProofHash, "unwindProofHash");
  assertVenueId(params.venueId);
  assertNonNegative(params.unwoundNotional, "unwoundNotional");

  const [request] = deriveRedeemRequest(params.user, params.nonce, ctx.programId);
  const [keeperAccount] = deriveKeeper(params.keeper, ctx.programId);
  const [redeemEscrow] = deriveRedeemEscrow(ctx.programId);
  const [collateralVault] = deriveCollateralVault(ctx.collateralMint, ctx.programId);

  const data = new BorshWriter()
    .bytes(discriminator("redeem_confirm"))
    .u64(params.nonce)
    .fixedBytes(params.unwindProofHash, 32)
    .u8(params.venueId)
    .u64(params.unwoundNotional)
    .toUint8Array();

  return instruction(
    "redeem_confirm",
    ctx.programId,
    [
      { name: "keeper", pubkey: params.keeper, isSigner: true, isWritable: true },
      configAccount(ctx),
      { name: "keeper_account", pubkey: keeperAccount, isWritable: true },
      { name: "request", pubkey: request, isWritable: true },
      { name: "user", pubkey: params.user, isWritable: true },
      { name: "synthetic_mint", pubkey: ctx.syntheticMint, isWritable: true },
      { name: "redeem_escrow", pubkey: redeemEscrow, isWritable: true },
      { name: "collateral_mint", pubkey: ctx.collateralMint },
      { name: "collateral_vault", pubkey: collateralVault, isWritable: true },
      {
        name: "user_collateral",
        pubkey: tokenAccount(params.userCollateral, params.user, ctx.collateralMint, ctx.tokenProgram),
        isWritable: true,
      },
      { name: "oracle", pubkey: ctx.oracle },
      { name: "token_program", pubkey: ctx.tokenProgram },
    ],
    data,
  );
}

// ---------------------------------------------------------------------- staking

export interface StakeParams {
  readonly owner: string;
  /** Synthetic dollars to stake, in synthetic base units. */
  readonly amount: bigint;
  readonly ownerSynthetic?: string;
}

/**
 * Build `stake_synthetic`.
 *
 * Holding the synthetic dollar is holding a dollar. Staking it is taking the
 * funding exposure, in both directions: a negative funding regime advances the
 * reward index downward and stakers carry that.
 *
 * @throws PoyzConfigError on a non-positive amount or a malformed address.
 */
export function buildStakeInstruction(ctx: PoyzChainContext, params: StakeParams): BuiltInstruction {
  assertPositive(params.amount, "amount");
  const [position] = deriveStakePosition(params.owner, ctx.programId);
  const [stakeVault] = deriveStakeVault(ctx.programId);

  const data = new BorshWriter()
    .bytes(discriminator("stake"))
    .u64(params.amount)
    .toUint8Array();

  return instruction(
    "stake",
    ctx.programId,
    [
      { name: "owner", pubkey: params.owner, isSigner: true, isWritable: true },
      configAccount(ctx),
      { name: "position", pubkey: position, isWritable: true },
      { name: "synthetic_mint", pubkey: ctx.syntheticMint },
      {
        name: "owner_synthetic",
        pubkey: tokenAccount(params.ownerSynthetic, params.owner, ctx.syntheticMint, ctx.tokenProgram),
        isWritable: true,
      },
      { name: "stake_vault", pubkey: stakeVault, isWritable: true },
      { name: "token_program", pubkey: ctx.tokenProgram },
      { name: "system_program", pubkey: SYSTEM_PROGRAM_ID },
    ],
    data,
  );
}

export interface RequestUnstakeParams {
  readonly owner: string;
  /** Amount to put into cooldown, in synthetic base units. */
  readonly amount: bigint;
  readonly ownerSynthetic?: string;
}

/**
 * Build `request_unstake`: start the unstake cooldown on part of a position.
 *
 * Unstaking is two-legged, like issuance. This moves the amount into a pending
 * balance and starts the clock; `unstake` withdraws it once the cooldown ends.
 * The delay exists so the keeper can unwind hedge against staker outflow instead
 * of being surprised by it.
 *
 * @throws PoyzConfigError on a non-positive amount or a malformed address.
 */
export function buildRequestUnstakeInstruction(
  ctx: PoyzChainContext,
  params: RequestUnstakeParams,
): BuiltInstruction {
  assertPositive(params.amount, "amount");
  const [position] = deriveStakePosition(params.owner, ctx.programId);
  const [stakeVault] = deriveStakeVault(ctx.programId);

  const data = new BorshWriter()
    .bytes(discriminator("request_unstake"))
    .u64(params.amount)
    .toUint8Array();

  return instruction(
    "request_unstake",
    ctx.programId,
    [
      { name: "owner", pubkey: params.owner, isSigner: true },
      configAccount(ctx),
      { name: "position", pubkey: position, isWritable: true },
      { name: "synthetic_mint", pubkey: ctx.syntheticMint },
      { name: "stake_vault", pubkey: stakeVault, isWritable: true },
      {
        name: "owner_synthetic",
        pubkey: tokenAccount(params.ownerSynthetic, params.owner, ctx.syntheticMint, ctx.tokenProgram),
        isWritable: true,
      },
      { name: "token_program", pubkey: ctx.tokenProgram },
    ],
    data,
  );
}

export interface UnstakeParams {
  readonly owner: string;
  readonly ownerSynthetic?: string;
}

/**
 * Build `unstake`: withdraw the pending unstake once its cooldown has ended.
 *
 * Takes no amount: the program withdraws whatever `request_unstake` put into
 * cooldown, and rejects the call while the cooldown is still running or when
 * nothing is pending.
 *
 * @throws PoyzConfigError on a malformed address.
 */
export function buildUnstakeInstruction(
  ctx: PoyzChainContext,
  params: UnstakeParams,
): BuiltInstruction {
  const [position] = deriveStakePosition(params.owner, ctx.programId);
  const [stakeVault] = deriveStakeVault(ctx.programId);

  const data = new BorshWriter().bytes(discriminator("unstake")).toUint8Array();

  return instruction(
    "unstake",
    ctx.programId,
    [
      { name: "owner", pubkey: params.owner, isSigner: true },
      configAccount(ctx),
      { name: "position", pubkey: position, isWritable: true },
      { name: "synthetic_mint", pubkey: ctx.syntheticMint },
      { name: "stake_vault", pubkey: stakeVault, isWritable: true },
      {
        name: "owner_synthetic",
        pubkey: tokenAccount(params.ownerSynthetic, params.owner, ctx.syntheticMint, ctx.tokenProgram),
        isWritable: true,
      },
      { name: "token_program", pubkey: ctx.tokenProgram },
    ],
    data,
  );
}

export interface ClaimFundingParams {
  readonly owner: string;
  readonly ownerSynthetic?: string;
}

/**
 * Build `claim_funding`: withdraw funding accrued to a stake position.
 *
 * @throws PoyzConfigError on a malformed address.
 */
export function buildClaimFundingInstruction(
  ctx: PoyzChainContext,
  params: ClaimFundingParams,
): BuiltInstruction {
  const [position] = deriveStakePosition(params.owner, ctx.programId);
  const [fundingVault] = deriveFundingVault(ctx.programId);

  const data = new BorshWriter().bytes(discriminator("claim_funding")).toUint8Array();

  return instruction(
    "claim_funding",
    ctx.programId,
    [
      { name: "owner", pubkey: params.owner, isSigner: true },
      configAccount(ctx),
      { name: "position", pubkey: position, isWritable: true },
      { name: "synthetic_mint", pubkey: ctx.syntheticMint },
      { name: "funding_vault", pubkey: fundingVault, isWritable: true },
      {
        name: "owner_synthetic",
        pubkey: tokenAccount(params.ownerSynthetic, params.owner, ctx.syntheticMint, ctx.tokenProgram),
        isWritable: true,
      },
      { name: "token_program", pubkey: ctx.tokenProgram },
    ],
    data,
  );
}

// ---------------------------------------------------------------------- keeper

export interface KeeperRegisterParams {
  readonly keeper: string;
  /** Opening bond, in bond-mint base units. Must be at least `minKeeperBond`. */
  readonly bondAmount: bigint;
  readonly keeperBondSource?: string;
}

/**
 * Build `keeper_register`: open a keeper account and post the opening bond.
 *
 * @throws PoyzConfigError on a non-positive bond or a malformed address.
 */
export function buildKeeperRegisterInstruction(
  ctx: PoyzChainContext,
  params: KeeperRegisterParams,
): BuiltInstruction {
  assertPositive(params.bondAmount, "bondAmount");
  const [keeperAccount] = deriveKeeper(params.keeper, ctx.programId);
  const [bondVault] = deriveBondVault(ctx.programId);

  const data = new BorshWriter()
    .bytes(discriminator("keeper_register"))
    .u64(params.bondAmount)
    .toUint8Array();

  return instruction(
    "keeper_register",
    ctx.programId,
    [
      { name: "keeper", pubkey: params.keeper, isSigner: true, isWritable: true },
      configAccount(ctx),
      { name: "keeper_account", pubkey: keeperAccount, isWritable: true },
      { name: "bond_mint", pubkey: ctx.bondMint },
      {
        name: "keeper_bond_source",
        pubkey: tokenAccount(params.keeperBondSource, params.keeper, ctx.bondMint, ctx.tokenProgram),
        isWritable: true,
      },
      { name: "bond_vault", pubkey: bondVault, isWritable: true },
      { name: "token_program", pubkey: ctx.tokenProgram },
      { name: "system_program", pubkey: SYSTEM_PROGRAM_ID },
    ],
    data,
  );
}

export interface KeeperBondParams {
  readonly keeper: string;
  readonly amount: bigint;
  readonly keeperBondSource?: string;
}

/**
 * Build `keeper_bond`: top up an existing bond.
 *
 * @throws PoyzConfigError on a non-positive amount or a malformed address.
 */
export function buildKeeperBondInstruction(
  ctx: PoyzChainContext,
  params: KeeperBondParams,
): BuiltInstruction {
  assertPositive(params.amount, "amount");
  const [keeperAccount] = deriveKeeper(params.keeper, ctx.programId);
  const [bondVault] = deriveBondVault(ctx.programId);

  const data = new BorshWriter().bytes(discriminator("keeper_bond")).u64(params.amount).toUint8Array();

  return instruction(
    "keeper_bond",
    ctx.programId,
    [
      { name: "keeper", pubkey: params.keeper, isSigner: true, isWritable: true },
      configAccount(ctx),
      { name: "keeper_account", pubkey: keeperAccount, isWritable: true },
      { name: "bond_mint", pubkey: ctx.bondMint },
      {
        name: "keeper_bond_source",
        pubkey: tokenAccount(params.keeperBondSource, params.keeper, ctx.bondMint, ctx.tokenProgram),
        isWritable: true,
      },
      { name: "bond_vault", pubkey: bondVault, isWritable: true },
      { name: "token_program", pubkey: ctx.tokenProgram },
    ],
    data,
  );
}

export interface KeeperUnbondParams {
  readonly keeper: string;
  readonly amount: bigint;
  readonly keeperBondDestination?: string;
}

/**
 * Build `keeper_unbond`: withdraw bond after the cooldown.
 *
 * The program rejects this while the unbond cooldown since the last committed
 * proof is still running, and rejects a partial withdrawal that would leave the
 * bond below the protocol minimum.
 *
 * @throws PoyzConfigError on a non-positive amount or a malformed address.
 */
export function buildKeeperUnbondInstruction(
  ctx: PoyzChainContext,
  params: KeeperUnbondParams,
): BuiltInstruction {
  assertPositive(params.amount, "amount");
  const [keeperAccount] = deriveKeeper(params.keeper, ctx.programId);
  const [bondVault] = deriveBondVault(ctx.programId);

  const data = new BorshWriter()
    .bytes(discriminator("keeper_unbond"))
    .u64(params.amount)
    .toUint8Array();

  return instruction(
    "keeper_unbond",
    ctx.programId,
    [
      { name: "keeper", pubkey: params.keeper, isSigner: true },
      configAccount(ctx),
      { name: "keeper_account", pubkey: keeperAccount, isWritable: true },
      { name: "bond_mint", pubkey: ctx.bondMint },
      { name: "bond_vault", pubkey: bondVault, isWritable: true },
      {
        name: "keeper_bond_destination",
        pubkey: tokenAccount(
          params.keeperBondDestination,
          params.keeper,
          ctx.bondMint,
          ctx.tokenProgram,
        ),
        isWritable: true,
      },
      { name: "token_program", pubkey: ctx.tokenProgram },
    ],
    data,
  );
}

export interface CommitRebalanceProofParams {
  readonly keeper: string;
  /** Must equal the config's current `rebalanceCount`. */
  readonly sequence: bigint;
  /**
   * 32 byte hash committing the per-venue execution payload.
   *
   * The program hash-chains it with the previous proof, so the sequence of
   * proofs is tamper-evident and an observer can re-derive each link from the
   * venue's own data.
   */
  readonly venuesHash: Uint8Array;
  readonly venueId: number;
  readonly deltaBpsBefore: number;
  readonly deltaBpsAfter: number;
  /** Hedge and collateral notionals, in synthetic base units. */
  readonly hedgedNotional: bigint;
  readonly collateralNotional: bigint;
}

/**
 * Build `commit_rebalance_proof`.
 *
 * A proof attests to a venue execution the caller performed. The program checks
 * what it can -- sequence, slot monotonicity, oracle freshness, and that
 * `deltaBpsAfter` is inside the band -- but it cannot check that the trade
 * happened. That part is what the bond is for.
 *
 * @throws PoyzConfigError on a malformed hash, venue id, delta or address.
 */
export function buildCommitRebalanceProofInstruction(
  ctx: PoyzChainContext,
  params: CommitRebalanceProofParams,
): BuiltInstruction {
  assertProofHash(params.venuesHash, "venuesHash");
  assertVenueId(params.venueId);
  assertDeltaBps(params.deltaBpsBefore, "deltaBpsBefore");
  assertDeltaBps(params.deltaBpsAfter, "deltaBpsAfter");
  assertPositive(params.collateralNotional, "collateralNotional");
  assertNonNegative(params.hedgedNotional, "hedgedNotional");

  const [keeperAccount] = deriveKeeper(params.keeper, ctx.programId);
  const [proof] = deriveRebalanceProof(params.sequence, ctx.programId);

  const data = new BorshWriter()
    .bytes(discriminator("commit_rebalance_proof"))
    .u64(params.sequence)
    .fixedBytes(params.venuesHash, 32)
    .u8(params.venueId)
    .i32(params.deltaBpsBefore)
    .i32(params.deltaBpsAfter)
    .u64(params.hedgedNotional)
    .u64(params.collateralNotional)
    .toUint8Array();

  return instruction(
    "commit_rebalance_proof",
    ctx.programId,
    [
      { name: "keeper", pubkey: params.keeper, isSigner: true, isWritable: true },
      configAccount(ctx),
      { name: "keeper_account", pubkey: keeperAccount, isWritable: true },
      { name: "proof", pubkey: proof, isWritable: true },
      { name: "oracle", pubkey: ctx.oracle },
      { name: "system_program", pubkey: SYSTEM_PROGRAM_ID },
    ],
    data,
  );
}

// ----------------------------------------------------------------------- buffer

export interface BufferDepositParams {
  readonly depositor: string;
  /** Synthetic dollars to add to the insurance buffer, in base units. */
  readonly amount: bigint;
  readonly depositorSynthetic?: string;
}

/**
 * Build `buffer_deposit`: add first-loss capital to the insurance buffer.
 *
 * Permissionless. Withdrawal is authority-gated and only unlocks in a sustained
 * negative funding regime, so this is a one-way contribution from the depositor's
 * point of view.
 *
 * @throws PoyzConfigError on a non-positive amount or a malformed address.
 */
export function buildBufferDepositInstruction(
  ctx: PoyzChainContext,
  params: BufferDepositParams,
): BuiltInstruction {
  assertPositive(params.amount, "amount");
  const [bufferVault] = deriveBufferVault(ctx.programId);

  const data = new BorshWriter()
    .bytes(discriminator("buffer_deposit"))
    .u64(params.amount)
    .toUint8Array();

  return instruction(
    "buffer_deposit",
    ctx.programId,
    [
      { name: "depositor", pubkey: params.depositor, isSigner: true, isWritable: true },
      configAccount(ctx),
      { name: "synthetic_mint", pubkey: ctx.syntheticMint },
      {
        name: "depositor_synthetic",
        pubkey: tokenAccount(
          params.depositorSynthetic,
          params.depositor,
          ctx.syntheticMint,
          ctx.tokenProgram,
        ),
        isWritable: true,
      },
      { name: "buffer_vault", pubkey: bufferVault, isWritable: true },
      { name: "token_program", pubkey: ctx.tokenProgram },
    ],
    data,
  );
}

/**
 * What the deployed program exposes, by SDK method name.
 *
 * Consult this before offering an action in a UI, rather than catching an error
 * after the user has filled in a form. Administrative instructions are marked
 * unavailable here because this SDK does not wrap them, not because the program
 * lacks them.
 */
export const POYZ_INSTRUCTION_SUPPORT: Readonly<
  Record<string, { readonly available: boolean; readonly reason: string }>
> = {
  mintRequest: {
    available: true,
    reason:
      "Escrows collateral and records a price quote. It does not mint: a bonded keeper mints against " +
      "the request with mint_confirm once the hedge is filled.",
  },
  mintConfirm: {
    available: true,
    reason: "Keeper-only. Mints against an open request and attests to the hedge fill.",
  },
  mintCancel: {
    available: true,
    reason: "Returns escrowed collateral for a request that passed its deadline unconfirmed.",
  },
  redeemRequest: {
    available: true,
    reason:
      "Escrows synthetic dollars and records a quote. Collateral is released by redeem_confirm once " +
      "the matching hedge is unwound.",
  },
  redeemConfirm: {
    available: true,
    reason: "Keeper-only. Burns the escrow, releases collateral and attests to the hedge unwind.",
  },
  redeemCancel: {
    available: true,
    reason: "Returns escrowed synthetic dollars for a request that passed its deadline unconfirmed.",
  },
  stake: {
    available: true,
    reason:
      "Stakes synthetic dollars for funding. Funding is a market rate: a negative regime moves the " +
      "reward index down and stakers carry that.",
  },
  requestUnstake: {
    available: true,
    reason:
      "Starts the unstake cooldown on part of a position. Nothing is withdrawn here; call unstake " +
      "once the cooldown ends.",
  },
  unstake: {
    available: true,
    reason:
      "Withdraws the pending unstake after its cooldown. Rejected while the cooldown is running or " +
      "when nothing is pending.",
  },
  claimFunding: { available: true, reason: "Claims funding accrued to a stake position." },
  keeperRegister: { available: true, reason: "Opens a keeper account and posts the opening bond." },
  keeperBond: { available: true, reason: "Tops up an existing keeper bond." },
  keeperUnbond: {
    available: true,
    reason:
      "Withdraws bond. Rejected while the unbond cooldown since the last proof is running, or if it " +
      "would leave the bond below the protocol minimum without a full exit.",
  },
  commitRebalanceProof: {
    available: true,
    reason:
      "Records a rebalance. Only commit a proof for an execution you actually performed; a false " +
      "proof is what the bond is slashed for.",
  },
  bufferDeposit: { available: true, reason: "Adds first-loss capital to the insurance buffer." },
  initialize: {
    available: false,
    reason:
      "Authority-only protocol setup. This SDK does not wrap it: it is a one-shot instruction whose " +
      "parameters deserve to be assembled deliberately from POYZ_IDL, not scripted.",
  },
  setParams: {
    available: false,
    reason: "Authority-only risk parameter change. Not wrapped; assemble it from POYZ_IDL.",
  },
  setGuardian: {
    available: false,
    reason:
      "Authority-only. Sets the key that may pause the protocol but never unpause it. Naming a " +
      "guardian is a governance act performed once, not something a CLI should make convenient; " +
      "assemble it from POYZ_IDL.",
  },
  setPaused: {
    available: false,
    reason:
      "Authority or guardian only. Pausing is an incident response, and the guardian deliberately " +
      "cannot unpause; assemble it from POYZ_IDL.",
  },
  keeperSlash: {
    available: false,
    reason:
      "Authority-only. Not wrapped: slashing is an adjudication, and the evidence hash should be " +
      "produced by the process that decided the fault.",
  },
  settleFunding: {
    available: false,
    reason: "Authority-only funding settlement. Not wrapped; assemble it from POYZ_IDL.",
  },
  bufferWithdraw: {
    available: false,
    reason: "Authority-only and time-locked. Not wrapped; assemble it from POYZ_IDL.",
  },
};

/**
 * Raise for an action this SDK does not wrap.
 *
 * @throws PoyzUnsupportedError always.
 */
export function refuseUnsupported(method: string): never {
  const entry = POYZ_INSTRUCTION_SUPPORT[method];
  throw new PoyzUnsupportedError(method, entry?.reason ?? "this SDK does not wrap that instruction");
}

/** Warning attached to every request-leg plan, so nobody reads it as a mint. */
export const TWO_STEP_WARNING =
  "This is the request leg only. Collateral or synthetic dollars move into protocol escrow now; " +
  "settlement happens when a bonded keeper confirms the hedge, and the request can be cancelled by " +
  "you after its deadline if no keeper confirms it.";

/** Warning attached to every plan that requires a bonded keeper signature. */
export const KEEPER_ATTESTATION_WARNING =
  "This instruction attests to a venue-side execution you performed. Submitting it for a trade that " +
  "did not happen is a slashable fault; the bond is slashed into the insurance buffer.";
