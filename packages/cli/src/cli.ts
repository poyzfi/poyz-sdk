/**
 * The dispatcher.
 *
 * Pure with respect to the process: it takes argv and a context, and returns the
 * text to write plus the exit code. Streaming commands write through
 * `ctx.emit`, which the shell points at stdout and the tests point at an array.
 */

import { SDK_VERSION } from "@poyz/sdk";
import { createPalette, shouldUseColor } from "./color.js";
import { deltaCommand } from "./commands/delta.js";
import { fundingCommand } from "./commands/funding.js";
import {
  keeperBondCommand,
  keeperRegisterCommand,
  keeperRunCommand,
  keeperUnbondCommand,
} from "./commands/keeper.js";
import { mintCancelCommand, mintCommand, redeemCancelCommand, redeemCommand } from "./commands/requests.js";
import { venueListCommand, venueReportCommand } from "./commands/venue.js";
import {
  claimCommand,
  stakeCommand,
  unstakeCommand,
  unstakeWithdrawCommand,
} from "./commands/stake.js";
import { simulateCommand } from "./commands/simulate.js";
import { statusCommand } from "./commands/status.js";
import { errorResult, type CommandInput, type CommandSpec } from "./commands/support.js";
import type { CliContext } from "./context.js";
import { EXIT_OK, usageError, type CliError, type CliResult } from "./exit.js";
import { getBoolean, parseFlags } from "./flags.js";
import { GLOBAL_FLAGS, resolveGlobals } from "./globals.js";
import { CLI_NAME, renderCommandHelp, renderTopHelp } from "./help.js";

/** Version of this CLI. `test/version.test.mjs` keeps it equal to package.json. */
export const CLI_VERSION = "0.1.0";

export const COMMANDS: readonly CommandSpec[] = [
  mintCommand,
  mintCancelCommand,
  redeemCommand,
  redeemCancelCommand,
  stakeCommand,
  unstakeCommand,
  unstakeWithdrawCommand,
  claimCommand,
  deltaCommand,
  fundingCommand,
  statusCommand,
  keeperRunCommand,
  keeperRegisterCommand,
  keeperBondCommand,
  keeperUnbondCommand,
  venueListCommand,
  venueReportCommand,
  simulateCommand,
];

export interface CommandMatch {
  readonly spec: CommandSpec;
  /** Arguments left after the command words. */
  readonly rest: readonly string[];
}

/**
 * Resolve argv to a command, longest match first.
 *
 * `keeper run --once` matches `["keeper", "run"]` rather than a bare `keeper`,
 * so multi-word commands and single-word ones can share a prefix.
 */
export function matchCommand(argv: readonly string[]): CommandMatch | null {
  let best: CommandMatch | null = null;
  for (const spec of COMMANDS) {
    if (spec.path.length > argv.length) {
      continue;
    }
    let matched = true;
    for (let i = 0; i < spec.path.length; i += 1) {
      if (argv[i] !== spec.path[i]) {
        matched = false;
        break;
      }
    }
    if (!matched) {
      continue;
    }
    if (best === null || spec.path.length > best.spec.path.length) {
      best = { spec, rest: argv.slice(spec.path.length) };
    }
  }
  return best;
}

function textOk(body: string): CliResult {
  return { exitCode: EXIT_OK, stdout: `${body.replace(/\s+$/, "")}\n`, stderr: "" };
}

function asksForVersion(argv: readonly string[]): boolean {
  return argv.includes("--version") || argv.includes("-V");
}

function asksForHelp(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

/** `--json` as seen before any parsing, so a parse failure can still answer in JSON. */
function rawJson(argv: readonly string[]): boolean {
  return argv.includes("--json") || argv.includes("--json=true");
}

function unknownCommand(argv: readonly string[]): CliError {
  const words = argv.filter((token) => !token.startsWith("-"));
  const name = words.length === 0 ? argv.join(" ") : words.join(" ");
  return usageError(`unknown command "${name}"`, `Run "${CLI_NAME} --help" for the command list.`);
}

/**
 * Cluster as it can be known before the flags parse, for the error envelope.
 * Never validated here: an invalid value is reported by `resolveGlobals`.
 */
function rawCluster(argv: readonly string[], env: CliContext["env"]): string {
  const index = argv.indexOf("--cluster");
  const next = index === -1 ? undefined : argv[index + 1];
  if (next !== undefined && !next.startsWith("-")) {
    return next;
  }
  const inline = argv.find((token) => token.startsWith("--cluster="));
  if (inline !== undefined) {
    return inline.slice("--cluster=".length);
  }
  const fromEnv = env["POYZ_CLUSTER"];
  return fromEnv === undefined || fromEnv === "" ? "mainnet-beta" : fromEnv;
}

/**
 * Dispatch one command line.
 *
 * @param argv Arguments after the interpreter and the script path.
 * @param ctx Everything the commands are allowed to touch outside themselves.
 */
export async function runCli(argv: readonly string[], ctx: CliContext): Promise<CliResult> {
  const json = rawJson(argv);
  const palette = createPalette(
    shouldUseColor({
      json,
      noColorFlag: argv.includes("--no-color"),
      noColorEnv: ctx.env["NO_COLOR"],
      isTty: ctx.isTty,
    }),
  );

  try {
    if (argv.length === 0) {
      return textOk(renderTopHelp(palette, CLI_VERSION, SDK_VERSION, COMMANDS));
    }

    if (argv[0] === "help") {
      const target = matchCommand(argv.slice(1));
      return textOk(
        target === null
          ? renderTopHelp(palette, CLI_VERSION, SDK_VERSION, COMMANDS)
          : renderCommandHelp(palette, target.spec),
      );
    }

    const match = matchCommand(argv);
    if (match === null) {
      if (asksForVersion(argv)) {
        return textOk(`${CLI_NAME} ${CLI_VERSION} (sdk ${SDK_VERSION})`);
      }
      if (asksForHelp(argv)) {
        return textOk(renderTopHelp(palette, CLI_VERSION, SDK_VERSION, COMMANDS));
      }
      throw unknownCommand(argv);
    }

    const flags = parseFlags(match.rest, [...GLOBAL_FLAGS, ...match.spec.flags]);
    if (getBoolean(flags, "help")) {
      return textOk(renderCommandHelp(palette, match.spec));
    }
    if (getBoolean(flags, "version")) {
      return textOk(`${CLI_NAME} ${CLI_VERSION} (sdk ${SDK_VERSION})`);
    }

    const globals = resolveGlobals(flags, ctx.env, ctx.isTty);
    const input: CommandInput = { ctx, globals, flags, palette: createPalette(globals.useColor) };
    return await match.spec.run(input);
  } catch (error) {
    const match = matchCommand(argv);
    const command = match === null ? (argv[0] ?? "poyz") : match.spec.path.join(" ");
    return errorResult(json, command, rawCluster(argv, ctx.env), error);
  }
}
