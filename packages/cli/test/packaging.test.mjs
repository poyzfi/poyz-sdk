/**
 * Packaging: the version the CLI reports, the binary the manifest points at,
 * and the action files that ship with them.
 *
 * These are the claims that go stale silently. A version bump in package.json
 * that never reaches `--version` is invisible until someone reports a bug
 * against the wrong build.
 */

import assert from "node:assert/strict";
import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CLI_VERSION, COMMANDS } from "../dist/poyz.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));

test("the reported version matches package.json", () => {
  assert.equal(CLI_VERSION, manifest.version);
});

test("the bin entry points at the built bundle, and it is executable", () => {
  assert.deepEqual(Object.keys(manifest.bin), ["poyz"]);
  const target = join(PACKAGE_ROOT, manifest.bin.poyz);
  accessSync(target, constants.X_OK);
  const first = readFileSync(target, "utf8").split("\n", 1)[0];
  assert.equal(first, "#!/usr/bin/env node");
});

test("the only runtime dependency is @solana/web3.js", () => {
  assert.deepEqual(Object.keys(manifest.dependencies), ["@solana/web3.js"]);
  assert.ok(
    "@poyz/sdk" in manifest.devDependencies,
    "@poyz/sdk is bundled at build time, so it belongs in devDependencies",
  );
});

test("everything the action needs is in the published files list", () => {
  for (const entry of ["dist", "action", "README.md"]) {
    assert.ok(manifest.files.includes(entry), `package.json files is missing ${entry}`);
  }
});

test("the action references the summarizer that ships beside it", () => {
  const action = readFileSync(join(PACKAGE_ROOT, "action", "action.yml"), "utf8");
  assert.match(action, /summarize\.mjs/);
  accessSync(join(PACKAGE_ROOT, "action", "summarize.mjs"), constants.R_OK);
  assert.doesNotMatch(
    action,
    /default:\s*["']?poyz-cli/,
    "the default must not install a package that is not published yet",
  );
});

test("the example workflow points at the action directory", () => {
  const workflow = readFileSync(join(PACKAGE_ROOT, "action", "example-workflow.yml"), "utf8");
  assert.match(workflow, /packages\/cli\/action/);
  assert.match(workflow, /max-deviation-bps/);
});

test("every command in the registry is documented in the README", () => {
  const readme = readFileSync(join(PACKAGE_ROOT, "README.md"), "utf8");
  for (const spec of COMMANDS) {
    const name = `poyz ${spec.path.join(" ")}`;
    assert.ok(readme.includes(name), `README does not mention ${name}`);
  }
});

test("no forbidden yield claim appears in the shipped text", () => {
  const forbidden = /risk-free|guaranteed yield|no risk|no downside/i;
  for (const file of ["README.md", join("action", "action.yml"), join("action", "example-workflow.yml")]) {
    const text = readFileSync(join(PACKAGE_ROOT, file), "utf8");
    assert.doesNotMatch(text, forbidden, `${file} makes a claim the protocol cannot back`);
  }
});
