/**
 * Exit codes, and the error type the dispatcher maps onto them.
 *
 * The codes are part of the published contract: CI jobs branch on them, so they
 * are defined once here and documented in README.md with the same wording.
 */

/** Command completed. */
export const EXIT_OK = 0;
/** Runtime failure: network, RPC, or an on-chain program error. */
export const EXIT_RUNTIME = 1;
/** Usage failure: unknown command or flag, missing or malformed argument. */
export const EXIT_USAGE = 2;
/** Upstream has not published the requested metric yet. */
export const EXIT_UNAVAILABLE = 3;
/** A monitored value crossed a threshold given on the command line. */
export const EXIT_THRESHOLD = 4;
/** Nothing was sent: a write was attempted without --execute, or a prompt was declined. */
export const EXIT_REFUSED = 5;

/** What the dispatcher produced. The shell writes it; the dispatcher never does. */
export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** An error carrying the exit code and the machine-readable code for `--json`. */
export class CliError extends Error {
  readonly exitCode: number;
  readonly code: string;
  /** Extra context shown on the second line of the human message. */
  readonly detail: string | null;

  constructor(exitCode: number, code: string, message: string, detail: string | null = null) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = code;
    this.detail = detail;
  }
}

export function usageError(message: string, detail: string | null = null): CliError {
  return new CliError(EXIT_USAGE, "CLI_USAGE", message, detail);
}

export function runtimeError(message: string, code = "CLI_RUNTIME", detail: string | null = null): CliError {
  return new CliError(EXIT_RUNTIME, code, message, detail);
}

export function unavailableError(message: string, detail: string | null = null): CliError {
  return new CliError(EXIT_UNAVAILABLE, "CLI_UNAVAILABLE", message, detail);
}

export function thresholdError(message: string, detail: string | null = null): CliError {
  return new CliError(EXIT_THRESHOLD, "CLI_THRESHOLD_EXCEEDED", message, detail);
}

export function refusedError(message: string, detail: string | null = null): CliError {
  return new CliError(EXIT_REFUSED, "CLI_REFUSED", message, detail);
}

/** Is this value a `CliError`? Works across bundle boundaries, unlike `instanceof`. */
export function isCliError(value: unknown): value is CliError {
  return value instanceof CliError;
}
