/**
 * Status API client.
 *
 * The POYZ indexer answers every metric with the same envelope: `available`,
 * plus `detail` explaining why not when it is false. This client preserves that
 * distinction instead of collapsing "no data yet" into an empty object, and it
 * reads defensively -- the API is versioned by deployment, not by contract, so
 * an unexpected field is skipped rather than thrown on.
 */

import { PoyzApiError, type PoyzUnavailableError } from "./errors.js";
import { venueIdFromName } from "./accounts.js";
import type {
  CollateralAssetView,
  CollateralStatusView,
  DeltaStatusView,
  FundingStatusView,
  SourcedValue,
  VenueExposureView,
  VenueFundingView,
} from "./types.js";
import type { PoyzClientConfig } from "./config.js";

/** Read-only routes served by the POYZ status API. */
export const POYZ_API_ROUTES = {
  health: "/health",
  delta: "/api/delta",
  funding: "/api/funding",
  collateral: "/api/collateral",
  venues: "/api/hedge/venues",
  rebalances: "/api/rebalances",
  stats: "/api/stats",
} as const;

export type PoyzApiRouteName = keyof typeof POYZ_API_ROUTES;

/** The subset of `fetch` this SDK uses. Injectable for tests and edge runtimes. */
export type FetchLike = (input: string, init?: FetchInit) => Promise<FetchResponseLike>;

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/** Join a base URL and a route without producing a double slash. */
export function buildApiUrl(apiBaseUrl: string, route: string): string {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl.slice(0, -1) : apiBaseUrl;
  const path = route.startsWith("/") ? route : `/${route}`;
  return `${base}${path}`;
}

function resolveFetch(injected?: FetchLike): FetchLike {
  if (injected !== undefined) {
    return injected;
  }
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  if (typeof candidate !== "function") {
    throw new PoyzApiError(
      "",
      null,
      "no global fetch is available in this runtime; pass one to the PoyzApiClient constructor",
    );
  }
  return candidate.bind(globalThis) as FetchLike;
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function num(source: Json | null, ...keys: string[]): number | null {
  if (source === null) {
    return null;
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function bool(source: Json | null, ...keys: string[]): boolean | null {
  if (source === null) {
    return null;
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return null;
}

function str(source: Json | null, ...keys: string[]): string | null {
  if (source === null) {
    return null;
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function list(source: Json | null, ...keys: string[]): readonly Json[] {
  if (source === null) {
    return [];
  }
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) {
      return value.map(asRecord).filter((entry): entry is Json => entry !== null);
    }
  }
  return [];
}

function timestampMs(source: Json | null, ...keys: string[]): number | null {
  const raw = str(source, ...keys);
  if (raw === null) {
    return null;
  }
  const parsed = Date.parse(raw.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Percent to decimal. The API quotes percentages; this SDK exposes decimals. */
function pctToRatio(pct: number | null): number | null {
  return pct === null ? null : pct / 100;
}

function pctToBps(pct: number | null): number | null {
  return pct === null ? null : Math.round(pct * 100);
}

const NO_ENVELOPE_DETAIL = "The status API answered without a metric envelope.";

interface Envelope {
  readonly available: boolean;
  readonly detail: string | null;
  readonly observedAtMs: number | null;
  readonly estimate: boolean;
  readonly data: Json | null;
}

function readEnvelope(body: unknown): Envelope {
  const root = asRecord(body);
  if (root === null) {
    return { available: false, detail: NO_ENVELOPE_DETAIL, observedAtMs: null, estimate: false, data: null };
  }
  return {
    available: bool(root, "available") ?? false,
    detail: str(root, "detail"),
    observedAtMs: timestampMs(root, "observed_at", "observedAt"),
    estimate: bool(root, "estimate", "is_estimate") ?? false,
    data: asRecord(root["data"]),
  };
}

function sourced<T>(envelope: Envelope, data: T | null, fallbackDetail: string): SourcedValue<T> {
  const available = envelope.available && data !== null;
  return {
    source: "api",
    available,
    observedAtMs: envelope.observedAtMs,
    detail: available ? null : (envelope.detail ?? fallbackDetail),
    data: available ? data : null,
  };
}

function mapDelta(envelope: Envelope): DeltaStatusView | null {
  const data = envelope.data;
  if (data === null) {
    return null;
  }
  const deviationPct = num(data, "deviation_pct", "deviationPct");
  const thresholdPct = num(data, "threshold_pct", "thresholdPct");
  const deviationBps = pctToBps(deviationPct);
  const thresholdBps = pctToBps(thresholdPct);
  const spot = num(data, "collateral_notional_usd", "collateralNotionalUsd", "spot_notional_usd");
  const short = num(data, "hedge_notional_usd", "hedgeNotionalUsd", "short_notional_usd");

  const venues = list(data, "venues").map(mapVenue);

  return {
    capturedAtMs: envelope.observedAtMs ?? Date.now(),
    deviationRatio: pctToRatio(deviationPct),
    deviationBps,
    thresholdBps,
    withinThreshold:
      bool(data, "within_threshold", "withinThreshold") ??
      (deviationBps !== null && thresholdBps !== null ? Math.abs(deviationBps) <= thresholdBps : null),
    spotNotionalUsd: spot,
    shortNotionalUsd: short,
    rebalanceCount: num(data, "rebalances_24h", "rebalance_count", "rebalanceCount"),
    lastRebalanceAtMs: timestampMs(data, "last_rebalance_at", "lastRebalanceAt"),
    carryModel: str(data, "carry_model", "carryModel"),
    venues,
  };
}

/**
 * Map one venue entry.
 *
 * The API nests market and funding data one level down on the venues route and
 * flattens it on the delta and funding routes, so both shapes are read. A share
 * that is absent stays `null`: the protocol publishes venue data before it holds
 * any position, and a zero would read as "we hedge nothing here" rather than
 * "we have not started".
 */
/**
 * Canonical carry model name.
 *
 * The API spells the kind `funding` / `borrow_fee`; the cross-package contract
 * spells it `funding-receiving` / `borrow-fee-paying`. Normalising here keeps
 * one vocabulary in the SDK's output while an unrecognised kind still passes
 * through rather than being dropped.
 */
function normaliseCarryModel(kind: string | null): string | null {
  switch (kind) {
    case null:
      return null;
    case "funding":
    case "funding-receiving":
      return "funding-receiving";
    case "borrow_fee":
    case "borrow-fee":
    case "borrow-fee-paying":
      return "borrow-fee-paying";
    default:
      return kind;
  }
}

/**
 * Sign a carry rate from the protocol's point of view.
 *
 * The two venue kinds do not agree on sign. A funding venue reports a rate that
 * is already signed (negative when the short pays). A borrow-fee venue reports
 * the fee as a positive magnitude and says `direction: "paid"` alongside it --
 * so taking that number at face value turns a 6.14% cost into 6.14% of income.
 * `direction` is authoritative when present; without it the value is assumed to
 * be signed already.
 */
function signedCarry(annualizedPct: number | null, direction: string | null): number | null {
  if (annualizedPct === null) {
    return null;
  }
  if (direction === "paid") {
    return -Math.abs(annualizedPct);
  }
  if (direction === "received") {
    return Math.abs(annualizedPct);
  }
  return annualizedPct;
}

function mapVenue(venue: Json): VenueExposureView {
  const market = asRecord(venue["market"]);
  const funding = asRecord(venue["funding"]);
  const carry = asRecord(venue["carry"]);
  const position = asRecord(venue["position"]);
  const sharePct = num(venue, "share_pct", "sharePct", "weight_pct");
  // The carry block is authoritative when present: it is signed from the
  // protocol's point of view and states whether the leg is paid or received.
  // The funding block is the funding-model view of the same venue.
  const carryDirection = str(carry, "direction");
  const annualizedPct = signedCarry(
    num(carry, "annualized_pct") ?? num(funding, "annualized_pct") ?? num(venue, "annualized_pct", "annualizedPct"),
    carryDirection,
  );

  const name = str(venue, "venue") ?? "unknown";
  let venueId: number | null = null;
  try {
    venueId = venueIdFromName(name);
  } catch {
    // A venue the SDK has no slot for is still reported; it just cannot be
    // referenced in an on-chain proof.
    venueId = null;
  }

  return {
    venue: name,
    displayName: str(venue, "display_name", "displayName"),
    venueId,
    status: str(venue, "status"),
    market: str(market, "symbol") ?? str(venue, "market"),
    shortNotionalUsd:
      num(position, "notional_usd", "short_notional_usd") ??
      num(venue, "notional_usd", "notionalUsd", "short_notional_usd"),
    weight: sharePct === null ? null : sharePct / 100,
    carryAnnualizedRate: annualizedPct === null ? null : annualizedPct / 100,
    carryModel: normaliseCarryModel(str(carry, "kind") ?? str(venue, "carry_model", "carryModel")),
    carryDirection,
    detail: str(venue, "detail"),
  };
}

function mapFunding(envelope: Envelope): FundingStatusView | null {
  const data = envelope.data;
  if (data === null) {
    return null;
  }
  // Prefer the split figures. `apy_pct` is the older single number and is read
  // as the net only when nothing better is published, because calling a gross
  // funding figure "the rate" hides the cost leg.
  const netPct = num(data, "net_apy_pct", "net_apy", "net_carry_apy_pct", "apy_pct", "apyPct");
  const grossPct = num(data, "gross_funding_apy_pct", "gross_funding_apy", "gross_apy_pct");
  const costPct = num(data, "hedge_cost_apy_pct", "hedge_cost_apy", "borrow_fee_apy_pct");

  const venues: VenueFundingView[] = list(data, "venues")
    .map((venue) => {
      const carry = asRecord(venue["carry"]);
      const rate = signedCarry(
        num(carry, "annualized_pct") ?? num(venue, "annualized_pct", "annualizedPct"),
        str(carry, "direction"),
      );
      return rate === null
        ? null
        : {
            venue: str(venue, "venue") ?? str(venue, "display_name") ?? "unknown",
            annualizedRate: rate / 100,
            market: str(venue, "market"),
            carryModel: normaliseCarryModel(str(carry, "kind") ?? str(venue, "carry_model", "carryModel")),
          };
    })
    .filter((entry): entry is VenueFundingView => entry !== null);

  const netRate = pctToRatio(netPct);
  return {
    capturedAtMs: envelope.observedAtMs ?? Date.now(),
    netCarryRate: netRate,
    grossFundingRate: pctToRatio(grossPct),
    hedgeCostRate: pctToRatio(costPct),
    annualizedRate: netRate,
    isEstimate: bool(data, "is_estimate", "estimate") ?? envelope.estimate,
    windowHours: num(data, "window_hours", "windowHours"),
    negativeCarry: bool(data, "negative", "negative_funding") ?? (netPct === null ? null : netPct < 0),
    carryModel: str(data, "carry_model", "carryModel", "weighting"),
    venues,
  };
}

function mapCollateral(envelope: Envelope): CollateralStatusView | null {
  const data = envelope.data;
  if (data === null) {
    return null;
  }
  const assets: CollateralAssetView[] = list(data, "assets").map((asset) => ({
    symbol: str(asset, "symbol") ?? "unknown",
    amount: num(asset, "amount") ?? 0,
    usdValue: num(asset, "usd_value", "usdValue") ?? 0,
    weight: (num(asset, "share_pct", "sharePct") ?? 0) / 100,
  }));

  return {
    capturedAtMs: envelope.observedAtMs ?? Date.now(),
    totalUsd: num(data, "total_usd", "totalUsd"),
    supplyUsd: num(data, "supply_usd", "supplyUsd"),
    bufferUsd: num(data, "buffer_usd", "bufferUsd"),
    assets,
  };
}

/** Chain metadata the stats route reports about the deployment. */
export interface ApiChainInfo {
  readonly cluster: string | null;
  readonly programId: string | null;
  readonly anchorVersion: string | null;
  /** `deployed` | `not_deployed`, as the API reports it. */
  readonly programStatus: string | null;
}

/** One headline indicator from the stats route. */
export interface ApiIndicator {
  readonly available: boolean;
  readonly value: number | null;
  readonly unit: string | null;
  readonly display: string | null;
  readonly estimate: boolean;
  readonly detail: string | null;
}

/**
 * The stats route: the header indicators plus deployment metadata.
 *
 * Each indicator carries its own `available` flag, so a partly deployed protocol
 * reports exactly which numbers exist rather than one blanket state.
 */
export interface ApiStats {
  readonly delta: ApiIndicator;
  readonly collateralUsd: ApiIndicator;
  readonly fundingApy: ApiIndicator;
  readonly rebalanceCount: ApiIndicator;
  readonly deltaState: string | null;
  readonly generatedAtMs: number | null;
  readonly chain: ApiChainInfo;
}

function mapIndicator(source: Json | null): ApiIndicator {
  return {
    available: bool(source, "available") ?? false,
    value: num(source, "value"),
    unit: str(source, "unit"),
    display: str(source, "display"),
    estimate: bool(source, "estimate") ?? false,
    detail: str(source, "detail"),
  };
}

/**
 * Read-only client for the POYZ status API.
 *
 * Every method resolves; none of them throw {@link PoyzUnavailableError}. A
 * metric with no value comes back as `available: false` with the reason, which
 * is a normal state for a protocol that has not started publishing a series.
 * Transport failures do throw, because those are not a state of the protocol.
 */
export class PoyzApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(config: Pick<PoyzClientConfig, "apiBaseUrl" | "requestTimeoutMs">, fetchImpl?: FetchLike) {
    this.baseUrl = config.apiBaseUrl;
    this.timeoutMs = config.requestTimeoutMs;
    this.fetchImpl = resolveFetch(fetchImpl);
  }

  /**
   * GET a route and parse the JSON body.
   *
   * @throws PoyzApiError on a transport failure, a timeout, a non-2xx status,
   *   or a body that is not JSON.
   */
  async getJson(route: string, signal?: AbortSignal): Promise<unknown> {
    const url = buildApiUrl(this.baseUrl, route);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort);

    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new PoyzApiError(url, response.status, `${url} answered ${response.status}: ${trim(text)}`);
      }
      try {
        return JSON.parse(text) as unknown;
      } catch (cause) {
        throw new PoyzApiError(url, response.status, `${url} did not return JSON: ${trim(text)}`, { cause });
      }
    } catch (cause) {
      if (cause instanceof PoyzApiError) {
        throw cause;
      }
      const aborted = signal?.aborted === true;
      const reason = aborted ? "the caller aborted the request" : describe(cause, this.timeoutMs);
      throw new PoyzApiError(url, null, `${url} could not be reached: ${reason}`, { cause });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async getDelta(signal?: AbortSignal): Promise<SourcedValue<DeltaStatusView>> {
    const envelope = readEnvelope(await this.getJson(POYZ_API_ROUTES.delta, signal));
    return sourced(envelope, mapDelta(envelope), "The status API has no delta reading yet.");
  }

  async getFunding(signal?: AbortSignal): Promise<SourcedValue<FundingStatusView>> {
    const envelope = readEnvelope(await this.getJson(POYZ_API_ROUTES.funding, signal));
    return sourced(envelope, mapFunding(envelope), "The status API has no funding reading yet.");
  }

  async getCollateral(signal?: AbortSignal): Promise<SourcedValue<CollateralStatusView>> {
    const envelope = readEnvelope(await this.getJson(POYZ_API_ROUTES.collateral, signal));
    return sourced(envelope, mapCollateral(envelope), "The status API has no collateral reading yet.");
  }

  /** One round trip for every header indicator plus the deployment metadata. */
  async getStats(signal?: AbortSignal): Promise<ApiStats> {
    const root = asRecord(await this.getJson(POYZ_API_ROUTES.stats, signal));
    return {
      delta: mapIndicator(asRecord(root?.["delta"])),
      collateralUsd: mapIndicator(asRecord(root?.["collateral_usd"])),
      fundingApy: mapIndicator(asRecord(root?.["funding_apy"])),
      rebalanceCount: mapIndicator(asRecord(root?.["rebalance_count"])),
      deltaState: str(root, "delta_state"),
      generatedAtMs: timestampMs(root, "generated_at"),
      chain: {
        cluster: str(root, "cluster"),
        programId: str(root, "program_id"),
        anchorVersion: str(root, "anchor_version"),
        programStatus: str(root, "program_status"),
      },
    };
  }

  /**
   * Hedge venues, with their market and funding data.
   *
   * This route publishes venue data before the protocol holds any position, so
   * an entry with a null notional is normal and means exactly that.
   */
  async getVenues(signal?: AbortSignal): Promise<SourcedValue<readonly VenueExposureView[]>> {
    const envelope = readEnvelope(await this.getJson(POYZ_API_ROUTES.venues, signal));
    const venues = list(envelope.data, "venues").map(mapVenue);
    const available = envelope.available && venues.length > 0;
    return {
      source: "api",
      available,
      observedAtMs: envelope.observedAtMs,
      detail: envelope.detail ?? (available ? null : "The status API published no hedge venues."),
      data: available ? venues : null,
    };
  }

  /** Liveness of the API process itself. */
  async getHealth(signal?: AbortSignal): Promise<{ status: string; version: string | null }> {
    const root = asRecord(await this.getJson(POYZ_API_ROUTES.health, signal));
    return { status: str(root, "status") ?? "unknown", version: str(root, "version") };
  }
}

function trim(text: string, limit = 200): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}...` : collapsed;
}

function describe(cause: unknown, timeoutMs: number): string {
  if (cause instanceof Error) {
    if (cause.name === "AbortError" || cause.name === "TimeoutError") {
      return `no response within ${timeoutMs} ms`;
    }
    return cause.message;
  }
  return String(cause);
}
