/**
 * Key handling. These are regression tests for the failure mode that cannot be
 * undone: a secret key reaching a terminal, a log or a CI transcript.
 *
 * Every assertion below is "the bytes are not in the output", not "the output
 * looks right". A message that leaks the key is a security bug even when it is
 * otherwise a perfectly good error message.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT_USAGE, loadSigner, parseSecretKey, permissionWarning, runCli } from "../dist/poyz.mjs";
import { CONFIG_VIEW, makeContext } from "./helpers.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A recognisable fake secret. Every byte is 0xAB (171) so it is easy to grep for. */
const FAKE_SECRET = Array.from({ length: 64 }, () => 0xab);
const FAKE_SECRET_JSON = JSON.stringify(FAKE_SECRET);
const PUBKEY = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

function signerStub(publicKey = PUBKEY) {
  return {
    publicKey,
    async signTransaction() {
      return new Uint8Array(64);
    },
  };
}

function makeIo(content, mode = 0o600) {
  const reads = [];
  return {
    reads,
    io: {
      readFile(path) {
        reads.push(path);
        if (content === null) {
          throw new Error(`ENOENT: no such file or directory, open '${path}'`);
        }
        return content;
      },
      fileMode() {
        return mode;
      },
    },
  };
}

function unreachable() {
  throw new Error("this factory should not have been called");
}

function textOf(error) {
  return `${error.message}\n${error.detail ?? ""}`;
}

test("a valid keypair file yields only the public key", () => {
  const { io } = makeIo(FAKE_SECRET_JSON);
  const loaded = loadSigner("/keys/poyz.json", {
    io,
    makeSigner: (secret) => {
      assert.equal(secret.length, 64);
      return signerStub();
    },
    home: "/home/tester",
  });
  assert.equal(loaded.publicKey, PUBKEY);
  assert.deepEqual(loaded.warnings, []);
  assert.ok(!JSON.stringify(loaded).includes("171"), "the loaded signer must not carry the secret bytes");
});

test("the signer keeps a copy, so wiping the loader's buffer cannot corrupt it", () => {
  const { io } = makeIo(FAKE_SECRET_JSON);
  let handed = null;
  loadSigner("/keys/poyz.json", {
    io,
    makeSigner: (secret) => {
      handed = secret;
      return signerStub();
    },
    home: "/home/tester",
  });
  assert.notEqual(handed, null);
  assert.equal(handed.length, 64);
  assert.ok(
    handed.every((byte) => byte === 0xab),
    "the signer's copy must survive the loader zeroing its own buffer",
  );
});

test("a malformed keypair file never echoes its content", () => {
  const marker = "987654321";
  const { io } = makeIo(`[${marker},${marker}]`);
  assert.throws(
    () => loadSigner("/keys/poyz.json", { io, makeSigner: unreachable, home: "/home/tester" }),
    (error) => {
      assert.equal(error.exitCode, EXIT_USAGE);
      assert.ok(!textOf(error).includes(marker), `error text leaked file content: ${textOf(error)}`);
      return true;
    },
  );
});

test("invalid JSON is reported without quoting the file", () => {
  const { io } = makeIo("not json 55512345");
  assert.throws(
    () => loadSigner("/keys/poyz.json", { io, makeSigner: unreachable, home: "/home/tester" }),
    (error) => {
      assert.ok(!textOf(error).includes("55512345"), `error text leaked file content: ${textOf(error)}`);
      assert.match(error.message, /not valid JSON/);
      return true;
    },
  );
});

test("a byte out of range is reported by index, not by value", () => {
  const bad = [...FAKE_SECRET];
  bad[5] = 424242;
  const { io } = makeIo(JSON.stringify(bad));
  assert.throws(
    () => loadSigner("/keys/poyz.json", { io, makeSigner: unreachable, home: "/home/tester" }),
    (error) => {
      const text = textOf(error);
      assert.match(text, /index 5/);
      assert.ok(!text.includes("424242"), `error text leaked a value: ${text}`);
      return true;
    },
  );
});

test("an error raised while holding the key is not forwarded", () => {
  const { io } = makeIo(FAKE_SECRET_JSON);
  assert.throws(
    () =>
      loadSigner("/keys/poyz.json", {
        io,
        makeSigner: (secret) => {
          throw new Error(`bad key: ${Array.from(secret).join(",")}`);
        },
        home: "/home/tester",
      }),
    (error) => {
      const text = textOf(error);
      assert.ok(!text.includes("171,171"), `the underlying error leaked the key: ${text}`);
      assert.match(text, /not a usable Solana secret key/);
      return true;
    },
  );
});

test("the shared Solana CLI wallet directory is refused without being read", () => {
  const probe = makeIo(FAKE_SECRET_JSON);
  assert.throws(
    () =>
      loadSigner("/home/tester/.config/solana/id.json", {
        io: probe.io,
        makeSigner: unreachable,
        home: "/home/tester",
      }),
    (error) => {
      assert.equal(error.exitCode, EXIT_USAGE);
      assert.match(error.message, /refusing to read the keypair/);
      return true;
    },
  );
  assert.deepEqual(probe.reads, [], "the refused path must never be opened");
});

test("a path outside the shared wallet directory is read normally", () => {
  const probe = makeIo(FAKE_SECRET_JSON);
  const loaded = loadSigner("/home/tester/keys/poyz.json", {
    io: probe.io,
    makeSigner: () => signerStub(),
    home: "/home/tester",
  });
  assert.equal(loaded.publicKey, PUBKEY);
  assert.deepEqual(probe.reads, ["/home/tester/keys/poyz.json"]);
});

test("loose file permissions produce a warning, tight ones do not", () => {
  assert.equal(permissionWarning("/keys/poyz.json", 0o600), null);
  assert.equal(permissionWarning("/keys/poyz.json", null), null);
  const warning = permissionWarning("/keys/poyz.json", 0o644);
  assert.match(warning, /mode 644/);
  assert.match(warning, /chmod 600/);
});

test("the permission warning reaches stderr and the secret does not", async () => {
  const { ctx, err } = makeContext({
    loadSigner: () => ({
      signer: signerStub(),
      publicKey: PUBKEY,
      warnings: [permissionWarning("/keys/poyz.json", 0o644)],
    }),
    createClient: () => ({
      async getConfig() {
        return CONFIG_VIEW;
      },
      async buildMintRequest() {
        return { description: "Mint request", feePayer: PUBKEY, instructions: [], warnings: [] };
      },
      async simulate() {
        return { ok: true, unitsConsumed: 1, logs: [], errorName: null, errorMessage: null };
      },
    }),
  });
  const result = await runCli(["mint", "1", "--keypair", "/keys/poyz.json"], ctx);
  const stderr = err.join("") + result.stderr;
  assert.match(stderr, /mode 644/);
  assert.ok(!result.stdout.includes("171"), "stdout must not carry key bytes");
  assert.ok(!stderr.includes("171"), "stderr must not carry key bytes");
});

test("the permission warning is emitted even when a later step fails", async () => {
  const { ctx, err } = makeContext({
    loadSigner: () => ({
      signer: signerStub(),
      publicKey: PUBKEY,
      warnings: [permissionWarning("/keys/poyz.json", 0o666)],
    }),
    createClient: () => ({
      async getConfig() {
        throw new Error("Account does not exist");
      },
    }),
  });
  const result = await runCli(["mint", "1", "--keypair", "/keys/poyz.json"], ctx);
  assert.equal(result.exitCode, EXIT_USAGE);
  assert.match(err.join(""), /mode 666/);
});

test("a missing keypair file reports the path and nothing else", () => {
  const { io } = makeIo(null);
  assert.throws(
    () => loadSigner("/keys/missing.json", { io, makeSigner: unreachable, home: "/home/tester" }),
    (error) => {
      assert.equal(error.exitCode, EXIT_USAGE);
      assert.match(error.message, /cannot read keypair file/);
      return true;
    },
  );
});

test("parseSecretKey rejects a 32 byte seed", () => {
  assert.throws(
    () => parseSecretKey(JSON.stringify(FAKE_SECRET.slice(0, 32)), "/keys/poyz.json"),
    (error) => /32 values, expected 64/.test(error.message),
  );
});

test("no source file writes anything derived from a keypair to a stream", () => {
  const offenders = [];
  for (const root of [join(PACKAGE_ROOT, "src"), join(PACKAGE_ROOT, "src", "commands")]) {
    for (const name of readdirSync(root)) {
      if (!name.endsWith(".ts")) {
        continue;
      }
      const file = join(root, name);
      for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
        if (/(console\.(log|error|warn)|process\.std(out|err)\.write)/.test(line) && /secret|keypair|privateKey/i.test(line)) {
          offenders.push(`${file}:${index + 1}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, []);
});
