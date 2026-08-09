/**
 * Keypair loading.
 *
 * Rules this file enforces, in order of how badly each one hurts when broken:
 *
 * 1. A secret never reaches stdout, stderr or an error message. Every failure
 *    message is built from the path and a fixed description, never from the file
 *    content, so a malformed key cannot be echoed back into a terminal or a CI
 *    log. `test/keypair.test.mjs` locks this down.
 * 2. The path is always explicit. There is no default location, no wallet
 *    profile lookup and no shell out to another tool, so running a POYZ command
 *    can never move funds from a key the caller did not name.
 * 3. The shared Solana CLI configuration directory is refused outright. That
 *    key is global state shared with every other tool on the machine; a
 *    protocol CLI should be pointed at a key that belongs to it.
 * 4. Buffers this module owns are zeroed once the signer holds its own copy.
 */

import { resolve as resolvePath, sep as pathSep } from "node:path";
import type { PoyzSigner } from "@poyz/sdk";
import { usageError } from "./exit.js";

/** File access, injected so the rules can be tested without touching a disk. */
export interface KeypairIo {
  /** Read the file as UTF-8. Throws when it does not exist or is unreadable. */
  readFile(path: string): string;
  /** POSIX mode bits, or null when the platform does not report them. */
  fileMode(path: string): number | null;
}

export interface LoadedSigner {
  readonly signer: PoyzSigner;
  /** Base58 public key. The only part of a keypair this CLI ever prints. */
  readonly publicKey: string;
  /** Messages for stderr, for example loose file permissions. */
  readonly warnings: readonly string[];
}

export type SignerFactory = (secretKey: Uint8Array) => PoyzSigner;

const SECRET_KEY_BYTES = 64;

function sharedWalletDirectory(home: string | undefined): string | null {
  if (home === undefined || home === "") {
    return null;
  }
  return resolvePath(home, ".config", "solana");
}

/**
 * Parse the standard Solana keypair file: a JSON array of 64 byte values.
 *
 * @throws CliError whose message describes the shape problem and contains no
 * part of the file content.
 */
export function parseSecretKey(text: string, path: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw usageError(
      `keypair file ${path} is not valid JSON`,
      "Expected the Solana keypair format: a JSON array of 64 byte values.",
    );
  }
  if (!Array.isArray(parsed)) {
    throw usageError(
      `keypair file ${path} is not a JSON array`,
      "Expected the Solana keypair format: a JSON array of 64 byte values.",
    );
  }
  if (parsed.length !== SECRET_KEY_BYTES) {
    throw usageError(
      `keypair file ${path} holds ${parsed.length} values, expected ${SECRET_KEY_BYTES}`,
      "A Solana secret key is 64 bytes. A 32 byte seed is not accepted here.",
    );
  }

  const secret = new Uint8Array(SECRET_KEY_BYTES);
  for (let i = 0; i < SECRET_KEY_BYTES; i += 1) {
    const value: unknown = parsed[i];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
      secret.fill(0);
      throw usageError(
        `keypair file ${path} holds a value at index ${i} that is not a byte`,
        "Every entry must be a whole number between 0 and 255.",
      );
    }
    secret[i] = value;
  }
  return secret;
}

/** Warning text when the file is readable by group or other. */
export function permissionWarning(path: string, mode: number | null): string | null {
  if (mode === null) {
    return null;
  }
  if ((mode & 0o077) === 0) {
    return null;
  }
  const octal = (mode & 0o777).toString(8).padStart(3, "0");
  return `warning: keypair ${path} is mode ${octal}; it is readable beyond its owner. Run: chmod 600 ${path}`;
}

export interface LoadSignerDeps {
  readonly io: KeypairIo;
  readonly makeSigner: SignerFactory;
  readonly home: string | undefined;
}

/**
 * Load a signer from an explicit keypair file path.
 *
 * @param path Path exactly as the caller gave it, from `--keypair` or `POYZ_KEYPAIR`.
 * @throws CliError with exit code 2 when the path is refused or the file is not
 * a keypair. The message never contains key material.
 */
export function loadSigner(path: string, deps: LoadSignerDeps): LoadedSigner {
  const absolute = resolvePath(path);
  const shared = sharedWalletDirectory(deps.home);
  if (shared !== null && (absolute === shared || absolute.startsWith(shared + pathSep))) {
    throw usageError(
      `refusing to read the keypair at ${absolute}`,
      "That directory holds the wallet the Solana CLI shares with every other tool on this machine. Point --keypair at a key file that belongs to this deployment.",
    );
  }

  let text: string;
  try {
    text = deps.io.readFile(absolute);
  } catch {
    throw usageError(`cannot read keypair file ${absolute}`, "Check the path and the file permissions.");
  }

  const warnings: string[] = [];
  let mode: number | null = null;
  try {
    mode = deps.io.fileMode(absolute);
  } catch {
    mode = null;
  }
  const warning = permissionWarning(absolute, mode);
  if (warning !== null) {
    warnings.push(warning);
  }

  const secret = parseSecretKey(text, absolute);
  try {
    // The signer keeps its own copy so the buffer this module allocated can be
    // wiped without reaching into the SDK's internals.
    const signer = deps.makeSigner(Uint8Array.from(secret));
    return { signer, publicKey: signer.publicKey, warnings };
  } catch {
    // The underlying error is deliberately dropped rather than forwarded: it was
    // raised while holding key material and nothing guarantees its message is
    // free of it.
    throw usageError(
      `keypair file ${absolute} is not a usable Solana secret key`,
      "The file parsed as 64 bytes but was rejected as an ed25519 secret key.",
    );
  } finally {
    secret.fill(0);
  }
}
