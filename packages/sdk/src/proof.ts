/**
 * Execution proof encoding and verification.
 *
 * A rebalance proof carries two digests. `venues_hash` is supplied by the
 * keeper and commits to the venue-side execution payload; `this_hash` is
 * computed by the program and chains each proof to the one before it.
 *
 * Both are only meaningful if every party computes them the same way, byte for
 * byte. The canonical encoder lives in `packages/delta-keeper` and this module
 * is the verifier the program's own documentation refers to
 * (`programs/poyz/src/instructions/proof.rs`, the header comment). If the two
 * disagree on a single field's width or position, the digest is not
 * reproducible and the proof chain proves nothing -- which is worse than having
 * no chain, because it still looks like evidence.
 *
 * Layouts here are transcribed from that header and from the `hashv` call the
 * program makes. Integers are little-endian, which is what Rust's
 * `to_le_bytes()` emits; pubkeys and digests are raw 32 byte arrays; the fills
 * vector is Borsh, so it carries a u32 little-endian length prefix.
 */

import { BorshWriter, toHex } from "./borsh.js";
import { PoyzConfigError } from "./errors.js";
import { toPublicKey } from "./pda.js";
import type { RebalanceRecordView } from "./types.js";

/** One venue fill inside the execution payload. */
export interface ExecutionFill {
  readonly orderId: bigint;
  /** Execution price in the venue's own integer units. */
  readonly price: bigint;
  /** Signed base amount. Negative is a short. */
  readonly baseAmount: bigint;
  /** Venue timestamp, unix seconds. */
  readonly ts: bigint;
}

/**
 * The payload a keeper hashes into `venues_hash`.
 *
 * The first fields exist for domain separation: without the config and the
 * sequence in the digest, a payload from one protocol or one rebalance could be
 * replayed as evidence for another.
 */
export interface ExecutionPayload {
  /** Protocol config address, base58. */
  readonly config: string;
  readonly sequence: bigint;
  /** The keeper accountable for this execution, base58. */
  readonly keeper: string;
  readonly venueId: number;
  /** The venue account that must show these fills, base58. */
  readonly venueSubaccount: string;
  readonly deltaBpsBefore: number;
  readonly deltaBpsAfter: number;
  readonly collateralNotional: bigint;
  readonly hedgedNotional: bigint;
  readonly oraclePrice: bigint;
  readonly oracleConf: bigint;
  readonly oracleExpo: number;
  readonly oraclePublishTime: bigint;
  readonly fills: readonly ExecutionFill[];
}

/** Inputs the program hashes into `this_hash`. */
export interface ProofChainLink {
  /** Chain head before this proof: `Config.last_proof_hash`, 32 bytes. */
  readonly prevHash: Uint8Array;
  readonly config: string;
  readonly sequence: bigint;
  readonly slot: bigint;
  readonly oraclePrice: bigint;
  readonly oracleConf: bigint;
  readonly oracleExpo: number;
  readonly oraclePublishTime: bigint;
  readonly collateralNotional: bigint;
  readonly hedgedNotional: bigint;
  readonly deltaBpsBefore: number;
  readonly deltaBpsAfter: number;
  readonly venueId: number;
  /** 32 byte digest the keeper submitted. */
  readonly venuesHash: Uint8Array;
  readonly keeper: string;
}

function keyBytes(address: string, field: string): Uint8Array {
  return toPublicKey(address, field).toBytes();
}

function assertHash(value: Uint8Array, field: string): Uint8Array {
  if (value.byteLength !== 32) {
    throw new PoyzConfigError(`${field} must be exactly 32 bytes, received ${value.byteLength}`);
  }
  return value;
}

/**
 * SHA-256, from the runtime's own Web Crypto.
 *
 * Async because `crypto.subtle` is, and it is the one digest implementation
 * present unmodified in both Node and a browser. Bundling a JavaScript SHA-256
 * to make this synchronous would mean shipping a second implementation of the
 * primitive the whole chain rests on.
 *
 * @throws PoyzConfigError when the runtime exposes no Web Crypto.
 */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCryptoLike } }).crypto?.subtle;
  if (subtle === undefined) {
    throw new PoyzConfigError(
      "this runtime exposes no crypto.subtle, so proof digests cannot be computed. " +
        "Node 20 and every current browser provide it.",
    );
  }
  const digest = await subtle.digest("SHA-256", data as unknown as ArrayBufferView);
  return new Uint8Array(digest);
}

interface SubtleCryptoLike {
  digest(algorithm: string, data: ArrayBufferView): Promise<ArrayBuffer>;
}

/**
 * Borsh-encode an execution payload, in the program's declared field order.
 *
 * @throws PoyzConfigError on a malformed address or an out-of-range field.
 */
export function encodeExecutionPayload(payload: ExecutionPayload): Uint8Array {
  if (!Number.isInteger(payload.venueId) || payload.venueId < 0 || payload.venueId > 255) {
    throw new PoyzConfigError("venueId must be an integer between 0 and 255");
  }

  const writer = new BorshWriter()
    .bytes(keyBytes(payload.config, "config"))
    .u64(payload.sequence)
    .bytes(keyBytes(payload.keeper, "keeper"))
    .u8(payload.venueId)
    .bytes(keyBytes(payload.venueSubaccount, "venueSubaccount"))
    .i32(payload.deltaBpsBefore)
    .i32(payload.deltaBpsAfter)
    .u64(payload.collateralNotional)
    .u64(payload.hedgedNotional)
    .i64(payload.oraclePrice)
    .u64(payload.oracleConf)
    .i32(payload.oracleExpo)
    .i64(payload.oraclePublishTime)
    // Borsh vectors carry a u32 little-endian length prefix.
    .u32(payload.fills.length);

  for (const fill of payload.fills) {
    writer.u64(fill.orderId).i64(fill.price).i64(fill.baseAmount).i64(fill.ts);
  }

  return writer.toUint8Array();
}

/** `sha256` over the Borsh encoding of the execution payload. */
export async function computeVenuesHash(payload: ExecutionPayload): Promise<Uint8Array> {
  return sha256(encodeExecutionPayload(payload));
}

/**
 * Recompute the digest the program stores as `this_hash`.
 *
 * This is a plain concatenation, not Borsh: the program calls `hashv` over the
 * fields in this order, each as its little-endian bytes, with pubkeys and
 * digests raw.
 */
export async function computeProofHash(link: ProofChainLink): Promise<Uint8Array> {
  const writer = new BorshWriter()
    .bytes(assertHash(link.prevHash, "prevHash"))
    .bytes(keyBytes(link.config, "config"))
    .u64(link.sequence)
    .u64(link.slot)
    .i64(link.oraclePrice)
    .u64(link.oracleConf)
    .i32(link.oracleExpo)
    .i64(link.oraclePublishTime)
    .u64(link.collateralNotional)
    .u64(link.hedgedNotional)
    .i32(link.deltaBpsBefore)
    .i32(link.deltaBpsAfter)
    .u8(link.venueId)
    .bytes(assertHash(link.venuesHash, "venuesHash"))
    .bytes(keyBytes(link.keeper, "keeper"));

  return sha256(writer.toUint8Array());
}

export interface ProofVerification {
  readonly sequence: number;
  /** True when the recomputed digest matches what the account stores. */
  readonly hashMatches: boolean;
  /** True when this proof's `prev_hash` equals the previous proof's `this_hash`. */
  readonly linksToPrevious: boolean | null;
  readonly expectedHashHex: string;
  readonly actualHashHex: string;
  readonly detail: string | null;
}

/**
 * Recompute and check a stored proof.
 *
 * The config address is needed because it is hashed in for domain separation:
 * the same numbers under a different protocol produce a different digest, which
 * is what stops a proof being lifted from one deployment into another.
 */
export async function verifyProof(
  record: RebalanceRecordView,
  config: string,
): Promise<ProofVerification> {
  const expected = await computeProofHash({
    prevHash: hexToBytes(record.prevHashHex, "prevHash"),
    config,
    sequence: BigInt(record.sequence),
    slot: BigInt(record.slot),
    oraclePrice: BigInt(record.oraclePrice),
    oracleConf: BigInt(record.oracleConf),
    oracleExpo: record.oracleExpo,
    oraclePublishTime: BigInt(Math.trunc(record.oraclePublishTimeMs / 1000)),
    collateralNotional: BigInt(record.collateralNotional),
    hedgedNotional: BigInt(record.hedgedNotional),
    deltaBpsBefore: record.deltaBpsBefore,
    deltaBpsAfter: record.deltaBpsAfter,
    venueId: record.venueId,
    venuesHash: hexToBytes(record.venuesHashHex, "venuesHash"),
    keeper: record.keeper,
  });

  const expectedHashHex = toHex(expected);
  const hashMatches = expectedHashHex === record.thisHashHex;
  return {
    sequence: record.sequence,
    hashMatches,
    linksToPrevious: null,
    expectedHashHex,
    actualHashHex: record.thisHashHex,
    detail: hashMatches
      ? null
      : "The recomputed digest does not match the one stored on chain. Either a field was decoded " +
        "differently here than the program hashed it, or the record was altered.",
  };
}

/**
 * Verify a run of proofs and the links between them.
 *
 * @param records Proofs in any order; they are sorted by sequence here.
 * @param config Protocol config address, hashed in for domain separation.
 * @returns One verification per proof, oldest first. `linksToPrevious` is null
 *   for the oldest proof in the run, because the previous link is outside it.
 */
export async function verifyProofChain(
  records: readonly RebalanceRecordView[],
  config: string,
): Promise<readonly ProofVerification[]> {
  const ordered = [...records].sort((a, b) => a.sequence - b.sequence);
  const out: ProofVerification[] = [];

  for (let i = 0; i < ordered.length; i += 1) {
    const record = ordered[i];
    if (record === undefined) {
      continue;
    }
    const verification = await verifyProof(record, config);
    const previous = ordered[i - 1];
    const linksToPrevious =
      previous === undefined || previous.sequence + 1 !== record.sequence
        ? null
        : previous.thisHashHex === record.prevHashHex;

    out.push({
      ...verification,
      linksToPrevious,
      detail:
        linksToPrevious === false
          ? "This proof does not link to the previous one: its prev_hash is not the previous " +
            "proof's this_hash, so the run is not a contiguous chain."
          : verification.detail,
    });
  }

  return out;
}

function hexToBytes(hex: string, field: string): Uint8Array {
  if (hex.length !== 64 || /[^0-9a-fA-F]/.test(hex)) {
    throw new PoyzConfigError(`${field} must be 32 bytes of hexadecimal, received "${hex}"`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
