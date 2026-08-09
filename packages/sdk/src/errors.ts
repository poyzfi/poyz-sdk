/**
 * Error taxonomy.
 *
 * Every failure this SDK can produce is one of these, and each carries the
 * machine readable `code` a caller should branch on. A caller must be able to
 * tell "the protocol has not published this number yet" apart from "the network
 * is down" apart from "the program rejected the transaction", because those
 * three want different handling and only one of them is a bug.
 */

import { IDL_ERRORS, type PoyzIdlError } from "./generated/idl.js";

/** Base class. Never thrown directly. */
export class PoyzError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A client config value is missing, malformed, or unsafe to ship. */
export class PoyzConfigError extends PoyzError {
  constructor(message: string) {
    super("config", message);
  }
}

/** The status API could not be reached, or answered with a non-2xx status. */
export class PoyzApiError extends PoyzError {
  readonly url: string;
  readonly status: number | null;

  constructor(url: string, status: number | null, message: string, options?: { cause?: unknown }) {
    super("api", message, options);
    this.url = url;
    this.status = status;
  }
}

/**
 * The source answered, and the answer is that it has no value yet.
 *
 * This is not a failure of the SDK or the network. Rendering a zero or a
 * placeholder here would be inventing a number, so the honest move is to
 * surface the reason and let the caller omit the indicator.
 */
export class PoyzUnavailableError extends PoyzError {
  readonly metric: string;
  readonly detail: string;

  constructor(metric: string, detail: string) {
    super("unavailable", `${metric} is not available: ${detail}`);
    this.metric = metric;
    this.detail = detail;
  }
}

/** An RPC call failed, or returned something that cannot be decoded. */
export class PoyzChainError extends PoyzError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("chain", message, options);
  }
}

/** The account does not exist at that address on the configured cluster. */
export class PoyzAccountNotFoundError extends PoyzChainError {
  readonly address: string;

  constructor(address: string, what: string) {
    super(`${what} account ${address} does not exist on this cluster`);
    this.address = address;
  }
}

/** The program rejected the transaction with one of its own error codes. */
export class PoyzProgramError extends PoyzChainError {
  readonly errorCode: number;
  readonly errorName: string;

  constructor(errorCode: number, errorName: string, message: string) {
    super(message);
    this.errorCode = errorCode;
    this.errorName = errorName;
  }
}

/**
 * The requested action has no instruction in the deployed program.
 *
 * Thrown instead of building a transaction against an invented discriminator.
 * A fabricated instruction would be accepted by this SDK and then rejected by
 * the chain, which is a worse failure than refusing here with a reason.
 */
export class PoyzUnsupportedError extends PoyzError {
  readonly instruction: string;
  readonly reason: string;

  constructor(instruction: string, reason: string) {
    super("unsupported", `${instruction} is not available: ${reason}`);
    this.instruction = instruction;
    this.reason = reason;
  }
}

const ERROR_BY_CODE: ReadonlyMap<number, PoyzIdlError> = new Map(
  IDL_ERRORS.map((entry) => [entry.code, entry] as const),
);

/**
 * Look up a program error code from the IDL error table.
 *
 * @param code The `Custom(n)` code carried by a failed instruction.
 * @returns The IDL entry, or `null` when the code is not one of the program's.
 */
export function describeProgramError(code: number): PoyzIdlError | null {
  return ERROR_BY_CODE.get(code) ?? null;
}

/** Every error the program can return, in code order. */
export const POYZ_IDL_ERRORS: readonly PoyzIdlError[] = IDL_ERRORS;

const CUSTOM_CODE_PATTERNS: readonly RegExp[] = [
  /"Custom"\s*:\s*(\d+)/,
  /Custom\s*\(\s*(\d+)\s*\)/,
  /custom program error:\s*0x([0-9a-fA-F]+)/,
  /Error Number:\s*(\d+)/,
];

/**
 * Pull a program error code out of an RPC error payload or a log line.
 *
 * The RPC surfaces the same failure in three different shapes depending on
 * whether it came back from `simulateTransaction`, `sendTransaction` preflight,
 * or the Anchor log stream, so all three are matched.
 *
 * @returns The numeric code, or `null` when the text carries no program error.
 */
export function extractProgramErrorCode(payload: unknown): number | null {
  const text = typeof payload === "string" ? payload : safeStringify(payload);
  if (text === null) {
    return null;
  }
  for (const pattern of CUSTOM_CODE_PATTERNS) {
    const match = pattern.exec(text);
    const captured = match?.[1];
    if (captured === undefined) {
      continue;
    }
    const radix = pattern.source.includes("0x") ? 16 : 10;
    const value = Number.parseInt(captured, radix);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function safeStringify(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
