/**
 * Amount, decimals and nonce handling shared by every write command.
 *
 * Decimals come from the on-chain protocol config whenever it can be read, so a
 * whole-token amount converts with the mint's real precision rather than a
 * guess. `--decimals` overrides that when a caller has reason to. An amount is
 * never converted against an assumed precision: getting this wrong moves the
 * size of a transfer by orders of magnitude.
 */

import { decimalToBaseUnits, type ProtocolConfigView } from "@poyz/sdk";
import type { PoyzClientLike } from "../client.js";
import { usageError } from "../exit.js";
import { getNumber, getString } from "../flags.js";
import type { CommandInput } from "./support.js";
import { mapError } from "./support.js";

export type MintKind = "collateral" | "synthetic" | "bond";

export interface ResolvedAmount {
  /** The whole-token figure as the caller typed it. */
  readonly amount: number;
  readonly decimals: number;
  readonly baseUnits: bigint;
  /** Where the decimals came from, for the plan banner. */
  readonly decimalsFrom: "flag" | "protocol config";
  /** Why the config could not be read, when it could not be. */
  readonly note: string | null;
}

function decimalsOf(config: ProtocolConfigView, kind: MintKind): number {
  if (kind === "collateral") {
    return config.collateralDecimals;
  }
  if (kind === "synthetic") {
    return config.syntheticDecimals;
  }
  return config.bondDecimals;
}

/** Positional amount in whole tokens. */
export function readAmountArgument(input: CommandInput, label: string): number {
  const raw = input.flags.positionals[0];
  if (raw === undefined) {
    throw usageError(`${label} amount is required`, `Pass the amount in whole tokens, for example: poyz ${label} 1.5`);
  }
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw usageError(`${label} amount must be a positive number, got "${raw}"`);
  }
  return amount;
}

/**
 * Convert a whole-token amount to base units.
 *
 * @param config Protocol config when it could be read, otherwise null.
 * @throws CliError with exit code 2 when neither the config nor `--decimals`
 * can say how many decimals the mint has, because guessing would silently
 * change the size of a transfer by orders of magnitude.
 */
export function resolveAmount(
  input: CommandInput,
  amount: number,
  kind: MintKind,
  config: ProtocolConfigView | null,
  configError: string | null,
): ResolvedAmount {
  const override = getNumber(input.flags, "decimals");
  if (override !== undefined) {
    if (override < 0 || override > 18 || !Number.isInteger(override)) {
      throw usageError("--decimals must be a whole number between 0 and 18");
    }
    return {
      amount,
      decimals: override,
      baseUnits: decimalToBaseUnits(amount, override),
      decimalsFrom: "flag",
      note: config === null && configError !== null ? configError : null,
    };
  }
  if (config === null) {
    throw usageError(
      `cannot determine the ${kind} mint decimals`,
      `${configError ?? "the protocol config could not be read"}. Pass --decimals <n> to state the precision explicitly, though building the instruction needs the protocol config too.`,
    );
  }
  const decimals = decimalsOf(config, kind);
  return {
    amount,
    decimals,
    baseUnits: decimalToBaseUnits(amount, decimals),
    decimalsFrom: "protocol config",
    note: null,
  };
}

export interface ConfigProbe {
  readonly config: ProtocolConfigView | null;
  /** Human reason the config is missing, or null when it was read. */
  readonly error: string | null;
}

/** Read the protocol config, turning a failure into a reason rather than a throw. */
export async function probeConfig(client: PoyzClientLike): Promise<ConfigProbe> {
  try {
    return { config: await client.getConfig(), error: null };
  } catch (error) {
    return { config: null, error: mapError(error).message };
  }
}

/**
 * Warn when `--collateral-mint` disagrees with the deployed protocol.
 *
 * The config is a singleton, so the flag is no longer needed to find anything.
 * It is still worth passing in a script: it turns "I assumed this protocol
 * holds SOL" into an assertion that is checked against the chain.
 */
export function collateralMintMismatch(input: CommandInput, config: ProtocolConfigView | null): string | null {
  const expected = input.globals.collateralMint;
  if (expected === undefined || config === null || expected === config.collateralMint) {
    return null;
  }
  return `warning: --collateral-mint is ${expected} but the protocol config holds ${config.collateralMint}`;
}

/** Minimum output bound, in base units of the receiving mint. */
export function readMinOut(input: CommandInput): bigint {
  const raw = getString(input.flags, "min-out");
  if (raw === undefined) {
    return 0n;
  }
  if (!/^\d+$/.test(raw)) {
    throw usageError(`--min-out must be a whole number of base units, got "${raw}"`);
  }
  return BigInt(raw);
}

export interface ResolvedNonce {
  readonly nonce: bigint;
  /** True when the CLI picked the value, which means it must be shown. */
  readonly generated: boolean;
}

/**
 * Request nonce.
 *
 * The request account is a PDA seeded by the owner and this nonce, so it is the
 * handle for cancelling or inspecting the request later. When the CLI picks one
 * it is always printed, because losing it means losing the way to address a
 * pending request.
 */
export function readNonce(input: CommandInput, required: boolean): ResolvedNonce {
  const raw = getString(input.flags, "nonce");
  if (raw !== undefined) {
    if (!/^\d+$/.test(raw)) {
      throw usageError(`--nonce must be a whole number, got "${raw}"`);
    }
    return { nonce: BigInt(raw), generated: false };
  }
  if (required) {
    throw usageError(
      "--nonce <n> is required",
      "Use the nonce printed when the request was submitted; it identifies the request account.",
    );
  }
  return { nonce: BigInt(input.ctx.now()), generated: true };
}
