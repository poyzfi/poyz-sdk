/**
 * Shared command plumbing: the command shape, error mapping, and the two ways a
 * command finishes (a table or an envelope).
 */

import {
  PoyzConfigError,
  PoyzError,
  PoyzProgramError,
  PoyzUnavailableError,
  PoyzUnsupportedError,
  type SourcedValue,
} from "@poyz/sdk";
import type { Palette } from "../color.js";
import type { CliContext } from "../context.js";
import { buildEnvelope, renderEnvelope, type EnvelopeInput } from "../envelope.js";
import { CliError, EXIT_OK, EXIT_UNAVAILABLE, isCliError, runtimeError, usageError, type CliResult } from "../exit.js";
import type { FlagSpec, ParsedFlags } from "../flags.js";
import type { GlobalConfig } from "../globals.js";
import type { LoadedSigner } from "../keypair.js";
import { heading, keyValues, row, sections, wrap, type Row } from "../render.js";

export interface CommandInput {
  readonly ctx: CliContext;
  readonly globals: GlobalConfig;
  readonly flags: ParsedFlags;
  readonly palette: Palette;
}

export interface CommandSpec {
  /** Command words, for example `["keeper", "run"]`. */
  readonly path: readonly string[];
  readonly summary: string;
  readonly usage: string;
  /** Flags on top of the global set. */
  readonly flags: readonly FlagSpec[];
  /** Extra paragraphs shown by `poyz <command> --help`. */
  readonly notes: readonly string[];
  run(input: CommandInput): Promise<CliResult>;
}

export function commandName(spec: CommandSpec): string {
  return spec.path.join(" ");
}

/**
 * Load a signer and put its warnings on stderr immediately.
 *
 * Immediately, rather than carrying them to the end of the command: a key file
 * that is readable by the whole machine is worth saying out loud even when the
 * command goes on to fail for an unrelated reason.
 */
export function loadSignerFor(input: CommandInput, path: string): LoadedSigner {
  const loaded = input.ctx.loadSigner(path);
  for (const warning of loaded.warnings) {
    input.ctx.emitErr(`${warning}\n`);
  }
  return loaded;
}

/** Put a warning on stderr now, for the same reason. */
export function warn(input: CommandInput, message: string | null): void {
  if (message !== null) {
    input.ctx.emitErr(`${message}\n`);
  }
}

/** Map an SDK or unknown error onto a CLI exit code. */
export function mapError(error: unknown): CliError {
  if (isCliError(error)) {
    return error;
  }
  if (error instanceof PoyzConfigError) {
    return usageError(error.message, "Check --cluster, --rpc, --api and --program.");
  }
  if (error instanceof PoyzUnavailableError) {
    return new CliError(EXIT_UNAVAILABLE, error.code, error.message, error.detail);
  }
  if (error instanceof PoyzUnsupportedError) {
    return runtimeError(error.message, error.code, `Instruction: ${error.instruction}. ${error.reason}`);
  }
  if (error instanceof PoyzProgramError) {
    return runtimeError(error.message, error.code, `Program error ${error.errorCode} (${error.errorName}).`);
  }
  if (error instanceof PoyzError) {
    return runtimeError(error.message, error.code);
  }
  if (error instanceof Error) {
    return runtimeError(error.message);
  }
  return runtimeError(String(error));
}

/** Finish with a rendered table. */
export function textResult(body: string, exitCode = EXIT_OK, stderr = ""): CliResult {
  const trimmed = body.replace(/\s+$/, "");
  return { exitCode, stdout: trimmed.length === 0 ? "" : `${trimmed}\n`, stderr };
}

/** Finish with the `--json` envelope. */
export function jsonResult(envelope: EnvelopeInput, exitCode = EXIT_OK, stderr = ""): CliResult {
  return { exitCode, stdout: renderEnvelope(buildEnvelope(envelope)), stderr };
}

/** Drop rows whose value the protocol has not published. A gap stays a gap. */
export function presentRows(entries: readonly (Row | null)[]): readonly Row[] {
  return entries.filter((entry): entry is Row => entry !== null);
}

export function maybeRow(label: string, value: string | null, tone: Row["value"]["tone"] = "body"): Row | null {
  return value === null ? null : row(label, { text: value, tone, align: "left" });
}

export interface UnavailableInput {
  readonly input: CommandInput;
  readonly command: string;
  readonly metric: string;
  readonly sourced: Pick<SourcedValue<unknown>, "source" | "available" | "observedAtMs" | "detail">;
}

/**
 * The honest empty answer.
 *
 * Renders why the metric is missing and exits 3. It never substitutes a zero,
 * because a reader cannot tell a published zero from an absent number.
 */
export function unavailableResult(args: UnavailableInput): CliResult {
  const { input, command, metric, sourced } = args;
  const detail = sourced.detail ?? "upstream has not published this metric yet";
  if (input.globals.json) {
    return jsonResult(
      {
        ok: false,
        command,
        cluster: input.globals.cluster,
        source: sourced.source,
        available: false,
        observedAtMs: sourced.observedAtMs,
        data: null,
        error: { code: "CLI_UNAVAILABLE", message: `${metric} is not available: ${detail}` },
      },
      EXIT_UNAVAILABLE,
    );
  }
  const { palette } = input;
  const body = sections(
    heading(palette, `POYZ ${command}`),
    keyValues(palette, [
      row("cluster", { text: input.globals.cluster, tone: "muted", align: "left" }),
      row("source", { text: sourced.source, tone: "muted", align: "left" }),
      row("status", { text: "not available", tone: "warn", align: "left" }),
      row("reason", { text: detail, tone: "body", align: "left" }),
    ]),
    wrap(
      `No value is shown because none was published. ${metric} will appear here once the upstream source reports it.`,
      78,
      "  ",
    ),
  );
  return textResult(body, EXIT_UNAVAILABLE);
}

/**
 * Turn a caught error into the result the caller should exit with.
 *
 * `json` is passed separately rather than read off a resolved configuration,
 * because the flags themselves can be what failed to parse.
 */
export function errorResult(json: boolean, command: string, cluster: string, error: unknown): CliResult {
  const mapped = mapError(error);
  if (json) {
    return jsonResult(
      {
        ok: false,
        command,
        cluster,
        source: null,
        available: false,
        observedAtMs: null,
        data: null,
        error: {
          code: mapped.code,
          message: mapped.detail === null ? mapped.message : `${mapped.message}: ${mapped.detail}`,
        },
      },
      mapped.exitCode,
    );
  }
  const lines = [`poyz: ${mapped.message}`];
  if (mapped.detail !== null) {
    lines.push(mapped.detail);
  }
  return { exitCode: mapped.exitCode, stdout: "", stderr: `${lines.join("\n")}\n` };
}
