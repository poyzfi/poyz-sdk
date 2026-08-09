/**
 * Global flags: the ones every command accepts, plus their environment
 * fallbacks and the client configuration they resolve to.
 *
 * Precedence is flag, then environment variable, then the SDK default. Nothing
 * here reads a wallet configuration file or a shared CLI profile: the key path
 * is only ever what the caller passed.
 */

import type { PoyzClientConfig, PoyzCluster, ReadSource } from "@poyz/sdk";
import { shouldUseColor } from "./color.js";
import { usageError } from "./exit.js";
import { getBoolean, getEnum, getNumber, getString, type FlagSpec, type ParsedFlags } from "./flags.js";

export const CLUSTERS: readonly PoyzCluster[] = ["mainnet-beta", "devnet", "localnet"];
export const READ_SOURCES: readonly ReadSource[] = ["api", "chain", "auto"];

export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: "json", type: "boolean", summary: "Emit one JSON object on stdout instead of a table" },
  {
    name: "cluster",
    type: "string",
    placeholder: "<name>",
    summary: `Solana cluster: ${CLUSTERS.join(" | ")} (default mainnet-beta, env POYZ_CLUSTER)`,
  },
  { name: "rpc", type: "string", placeholder: "<url>", summary: "RPC endpoint (env POYZ_RPC)" },
  { name: "api", type: "string", placeholder: "<url>", summary: "POYZ status API base URL (env POYZ_API)" },
  { name: "program", type: "string", placeholder: "<id>", summary: "POYZ program address (env POYZ_PROGRAM_ID)" },
  {
    name: "keypair",
    type: "string",
    placeholder: "<path>",
    summary: "Path to a Solana keypair JSON file (env POYZ_KEYPAIR)",
  },
  {
    name: "collateral-mint",
    type: "string",
    placeholder: "<mint>",
    summary: "Assert the protocol holds this collateral mint (env POYZ_COLLATERAL_MINT)",
  },
  { name: "execute", type: "boolean", summary: "Send the transaction. Without it every write is a dry run" },
  { name: "yes", type: "boolean", summary: "Skip the confirmation prompt. Requires --execute to have any effect" },
  { name: "no-color", type: "boolean", summary: "Disable colour (also honours NO_COLOR)" },
  { name: "timeout", type: "integer", placeholder: "<ms>", summary: "Request timeout in milliseconds" },
  { name: "source", type: "string", placeholder: "<name>", summary: `Read path: ${READ_SOURCES.join(" | ")} (default auto)` },
  { name: "help", type: "boolean", alias: "h", summary: "Show help for the command" },
  { name: "version", type: "boolean", alias: "V", summary: "Show the version" },
];

export interface GlobalConfig {
  readonly json: boolean;
  readonly cluster: PoyzCluster;
  readonly rpcUrl: string | undefined;
  readonly apiBaseUrl: string | undefined;
  readonly programId: string | undefined;
  readonly keypairPath: string | undefined;
  readonly collateralMint: string | undefined;
  readonly execute: boolean;
  readonly yes: boolean;
  readonly timeoutMs: number | undefined;
  readonly source: ReadSource;
  readonly useColor: boolean;
}

export type Env = Readonly<Record<string, string | undefined>>;

function fromEnv(env: Env, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value === "" ? undefined : value;
}

function parseCluster(value: string): PoyzCluster {
  if (!(CLUSTERS as readonly string[]).includes(value)) {
    throw usageError(`unknown cluster "${value}", expected ${CLUSTERS.join(" | ")}`);
  }
  return value as PoyzCluster;
}

export function resolveGlobals(flags: ParsedFlags, env: Env, isTty: boolean): GlobalConfig {
  const json = getBoolean(flags, "json");
  const clusterFlag = getEnum(flags, "cluster", CLUSTERS);
  const clusterEnv = fromEnv(env, "POYZ_CLUSTER");
  const cluster = clusterFlag ?? (clusterEnv === undefined ? "mainnet-beta" : parseCluster(clusterEnv));

  const timeoutMs = getNumber(flags, "timeout");
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    throw usageError("--timeout must be greater than zero");
  }

  return {
    json,
    cluster,
    rpcUrl: getString(flags, "rpc") ?? fromEnv(env, "POYZ_RPC"),
    apiBaseUrl: getString(flags, "api") ?? fromEnv(env, "POYZ_API"),
    programId: getString(flags, "program") ?? fromEnv(env, "POYZ_PROGRAM_ID"),
    keypairPath: getString(flags, "keypair") ?? fromEnv(env, "POYZ_KEYPAIR"),
    collateralMint: getString(flags, "collateral-mint") ?? fromEnv(env, "POYZ_COLLATERAL_MINT"),
    execute: getBoolean(flags, "execute"),
    yes: getBoolean(flags, "yes"),
    timeoutMs,
    source: getEnum(flags, "source", READ_SOURCES) ?? "auto",
    useColor: shouldUseColor({
      json,
      noColorFlag: getBoolean(flags, "no-color"),
      noColorEnv: env["NO_COLOR"],
      isTty,
    }),
  };
}

/** The subset of the SDK client configuration the flags actually pin down. */
export function clientConfig(config: GlobalConfig): Partial<PoyzClientConfig> {
  const partial: Record<string, unknown> = { cluster: config.cluster };
  if (config.rpcUrl !== undefined) {
    partial["rpcUrl"] = config.rpcUrl;
  }
  if (config.apiBaseUrl !== undefined) {
    partial["apiBaseUrl"] = config.apiBaseUrl;
  }
  if (config.programId !== undefined) {
    partial["programId"] = config.programId;
  }
  if (config.timeoutMs !== undefined) {
    partial["requestTimeoutMs"] = config.timeoutMs;
  }
  return partial as Partial<PoyzClientConfig>;
}

/** Read the keypair path. Never falls back to a shared wallet configuration. */
export function requireKeypairPath(config: GlobalConfig): string {
  if (config.keypairPath === undefined) {
    throw usageError(
      "keypair path is required",
      "Pass --keypair <path> or set POYZ_KEYPAIR. This CLI never reads a default wallet.",
    );
  }
  return config.keypairPath;
}
