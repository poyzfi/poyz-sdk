/**
 * Help text.
 *
 * Written so that reading `poyz --help` tells you what the tool will and will
 * not do to your funds, not only which words it accepts.
 */

import type { Palette } from "./color.js";
import { describeFlags } from "./flags.js";
import { GLOBAL_FLAGS } from "./globals.js";
import { heading, sections, wrap } from "./render.js";
import type { CommandSpec } from "./commands/support.js";

export const CLI_NAME = "poyz";

const EXIT_CODES: readonly (readonly [string, string])[] = [
  ["0", "Success"],
  ["1", "Runtime error: network, RPC, or an on-chain program error"],
  ["2", "Usage error: unknown command or flag, missing or malformed argument"],
  ["3", "No data: upstream has not published that metric yet"],
  ["4", "Threshold exceeded: the monitored value crossed --max-deviation-bps"],
  ["5", "Refused: a write was attempted without --execute, or a prompt was declined"],
];

const ENV_VARS: readonly (readonly [string, string])[] = [
  ["POYZ_KEYPAIR", "Keypair file path, same as --keypair"],
  ["POYZ_API", "Status API base URL, same as --api"],
  ["POYZ_RPC", "RPC endpoint, same as --rpc"],
  ["POYZ_CLUSTER", "Cluster name, same as --cluster"],
  ["POYZ_PROGRAM_ID", "Program address, same as --program"],
  ["POYZ_COLLATERAL_MINT", "Collateral mint, same as --collateral-mint"],
  ["NO_COLOR", "Any non-empty value disables colour"],
];

function pairs(palette: Palette, entries: readonly (readonly [string, string])[], indent = "  "): string {
  const width = entries.reduce((max, entry) => Math.max(max, entry[0].length), 0);
  return entries
    .map((entry) => `${indent}${palette.paint("muted", entry[0].padEnd(width))}  ${entry[1]}`)
    .join("\n");
}

function commandTable(palette: Palette, commands: readonly CommandSpec[]): string {
  const names = commands.map((spec) => spec.path.join(" "));
  const width = names.reduce((max, name) => Math.max(max, name.length), 0);
  return commands
    .map((spec, index) => `  ${palette.paint("body", (names[index] ?? "").padEnd(width))}  ${spec.summary}`)
    .join("\n");
}

export function renderTopHelp(palette: Palette, version: string, sdkVersion: string, commands: readonly CommandSpec[]): string {
  return sections(
    heading(palette, `${CLI_NAME} ${version} -- delta-neutral synthetic dollar on Solana (sdk ${sdkVersion})`),
    `Usage:\n  ${CLI_NAME} <command> [flags]`,
    `Commands:\n${commandTable(palette, commands)}`,
    `Global flags:\n${describeFlags(GLOBAL_FLAGS)}`,
    `Environment:\n${pairs(palette, ENV_VARS)}`,
    `Exit codes:\n${pairs(palette, EXIT_CODES)}`,
    sections(
      wrap(
        "Writes are dry runs by default: mint, redeem and keeper register build the instruction, simulate it against the cluster and stop. Nothing is signed or sent without --execute.",
        78,
      ),
      wrap(
        "A keypair is read only from --keypair or POYZ_KEYPAIR. There is no default wallet path and no shell out to another tool, and only the public key is ever printed.",
        78,
      ),
      wrap(
        "Funding is a market rate and can be negative; in that regime the protocol pays rather than receives. Metrics the protocol has not published are shown as not available, never as zero.",
        78,
      ),
    ),
  );
}

export function renderCommandHelp(palette: Palette, spec: CommandSpec): string {
  const own = spec.flags.length === 0 ? null : `Flags:\n${describeFlags(spec.flags)}`;
  const notes = spec.notes.length === 0 ? null : spec.notes.map((note) => wrap(note, 78)).join("\n\n");
  return sections(
    heading(palette, `${CLI_NAME} ${spec.path.join(" ")}`),
    wrap(spec.summary, 78),
    `Usage:\n  ${spec.usage}`,
    own,
    notes,
    `Global flags:\n${describeFlags(GLOBAL_FLAGS)}`,
  );
}
