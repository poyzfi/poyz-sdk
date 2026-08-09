/**
 * The `--json` envelope.
 *
 * One object per command invocation, always the same shape, so a caller can
 * branch on `ok` and `available` without knowing which command produced it.
 * `available: false` with `data: null` is the honest answer when upstream has
 * not published a metric; it is never padded out with zeros.
 */

export interface EnvelopeError {
  readonly code: string;
  readonly message: string;
}

export interface JsonEnvelope {
  readonly ok: boolean;
  readonly command: string;
  readonly cluster: string;
  readonly source: "api" | "chain" | null;
  readonly available: boolean;
  readonly observedAt: string | null;
  readonly data: unknown;
  readonly error: EnvelopeError | null;
}

export interface EnvelopeInput {
  readonly ok: boolean;
  readonly command: string;
  readonly cluster: string;
  readonly source?: "api" | "chain" | null;
  readonly available?: boolean;
  readonly observedAtMs?: number | null;
  readonly data?: unknown;
  readonly error?: EnvelopeError | null;
}

export function buildEnvelope(input: EnvelopeInput): JsonEnvelope {
  const observedAtMs = input.observedAtMs ?? null;
  return {
    ok: input.ok,
    command: input.command,
    cluster: input.cluster,
    source: input.source ?? null,
    available: input.available ?? false,
    observedAt: observedAtMs === null ? null : new Date(observedAtMs).toISOString(),
    data: input.data ?? null,
    error: input.error ?? null,
  };
}

/**
 * `bigint` is not representable in JSON. The SDK read models already hand back
 * `u64` values as decimal strings, but a stray `bigint` would otherwise throw
 * inside `JSON.stringify`, so it is serialised the same way.
 */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function renderEnvelope(envelope: JsonEnvelope): string {
  return `${JSON.stringify(envelope, replacer, 2)}\n`;
}
