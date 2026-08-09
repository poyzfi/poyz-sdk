/**
 * Client configuration.
 *
 * Defaults point at mainnet-beta over a public RPC. That is deliberate: an SDK
 * whose default endpoint is a keyed provider URL teaches integrators to embed a
 * key in a browser bundle. A keyed URL is rejected outright by `resolveConfig`
 * (see `assertPublicRpcUrl`); route it through a server handler instead.
 */

import { PoyzConfigError } from "./errors.js";
import { IDL_PROGRAM_ADDRESS } from "./generated/idl.js";

/** Solana clusters POYZ can be addressed on. */
export type PoyzCluster = "mainnet-beta" | "devnet" | "localnet";

/** Solana commitment levels accepted for reads. */
export type PoyzCommitment = "processed" | "confirmed" | "finalized";

/** POYZ program address, taken from the compiled IDL. */
export const POYZ_PROGRAM_ID: string = IDL_PROGRAM_ADDRESS;

/** Public RPC endpoint per cluster. No API keys, safe to ship to a browser. */
export const DEFAULT_RPC_ENDPOINTS: Readonly<Record<PoyzCluster, string>> = {
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
  localnet: "http://127.0.0.1:8899",
};

/** Base URL of the POYZ status API. */
export const DEFAULT_API_BASE_URL = "https://poyz-api-production.up.railway.app";

/** Default read timeout for both HTTP and RPC calls, in milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface PoyzClientConfig {
  readonly cluster: PoyzCluster;
  /**
   * RPC endpoint.
   *
   * Must be key-free. A keyed endpoint belongs behind a server route; embedding
   * one here puts it in every bundle that imports this SDK.
   */
  readonly rpcUrl: string;
  /** POYZ program address, base58. */
  readonly programId: string;
  /** Base URL of the POYZ status API, without a trailing slash. */
  readonly apiBaseUrl: string;
  readonly commitment: PoyzCommitment;
  readonly requestTimeoutMs: number;
}

const CLUSTERS: readonly PoyzCluster[] = ["mainnet-beta", "devnet", "localnet"];
const COMMITMENTS: readonly PoyzCommitment[] = ["processed", "confirmed", "finalized"];

/** Markers of an RPC endpoint that carries a credential in the URL. */
const KEYED_RPC_MARKERS: readonly RegExp[] = [
  /[?&]api[-_]?key=/i,
  /helius-rpc\.com/i,
  /g\.alchemy\.com\/v2\//i,
  /quicknode\.(pro|com)/i,
  /[?&]access[-_]?token=/i,
  /syndica\.io\/access-token/i,
  /triton\.one/i,
];

/**
 * Reject an RPC URL that carries a credential.
 *
 * @throws PoyzConfigError when the URL looks keyed.
 */
export function assertPublicRpcUrl(rpcUrl: string): void {
  for (const marker of KEYED_RPC_MARKERS) {
    if (marker.test(rpcUrl)) {
      throw new PoyzConfigError(
        "rpcUrl carries an API key or a keyed provider host. This SDK runs in browsers, " +
          "so a keyed endpoint here would be published with the bundle. Use a public RPC " +
          "endpoint and proxy the keyed one through your own server route.",
      );
    }
  }
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PoyzConfigError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Fill a partial config from the defaults and validate the result.
 *
 * @throws PoyzConfigError on an unknown cluster or commitment, an empty field,
 *   a non-positive timeout, or a keyed RPC URL.
 */
export function resolveConfig(partial: Partial<PoyzClientConfig> = {}): PoyzClientConfig {
  const cluster = partial.cluster ?? "mainnet-beta";
  if (!CLUSTERS.includes(cluster)) {
    throw new PoyzConfigError(`cluster must be one of ${CLUSTERS.join(", ")}`);
  }

  const commitment = partial.commitment ?? "confirmed";
  if (!COMMITMENTS.includes(commitment)) {
    throw new PoyzConfigError(`commitment must be one of ${COMMITMENTS.join(", ")}`);
  }

  const rpcUrl = requireNonEmpty(partial.rpcUrl ?? DEFAULT_RPC_ENDPOINTS[cluster], "rpcUrl");
  assertPublicRpcUrl(rpcUrl);

  const requestTimeoutMs = partial.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new PoyzConfigError("requestTimeoutMs must be a finite number greater than zero");
  }

  return {
    cluster,
    rpcUrl,
    programId: requireNonEmpty(partial.programId ?? POYZ_PROGRAM_ID, "programId"),
    apiBaseUrl: stripTrailingSlash(requireNonEmpty(partial.apiBaseUrl ?? DEFAULT_API_BASE_URL, "apiBaseUrl")),
    commitment,
    requestTimeoutMs,
  };
}

/** Solana Explorer URL for a signature on the configured cluster. */
export function explorerUrl(signature: string, cluster: PoyzCluster): string {
  const base = `https://explorer.solana.com/tx/${signature}`;
  switch (cluster) {
    case "mainnet-beta":
      return base;
    case "devnet":
      return `${base}?cluster=devnet`;
    case "localnet":
      return `${base}?cluster=custom&customUrl=${encodeURIComponent(DEFAULT_RPC_ENDPOINTS.localnet)}`;
  }
}
