/**
 * poyz-cli entry point.
 *
 * The shell is deliberately thin: build the context, dispatch, write what came
 * back, exit with the code. Everything that decides anything lives in modules
 * that return values, which is what makes the command paths testable without
 * capturing process streams.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runCli } from "./cli.js";
import { createContext } from "./context.js";

export { CLI_VERSION, COMMANDS, matchCommand, runCli, type CommandMatch } from "./cli.js";
export { createPalette, shouldUseColor, stripAnsi, type Palette, type Tone } from "./color.js";
export { type CommandInput, type CommandSpec } from "./commands/support.js";
export { createContext, type CliContext } from "./context.js";
export { buildEnvelope, renderEnvelope, type JsonEnvelope } from "./envelope.js";
export {
  CliError,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_RUNTIME,
  EXIT_THRESHOLD,
  EXIT_UNAVAILABLE,
  EXIT_USAGE,
  isCliError,
  type CliResult,
} from "./exit.js";
export {
  describeFlags,
  getBoolean,
  getEnum,
  getNumber,
  getString,
  parseFlags,
  type FlagSpec,
  type ParsedFlags,
} from "./flags.js";
export { CLUSTERS, GLOBAL_FLAGS, READ_SOURCES, clientConfig, resolveGlobals, type GlobalConfig } from "./globals.js";
export { CLI_NAME, renderCommandHelp, renderTopHelp } from "./help.js";
export {
  loadSigner,
  parseSecretKey,
  permissionWarning,
  type KeypairIo,
  type LoadedSigner,
  type LoadSignerDeps,
} from "./keypair.js";
export {
  cell,
  formatBps,
  formatCount,
  formatPercent,
  formatTimestamp,
  formatUsd,
  heading,
  keyValues,
  row,
  sections,
  table,
  wrap,
  type Cell,
  type Row,
} from "./render.js";

/**
 * Write and resolve once the stream has taken the data.
 *
 * Always calls `write`, even for an empty string: stream writes are ordered, so
 * the callback also confirms that anything a streaming command emitted earlier
 * has been handed on before the process exits.
 */
function writeAll(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise<void>((resolveWrite) => {
    stream.write(text, () => {
      resolveWrite();
    });
  });
}

/** Read argv, dispatch, write the streams, exit with the code. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<never> {
  const result = await runCli(argv, createContext());
  await writeAll(process.stdout, result.stdout);
  await writeAll(process.stderr, result.stderr);
  process.exit(result.exitCode);
}

/** True when this module is the process entry point rather than an import. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return pathToFileURL(entry).href === import.meta.url;
  }
}

if (isEntryPoint()) {
  void main();
}
