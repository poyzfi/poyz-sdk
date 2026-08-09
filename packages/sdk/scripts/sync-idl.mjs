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

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const anchorRoot = resolve(packageRoot, "../anchor-program");
const outPath = resolve(packageRoot, "src/generated/idl.ts");
const venuesOutPath = resolve(packageRoot, "src/generated/venues.ts");

// `idl/` is what the program publishes and what the public repository ships;
// `target/idl/` is the raw anchor build output. Prefer the published copy so the
// SDK and the public IDL cannot disagree, and fall back to the build output for
// a working tree that has not run the copy step yet.
const idlCandidates = [resolve(anchorRoot, "idl/poyz.json"), resolve(anchorRoot, "target/idl/poyz.json")];
const idlPath = idlCandidates.find((candidate) => existsSync(candidate));
if (idlPath === undefined) {
  throw new Error(`no IDL found. Looked in:\n  ${idlCandidates.join("\n  ")}`);
}

const venuesPath = resolve(anchorRoot, "idl/venues.json");

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

// ---------------------------------------------------------------- venue contract
//
// The venue id mapping is a cross-package contract that an IDL cannot carry: it
// is plain constants, not accounts or instructions. The program emits it beside
// the IDL, and every package reads that file rather than keeping its own copy.
// Two packages each holding a correct-looking table is how the primary venue
// ends up registered under two different names, and a string mismatch there is
// not something a type checker can see -- it fails at runtime, on every proof.
if (!existsSync(venuesPath)) {
  throw new Error(
    `no venue contract at ${venuesPath}. The SDK does not keep its own venue table; ` +
      "regenerate it from the program with scripts/copy-idl.js.",
  );
}
const venues = JSON.parse(readFileSync(venuesPath, "utf8"));

for (const field of ["idBase", "unsetId", "maxAssignableId", "venues", "aliases", "retired"]) {
  if (venues[field] === undefined) {
    throw new Error(`venue contract at ${venuesPath} is missing "${field}"`);
  }
}

const venuesBody = `/**
 * GENERATED FILE -- do not edit by hand.
 *
 * Source: ${venuesPath.replace(resolve(packageRoot, "../.."), "").replace(/^\//, "")}
 * Regenerate: npm run sync-idl --workspace @poyz/sdk
 *
 * The venue id contract, emitted by the program alongside its IDL. This SDK does
 * not keep a second copy: two tables that look right independently are how the
 * primary venue ends up registered under two names, and that mismatch is a
 * string, so nothing catches it until every proof commit fails at runtime.
 */

/** Slot numbering starts here. Slot ${venues.unsetId} is the unset value and is never a venue. */
export const VENUE_ID_BASE = ${venues.idBase};
export const VENUE_ID_UNSET = ${venues.unsetId};
export const VENUE_ID_MAX_ASSIGNABLE = ${venues.maxAssignableId};

/** Canonical venue name to slot. */
export const VENUE_SLOTS: Readonly<Record<string, number>> = ${JSON.stringify(venues.venues, null, 2)};

/** Accepted aliases, mapping an alternate spelling to a canonical name. */
export const VENUE_ALIASES: Readonly<Record<string, string>> = ${JSON.stringify(venues.aliases, null, 2)};

/** Venues that no longer operate, with the reason they were retired. */
export const VENUE_RETIRED: Readonly<Record<string, string>> = ${JSON.stringify(venues.retired, null, 2)};

/** Bitmask of every assignable slot. Bit ${venues.unsetId} is permanently unused. */
export const VENUE_FLAGS_MASK = ${venues.venueFlagsMask ?? 0};

/** Bitmask the program initialises with. */
export const VENUE_FLAGS_DEFAULT = ${venues.defaultVenueFlags ?? 0};
`;

writeFileSync(venuesOutPath, venuesBody, "utf8");

process.stdout.write(
  `sync-idl: wrote ${outPath}\n` +
    `  source         ${idlPath}\n` +
    `  program        ${idl.address}\n` +
    `  instructions   ${idl.instructions.length}: ${Object.keys(instructionDiscriminators).join(", ")}\n` +
    `  accounts       ${Object.keys(accountDiscriminators).join(", ")}\n` +
    `  errors         ${errors.length}\n` +
    `sync-idl: wrote ${venuesOutPath}\n` +
    `  venues         ${Object.entries(venues.venues).map(([n, id]) => `${id}=${n}`).join(" ")}\n` +
    `  aliases        ${Object.entries(venues.aliases).map(([a, n]) => `${a}->${n}`).join(" ") || "none"}\n` +
    `  retired        ${Object.keys(venues.retired).join(", ") || "none"}\n`,
);
