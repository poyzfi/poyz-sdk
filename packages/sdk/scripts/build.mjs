#!/usr/bin/env node
/**
 * Build @poyz/sdk.
 *
 * Three outputs from one source tree:
 *   dist/esm/index.js    ESM, for bundlers and modern Node
 *   dist/cjs/index.cjs   CommonJS, for `require` in older toolchains
 *   dist/types/*.d.ts    declarations, emitted by tsc
 *
 * `@poyz/risk-buffer` is bundled in rather than declared as a dependency: it is
 * a workspace package that is not published, so a consumer installing the
 * tarball could not resolve it. `@solana/web3.js` stays external, because a host
 * application will already have its own copy and two copies of `PublicKey` in
 * one process is a real source of bugs.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const dist = resolve(packageRoot, "dist");
const riskBuffer = resolve(packageRoot, "../risk-buffer");

const EXTERNAL = ["@solana/web3.js"];

function log(message) {
  process.stdout.write(`build(@poyz/sdk): ${message}\n`);
}

// The bundle inlines @poyz/risk-buffer, so its declarations have to exist for
// tsc and its JavaScript has to exist for esbuild. Building it here keeps the
// SDK buildable from a clean checkout without a documented ordering rule.
if (!existsSync(resolve(riskBuffer, "dist/index.d.ts"))) {
  log("building @poyz/risk-buffer first (its dist is missing)");
  execFileSync("npm", ["run", "build", "--workspace", "@poyz/risk-buffer"], {
    cwd: resolve(packageRoot, "../.."),
    stdio: "inherit",
  });
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = {
  entryPoints: [resolve(packageRoot, "src/index.ts")],
  bundle: true,
  platform: "neutral",
  target: ["es2022", "node20"],
  external: EXTERNAL,
  sourcemap: true,
  legalComments: "inline",
  logLevel: "warning",
};

await build({
  ...common,
  format: "esm",
  outfile: resolve(dist, "esm/index.js"),
  mainFields: ["module", "main"],
  conditions: ["import", "module", "default"],
});
log("wrote dist/esm/index.js");

await build({
  ...common,
  format: "cjs",
  outfile: resolve(dist, "cjs/index.cjs"),
  mainFields: ["main", "module"],
  conditions: ["require", "default"],
});
log("wrote dist/cjs/index.cjs");

// package.json is "type": "module", so the CommonJS output needs a marker of
// its own for any tool that resolves by directory rather than by extension.
writeFileSync(resolve(dist, "cjs/package.json"), `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`);
writeFileSync(resolve(dist, "esm/package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);

execFileSync(resolve(packageRoot, "../../node_modules/.bin/tsc"), ["-p", "tsconfig.json"], {
  cwd: packageRoot,
  stdio: "inherit",
});
log("wrote dist/types/*.d.ts");

// TypeScript decides whether a .d.ts describes an ESM or a CommonJS module from
// the nearest package.json, not from the `exports` entry that pointed at it. One
// declaration tree therefore cannot serve both: a CommonJS consumer resolving
// through the `require` condition would be told it is importing an ES module.
// So the tree is emitted once and copied, with a type marker in each copy.
cpSync(resolve(dist, "types"), resolve(dist, "types-cjs"), { recursive: true });
writeFileSync(resolve(dist, "types/package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);
writeFileSync(
  resolve(dist, "types-cjs/package.json"),
  `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`,
);
log("wrote dist/types-cjs/*.d.ts for CommonJS consumers");
