/**
 * Everything the commands need from the outside world, in one injectable
 * object.
 *
 * The dispatcher and the commands are pure with respect to this context: they
 * return text and an exit code and never reach for `process` directly. That is
 * what lets `test/*.test.mjs` drive real command paths, including the write
 * paths, without a network, a wallet or a captured stream.
 */

import { readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { PoyzClient, keypairSigner, type PoyzClientConfig } from "@poyz/sdk";
import type { PoyzClientLike } from "./client.js";
import type { Env } from "./globals.js";
import { loadSigner, type LoadedSigner } from "./keypair.js";

export interface CliContext {
  readonly env: Env;
  /** Whether stdout is a terminal. Drives colour and the confirmation prompt. */
  readonly isTty: boolean;
  /** Whether stdin can answer a prompt. */
  readonly canPrompt: boolean;
  /** Streaming stdout sink, for the keeper loop. Buffered commands do not use it. */
  emit(text: string): void;
  /** Streaming stderr sink. */
  emitErr(text: string): void;
  /** Ask a yes / no question. Returns false when there is no one to ask. */
  confirm(question: string): Promise<boolean>;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
  createClient(config: Partial<PoyzClientConfig>): PoyzClientLike;
  loadSigner(path: string): LoadedSigner;
  /** Register a SIGINT handler. Returns the function that removes it. */
  onInterrupt(handler: () => void): () => void;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolveSleep) => {
    if (signal?.aborted === true) {
      resolveSleep();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolveSleep();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function defaultConfirm(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) {
    return false;
  }
  // The prompt goes to stderr so that stdout stays exactly what the command
  // produced, which keeps `--json` parseable even when a prompt was shown.
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Build the real context, overriding any piece of it (the tests override most). */
export function createContext(overrides: Partial<CliContext> = {}): CliContext {
  const base: CliContext = {
    env: process.env,
    isTty: process.stdout.isTTY === true,
    canPrompt: process.stdin.isTTY === true,
    emit(text: string): void {
      process.stdout.write(text);
    },
    emitErr(text: string): void {
      process.stderr.write(text);
    },
    confirm: defaultConfirm,
    sleep: defaultSleep,
    now: () => Date.now(),
    createClient: (config: Partial<PoyzClientConfig>): PoyzClientLike => PoyzClient.create(config),
    loadSigner: (path: string): LoadedSigner =>
      loadSigner(path, {
        io: {
          readFile: (target: string): string => readFileSync(target, "utf8"),
          fileMode: (target: string): number | null => statSync(target).mode,
        },
        makeSigner: keypairSigner,
        home: process.env["HOME"],
      }),
    onInterrupt(handler: () => void): () => void {
      process.on("SIGINT", handler);
      return () => {
        process.off("SIGINT", handler);
      };
    },
  };
  return { ...base, ...overrides };
}
