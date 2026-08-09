/**
 * Program-derived addresses.
 *
 * Seeds are transcribed from the `pda.seeds` entries in the IDL, so they cannot
 * drift from what the deployed program derives. Integer seeds are little-endian,
 * matching the Rust `to_le_bytes()` the program uses.
 *
 * Most of the protocol's accounts are singletons: there is one `config`, and one
 * of each vault except the collateral vault, which is keyed by collateral mint.
 * Keeper, stake position, mint request, redeem request and rebalance proof are
 * keyed by their owner or sequence.
 */

import { PublicKey } from "@solana/web3.js";

import { u64Seed } from "./borsh.js";
import { POYZ_PROGRAM_ID } from "./config.js";
import { PoyzConfigError } from "./errors.js";

const encoder = new TextEncoder();

/** Seed literals, byte-for-byte as they appear in the IDL. */
export const PDA_SEEDS = {
  config: "config",
  collateralVault: "collateral_vault",
  bondVault: "bond_vault",
  bufferBondVault: "buffer_bond_vault",
  fundingVault: "funding_vault",
  bufferVault: "buffer_vault",
  stakeVault: "stake_vault",
  redeemEscrow: "redeem_escrow",
  keeper: "keeper",
  stakePosition: "stake",
  mintRequest: "mint_request",
  redeemRequest: "redeem_request",
  rebalanceProof: "proof",
} as const;

/** SPL Token program. */
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** SPL Token-2022 program. */
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** Associated Token Account program. */
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/**
 * Parse a base58 address.
 *
 * @throws PoyzConfigError naming the field, rather than the opaque message
 *   web3.js raises, so a caller can tell which argument was wrong.
 */
export function toPublicKey(value: string, field: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new PoyzConfigError(`${field} is not a valid base58 address: ${value}`);
  }
}

function programKey(programId: string | undefined): PublicKey {
  return toPublicKey(programId ?? POYZ_PROGRAM_ID, "programId");
}

function derive(seeds: readonly Uint8Array[], programId: string | undefined): [PublicKey, number] {
  const [address, bump] = PublicKey.findProgramAddressSync([...seeds], programKey(programId));
  return [address, bump];
}

function literal(seed: string): Uint8Array {
  return encoder.encode(seed);
}

function assertNonNegative(value: bigint, label: string): void {
  if (value < 0n) {
    throw new PoyzConfigError(`${label} must not be negative`);
  }
}

/** `["config"]` -- the protocol singleton. */
export function deriveConfig(programId?: string): [PublicKey, number] {
  return derive([literal(PDA_SEEDS.config)], programId);
}

/** `["collateral_vault", collateral_mint]` -- token account holding collateral. */
export function deriveCollateralVault(
  collateralMint: string,
  programId?: string,
): [PublicKey, number] {
  return derive(
    [literal(PDA_SEEDS.collateralVault), toPublicKey(collateralMint, "collateralMint").toBytes()],
    programId,
  );
}

/** `["bond_vault"]` -- token account holding keeper bonds. */
export function deriveBondVault(programId?: string): [PublicKey, number] {
  return derive([literal(PDA_SEEDS.bondVault)], programId);
}

/** `["buffer_bond_vault"]` -- where slashed bond lands. */
export function deriveBufferBondVault(programId?: string): [PublicKey, number] {
  return derive([literal(PDA_SEEDS.bufferBondVault)], programId);
}

/** `["funding_vault"]` -- funding held for stakers to claim. */
export function deriveFundingVault(programId?: string): [PublicKey, number] {
  return derive([literal(PDA_SEEDS.fundingVault)], programId);
}

/** `["buffer_vault"]` -- the insurance buffer. */
export function deriveBufferVault(programId?: string): [PublicKey, number] {
  return derive([literal(PDA_SEEDS.bufferVault)], programId);
}

/** `["stake_vault"]` -- staked synthetic dollars. */
export function deriveStakeVault(programId?: string): [PublicKey, number] {
  return derive([literal(PDA_SEEDS.stakeVault)], programId);
}

/** `["redeem_escrow"]` -- synthetic dollars held while a redemption settles. */
export function deriveRedeemEscrow(programId?: string): [PublicKey, number] {
  return derive([literal(PDA_SEEDS.redeemEscrow)], programId);
}

/** `["keeper", keeper]`. */
export function deriveKeeper(keeper: string, programId?: string): [PublicKey, number] {
  return derive([literal(PDA_SEEDS.keeper), toPublicKey(keeper, "keeper").toBytes()], programId);
}

/** `["stake", owner]` -- one stake position per owner. */
export function deriveStakePosition(owner: string, programId?: string): [PublicKey, number] {
  return derive([literal(PDA_SEEDS.stakePosition), toPublicKey(owner, "owner").toBytes()], programId);
}

/** `["mint_request", user, nonce_le_u64]`. */
export function deriveMintRequest(
  user: string,
  nonce: bigint,
  programId?: string,
): [PublicKey, number] {
  assertNonNegative(nonce, "nonce");
  return derive(
    [literal(PDA_SEEDS.mintRequest), toPublicKey(user, "user").toBytes(), u64Seed(nonce)],
    programId,
  );
}

/** `["redeem_request", user, nonce_le_u64]`. */
export function deriveRedeemRequest(
  user: string,
  nonce: bigint,
  programId?: string,
): [PublicKey, number] {
  assertNonNegative(nonce, "nonce");
  return derive(
    [literal(PDA_SEEDS.redeemRequest), toPublicKey(user, "user").toBytes(), u64Seed(nonce)],
    programId,
  );
}

/** `["proof", sequence_le_u64]` -- one account per committed rebalance. */
export function deriveRebalanceProof(sequence: bigint, programId?: string): [PublicKey, number] {
  assertNonNegative(sequence, "sequence");
  return derive([literal(PDA_SEEDS.rebalanceProof), u64Seed(sequence)], programId);
}

/**
 * Associated token account for an owner and mint.
 *
 * The token program is a parameter rather than a constant because the protocol
 * config records which one its mints belong to; SPL Token and Token-2022 derive
 * different addresses for the same owner and mint.
 */
export function deriveAssociatedTokenAddress(
  owner: string,
  mint: string,
  tokenProgramId: string = TOKEN_PROGRAM_ID,
): string {
  const [address] = PublicKey.findProgramAddressSync(
    [
      toPublicKey(owner, "owner").toBytes(),
      toPublicKey(tokenProgramId, "tokenProgramId").toBytes(),
      toPublicKey(mint, "mint").toBytes(),
    ],
    toPublicKey(ASSOCIATED_TOKEN_PROGRAM_ID, "associatedTokenProgramId"),
  );
  return address.toBase58();
}

/** Base58 helpers, for callers that only want the address. */
export const deriveConfigAddress = (programId?: string): string => deriveConfig(programId)[0].toBase58();
export const deriveCollateralVaultAddress = (collateralMint: string, programId?: string): string =>
  deriveCollateralVault(collateralMint, programId)[0].toBase58();
export const deriveBondVaultAddress = (programId?: string): string =>
  deriveBondVault(programId)[0].toBase58();
export const deriveBufferBondVaultAddress = (programId?: string): string =>
  deriveBufferBondVault(programId)[0].toBase58();
export const deriveFundingVaultAddress = (programId?: string): string =>
  deriveFundingVault(programId)[0].toBase58();
export const deriveBufferVaultAddress = (programId?: string): string =>
  deriveBufferVault(programId)[0].toBase58();
export const deriveStakeVaultAddress = (programId?: string): string =>
  deriveStakeVault(programId)[0].toBase58();
export const deriveRedeemEscrowAddress = (programId?: string): string =>
  deriveRedeemEscrow(programId)[0].toBase58();
export const deriveKeeperAddress = (keeper: string, programId?: string): string =>
  deriveKeeper(keeper, programId)[0].toBase58();
export const deriveStakePositionAddress = (owner: string, programId?: string): string =>
  deriveStakePosition(owner, programId)[0].toBase58();
export const deriveMintRequestAddress = (user: string, nonce: bigint, programId?: string): string =>
  deriveMintRequest(user, nonce, programId)[0].toBase58();
export const deriveRedeemRequestAddress = (user: string, nonce: bigint, programId?: string): string =>
  deriveRedeemRequest(user, nonce, programId)[0].toBase58();
export const deriveRebalanceProofAddress = (sequence: bigint, programId?: string): string =>
  deriveRebalanceProof(sequence, programId)[0].toBase58();
