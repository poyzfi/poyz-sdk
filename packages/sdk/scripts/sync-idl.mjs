#!/usr/bin/env node
/**
 * Regenerate src/generated/idl.ts from the Anchor build output.
 *
 * The SDK does not read the IDL from disk at runtime: a browser bundle has no
 * filesystem, and an SDK that silently follows whatever IDL happens to sit in a
 * sibling directory is not reproducible. The IDL is instead compiled into the
 * package, and this script is the only thing allowed to write that file.
 *
 * Run it whenever packages/anchor-program is rebuilt, then commit the result.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const idlPath = resolve(packageRoot, "../anchor-program/target/idl/poyz.json");
const outPath = resolve(packageRoot, "src/generated/idl.ts");

const idl = JSON.parse(readFileSync(idlPath, "utf8"));

function discriminatorMap(entries) {
  const out = {};
  for (const entry of entries ?? []) {
    if (!Array.isArray(entry.discriminator)) {
      throw new Error(`IDL entry ${entry.name} has no discriminator`);
    }
    out[entry.name] = entry.discriminator;
  }
  return out;
}

const instructionDiscriminators = discriminatorMap(idl.instructions);
const accountDiscriminators = discriminatorMap(idl.accounts);
const eventDiscriminators = discriminatorMap(idl.events);

const errors = (idl.errors ?? []).map((e) => ({ code: e.code, name: e.name, msg: e.msg }));

const banner = `/**
 * GENERATED FILE -- do not edit by hand.
 *
 * Source: packages/anchor-program/target/idl/poyz.json
 * Regenerate: npm run sync-idl --workspace @poyz/sdk
 *
 * Program: ${idl.metadata.name} ${idl.metadata.version} (IDL spec ${idl.metadata.spec})
 */
`;

const body = `${banner}
/** One entry from the IDL error table. */
export interface PoyzIdlError {
  readonly code: number;
  readonly name: string;
  readonly msg: string;
}

export interface PoyzIdlMetadata {
  readonly name: string;
  readonly version: string;
  readonly spec: string;
  readonly description?: string;
}

/**
 * The raw Anchor IDL, exactly as the program emitted it.
 *
 * Exported so an integrator already using \`@coral-xyz/anchor\` can hand it to
 * \`new Program(POYZ_IDL, provider)\` instead of re-deriving it. The SDK itself
 * uses the narrowed constants below, not this object.
 */
export interface PoyzIdlRaw {
  readonly address: string;
  readonly metadata: PoyzIdlMetadata;
  readonly instructions: readonly unknown[];
  readonly accounts: readonly unknown[];
  readonly events: readonly unknown[];
  readonly errors: readonly PoyzIdlError[];
  readonly types: readonly unknown[];
}

export const POYZ_IDL = ${JSON.stringify(idl, null, 2)} as unknown as PoyzIdlRaw;

/** Program address declared by the IDL. */
export const IDL_PROGRAM_ADDRESS = ${JSON.stringify(idl.address)};

export const IDL_METADATA: PoyzIdlMetadata = ${JSON.stringify(idl.metadata, null, 2)};

/** Anchor instruction discriminators, keyed by the snake_case IDL name. */
export const INSTRUCTION_DISCRIMINATORS: Readonly<Record<string, readonly number[]>> = ${JSON.stringify(
  instructionDiscriminators,
  null,
  2,
)};

/** Anchor account discriminators, keyed by the account struct name. */
export const ACCOUNT_DISCRIMINATORS: Readonly<Record<string, readonly number[]>> = ${JSON.stringify(
  accountDiscriminators,
  null,
  2,
)};

/** Anchor event discriminators, keyed by the event struct name. */
export const EVENT_DISCRIMINATORS: Readonly<Record<string, readonly number[]>> = ${JSON.stringify(
  eventDiscriminators,
  null,
  2,
)};

/** The program error table, used to turn a Custom(n) code into a readable name. */
export const IDL_ERRORS: readonly PoyzIdlError[] = ${JSON.stringify(errors, null, 2)};
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, body, "utf8");

process.stdout.write(
  `sync-idl: wrote ${outPath}\n` +
    `  program        ${idl.address}\n` +
    `  instructions   ${Object.keys(instructionDiscriminators).join(", ")}\n` +
    `  accounts       ${Object.keys(accountDiscriminators).join(", ")}\n` +
    `  errors         ${errors.length}\n`,
);
