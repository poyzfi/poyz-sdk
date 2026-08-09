#!/usr/bin/env node
/**
 * Build `dist/poyz.mjs`.
 *
 * Two steps, in this order, because a bundle that type-checks is worth more than
 * a bundle that merely exists:
 *
 * 1. `tsc --noEmit` over the whole source tree. esbuild strips types without
 *    checking them, so this is the only thing standing between a type error and
 *    a published binary.
 * 2. esbuild bundles to a single ESM file with a shebang, executable.
 *
 * `@poyz/sdk` is inlined rather than left external: it is not published to npm,
 * so a runtime dependency on it would break a clean `npm install` of this
 * package. `@solana/web3.js` stays external and is the one runtime dependency.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(packageRoot, "src", "index.ts");
const outfile = join(packageRoot, "dist", "poyz.mjs");

function typecheck() {
  const result = spawnSync("npx", ["--no-install", "tsc", "--noEmit", "-p", join(packageRoot, "tsconfig.json")], {
    cwd: packageRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error !== undefined && result.error !== null) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`tsc --noEmit failed with status ${result.status}`);
  }
}

async function bundle() {
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external: ["@solana/web3.js"],
    banner: { js: "#!/usr/bin/env node" },
    legalComments: "none",
    logLevel: "info",
  });
  chmodSync(outfile, 0o755);
}

async function run() {
  console.log("poyz-cli: typechecking");
  typecheck();
  console.log("poyz-cli: bundling");
  await bundle();
  const { size, mode } = statSync(outfile);
  console.log(`poyz-cli: wrote ${outfile} (${size} bytes, mode ${(mode & 0o777).toString(8)})`);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
