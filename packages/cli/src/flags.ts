/**
 * Command line parsing.
 *
 * Spec driven: every flag a command accepts is declared, and anything not
 * declared is a usage error rather than a silently ignored token. A monitoring
 * job that mistypes `--max-deviation-bp` must fail loudly, not pass.
 */

import { usageError } from "./exit.js";

export type FlagType = "boolean" | "string" | "number" | "integer";

export interface FlagSpec {
  /** Long name without the leading dashes, for example `max-deviation-bps`. */
  readonly name: string;
  readonly type: FlagType;
  /** Single character alias without the leading dash. */
  readonly alias?: string;
  /** Placeholder shown in help, for example `<n>`. */
  readonly placeholder?: string;
  readonly summary: string;
}

export type FlagValue = string | number | boolean;

export interface ParsedFlags {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, FlagValue>;
}

function specFor(specs: readonly FlagSpec[], token: string, isAlias: boolean): FlagSpec | undefined {
  return specs.find((spec) => (isAlias ? spec.alias === token : spec.name === token));
}

function coerce(spec: FlagSpec, raw: string): FlagValue {
  if (spec.type === "string") {
    return raw;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw usageError(`--${spec.name} expects a number, got "${raw}"`);
  }
  if (spec.type === "integer" && !Number.isInteger(parsed)) {
    throw usageError(`--${spec.name} expects a whole number, got "${raw}"`);
  }
  return parsed;
}

/**
 * Parse `argv` against `specs`.
 *
 * `--name value`, `--name=value` and `-a value` are all accepted. A value that
 * starts with `-` is still consumed, so `--rate -0.15` works; the cost is that a
 * missing value is reported at the end of the argument list rather than early,
 * which the message makes clear.
 *
 * @throws CliError with exit code 2 on an unknown flag or a malformed value.
 */
export function parseFlags(argv: readonly string[], specs: readonly FlagSpec[]): ParsedFlags {
  const positionals: string[] = [];
  const values = new Map<string, FlagValue>();
  let terminated = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) {
      continue;
    }
    if (terminated) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      terminated = true;
      continue;
    }

    const isLong = token.startsWith("--") && token.length > 2;
    const isShort = !isLong && token.startsWith("-") && token.length === 2 && token !== "-";
    if (!isLong && !isShort) {
      if (token.startsWith("-") && token !== "-") {
        throw usageError(`unknown flag "${token}"`);
      }
      positionals.push(token);
      continue;
    }

    let name: string;
    let inline: string | undefined;
    if (isLong) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      name = eq === -1 ? body : body.slice(0, eq);
      inline = eq === -1 ? undefined : body.slice(eq + 1);
    } else {
      name = token.slice(1);
    }

    const spec = specFor(specs, name, isShort);
    if (spec === undefined) {
      throw usageError(`unknown flag "${token}"`);
    }

    if (spec.type === "boolean") {
      if (inline !== undefined) {
        if (inline !== "true" && inline !== "false") {
          throw usageError(`--${spec.name} is a switch and takes no value`);
        }
        values.set(spec.name, inline === "true");
        continue;
      }
      values.set(spec.name, true);
      continue;
    }

    let raw = inline;
    if (raw === undefined) {
      i += 1;
      raw = argv[i];
      if (raw === undefined) {
        throw usageError(`--${spec.name} expects ${spec.placeholder ?? "a value"}`);
      }
    }
    values.set(spec.name, coerce(spec, raw));
  }

  return { positionals, values };
}

export function getString(flags: ParsedFlags, name: string): string | undefined {
  const value = flags.values.get(name);
  return typeof value === "string" ? value : undefined;
}

export function getNumber(flags: ParsedFlags, name: string): number | undefined {
  const value = flags.values.get(name);
  return typeof value === "number" ? value : undefined;
}

export function getBoolean(flags: ParsedFlags, name: string): boolean {
  return flags.values.get(name) === true;
}

/** Read a flag whose value must be one of a fixed set. */
export function getEnum<T extends string>(
  flags: ParsedFlags,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const value = getString(flags, name);
  if (value === undefined) {
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw usageError(`--${name} must be one of ${allowed.join(" | ")}, got "${value}"`);
  }
  return value as T;
}

/** Render a flag table for help output. */
export function describeFlags(specs: readonly FlagSpec[], indent = "  "): string {
  const labels = specs.map((spec) => {
    const alias = spec.alias === undefined ? "" : `-${spec.alias}, `;
    const placeholder = spec.placeholder === undefined ? "" : ` ${spec.placeholder}`;
    return `${alias}--${spec.name}${placeholder}`;
  });
  const width = labels.reduce((max, label) => Math.max(max, label.length), 0);
  return specs
    .map((spec, i) => `${indent}${(labels[i] ?? "").padEnd(width)}  ${spec.summary}`)
    .join("\n");
}
