# @poyz/risk-buffer

Insurance buffer accounting and the negative-funding playbook for the POYZ synthetic
dollar.

Funding accrues to the short leg some of the time, and it is negative in exactly the
conditions where holders most want dollars. In a negative regime the delta-neutral
position pays instead of receiving, and that outflow has to come from somewhere. The
buffer is that somewhere. This package measures how long the buffer lasts under a stated
regime, when staker yield reaches zero, and which defensive stage the protocol should be
operating in.

**Every number this package returns is an estimate under stated assumptions.** Nothing
here is a measurement, a forecast or a promise. `risk-spec.md` 1.4 is explicit that no
buffer outlasts an indefinite negative regime. What the buffer buys is time to
deleverage, and the playbook has to start acting long before it empties. Where the input
does not support a number, the result is `null` and the caller is expected to render
nothing rather than a placeholder.

Source of record: `docs/risk-spec.md` sections 1.3, 1.4, 1.5 and 6; `docs/hedge-spec.md`
section 6; `docs/architecture.md` sections 10 and 11.

## Modules

| Module | Reproduces |
| --- | --- |
| `units.ts` | `risk-spec` 1.3 interval and annualization math |
| `accounting.ts` | `risk-spec` 6 and `architecture` 11 buffer flows, target and draw conditions |
| `depletion.ts` | `risk-spec` 1.3 and 1.4 runway, `estimateBufferDepletion` |
| `wipeout.ts` | `risk-spec` 1.5 ordering of yield loss before backing loss, `timeToYieldWipeout` |
| `playbook.ts` | `risk-spec` 1.5 five-stage playbook, triggers and hysteresis |
| `scenarios.ts` | `risk-spec` 1.4 stress table as data |

`src/index.ts` is a barrel and re-exports all of it.

## The math

`risk-spec` 1.3, with `S` supply, `H` hedge notional, `f_h` the hourly funding rate to the
short (negative means the protocol pays), `B` the buffer, `b = B/S` and `f_d = |f_h| * 24`:

```
carry per hour  = f_h * H
carry per day   = f_h * 24 * H          funding settles hourly, so 24 intervals a day
annualized      = f_h * 8760 * H        simple, not compounded
buffer runway   = B / (|f_h| * 24 * H) = b / f_d        days, assuming H ~= S
```

Annualization must start from the correct interval. A sustained `-0.01%/8h` is
`-0.00125%/hr`, which is `-0.03%/day` and **`-10.95%/yr`**. It is not `-3.65%/yr`; that
figure comes from treating the 8-hour number as a daily one, and `risk-spec` 1.3 records
the error explicitly. `perEightHourToHourlyRate` and `hourlyToAnnualRate` exist so the
conversion is written once, and the test suite pins both figures.

## Five-stage playbook (`risk-spec` 1.5)

Stages trigger on the buffer's balance **as a fraction of `buffer_target_bps`**, not as a
fraction of supply. A 1.5% buffer is healthy against a 1.7% target and badly drained
against a 3% target.

| Buffer vs target | Stage | Actions | `pauseMint` | `mintFeeBpsDelta` | `hedgeReductionBps` | `redeemIncentiveBps` | `disclosureRequired` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `> 75%` | `healthy` | Buffer covers the bleed; the staker reward index floors at zero; monitor and publish | `false` | `0` | `0` | `0` | `false` |
| `50-75%` | `draining` | Raise `mint_fee_bps`, trim the worst-funding venue, raise the redemption incentive | `false` | `+25` | `500` | `10` | `true` |
| `25-50%` | `reduce` | Actively deleverage; cutting the hedge lowers funding cost and reintroduces bounded, disclosed directional exposure; pause new mint | `true` | `+50` | `2500` | `25` | `true` |
| `< 25%` | `halt_unwind` | Halt mint, queue and encourage redemption, controlled unwind toward a lower-leverage or unhedged posture, governance decision point | `true` | `0` | `10000` | `50` | `true` |
| `0%` | `backing_only` | Staker NAV declines; redemption at the oracle NAV of remaining collateral, which can be below one dollar; full disclosure | `true` | `0` | `10000` | `0` | `true` |

`backing_only` is the failure mode. It is in the enum, in the table and in the returned
prose because hiding it is the thing `risk-spec` exists to prevent.

### Boundary handling

Fixed here, in the code comments and in the tests, so it cannot drift:

| Fraction of target | Stage | Why |
| --- | --- | --- |
| exactly `0.75` | `draining` | The spec writes healthy as `> 75%`, so 75% is not healthy and the `50-75%` band claims it |
| exactly `0.50` | `reduce` | The spec writes both `50-75%` and `25-50%` inclusively, so 50% is genuinely ambiguous; the tie goes to the more defensive stage |
| exactly `0.25` | `reduce` | The spec writes halt as `< 25%` and reduce as `25-50%`, so 25% is unambiguously `reduce`. This is the one boundary where the more defensive stage does not win, and it is the spec's own wording |
| exactly `0` | `backing_only` | The spec gives 0% its own row |

A negative fraction is clamped to zero.

### Hysteresis

`nextStage(current, fractionOfTarget)` is history-dependent and pure, taking the current
stage as an argument. Escalation is immediate and may skip stages. Easing requires the
buffer to clear the current stage's upper edge by `easingMarginFractionOfTarget` (default
`0.05`) and then moves at most `maxEaseStepsPerTransition` stages (default `1`). A buffer
oscillating between 49% and 51% of target therefore stays in `reduce` instead of flipping
stage twice.

## Parameters and defaults

| Parameter | Default | Source |
| --- | --- | --- |
| `bufferTargetBps` | `300` (3% of supply) | `risk-spec` 6. An assumption to be re-derived from live funding data, not a proven safe level |
| `ETHENA_ANCHOR_BUFFER_BPS` | `170` | Ethena's empirical first-loss buffer, June 2026 (`research-notes` 4). A comparison point, not a recommendation |
| `healthyFractionOfTarget` | `0.75` | `risk-spec` 1.5 |
| `drainingFractionOfTarget` | `0.50` | `risk-spec` 1.5 |
| `reduceFractionOfTarget` | `0.25` | `risk-spec` 1.5 |
| `backingOnlyFractionOfTarget` | `0` | `risk-spec` 1.5 |
| `easingMarginFractionOfTarget` | `0.05` | Ours. A starting policy parameter |
| `maxEaseStepsPerTransition` | `1` | Ours. A starting policy parameter |
| `drainingMintFeeBpsDelta` / `reduceMintFeeBpsDelta` | `25` / `50` | Ours. `risk-spec` 1.5 states the direction, not the size |
| `drainingHedgeReductionBps` / `reduceHedgeReductionBps` / `haltHedgeReductionBps` | `500` / `2500` / `10000` | Ours, same caveat |
| `drainingRedeemIncentiveBps` / `reduceRedeemIncentiveBps` / `haltRedeemIncentiveBps` | `10` / `25` / `50` | Ours, same caveat |
| `TIER_B_HOURLY_FUNDING_CAP` | `0.00125` (0.125%/hr) | `risk-spec` 1.4. Note this is 3.0%/day, not the 0.125%/day stress column |

All of them are function arguments. See `.env.example`: this package reads no environment.

## Stress table (`risk-spec` 1.4)

`RISK_SPEC_RUNWAY_TABLE` is computed as `b / f_d`, not transcribed, and the test suite
compares every cell against the published table. Days of runway before the buffer is
exhausted:

| buffer `b` \ daily cost `f_d` | 0.015%/day (~-5.5%/yr) | 0.030%/day (~-11%/yr) | 0.060%/day (~-22%/yr) | 0.125%/day (~-46%/yr) | 3.0%/day (Tier-B hourly cap) |
| --- | --- | --- | --- | --- | --- |
| 1.0% | 66.7 d | 33.3 d | 16.7 d | 8.0 d | 0.3 d |
| 1.7% (Ethena anchor) | 113.3 d | 56.7 d | 28.3 d | 13.6 d | 0.6 d |
| 3.0% (POYZ target) | 200.0 d | 100.0 d | 50.0 d | 24.0 d | 1.0 d |
| 5.0% | 333.3 d | 166.7 d | 83.3 d | 40.0 d | 1.7 d |

Reading it: a 1.7% buffer covers about 57 days of a moderate `-0.03%/day` regime, roughly
one FTX-scale negative episode (46 to 50 days), and about 14 days of a severe
`-0.125%/day` regime. The last column is a mathematical bound only; no market sustains the
Tier-B cap for a full day.

The scenarios proxy SOL funding stress from BTC and ETH bear-market behaviour, because a
primary-source SOL-PERP series has not been obtained yet (`risk-spec` 1.2,
`research-notes` 5). SOL is more volatile, so its negative episodes may be sharper.

## Two different events

`timeToYieldWipeout` returns both, because reporting one without the other tells half the
story:

1. **Staker yield reaches zero.** Funding turns negative, the reward index floors at zero,
   and the buffer covers the bleed. Stakers stop earning. Principal is intact.
2. **The buffer empties**, `b / f_d` days later. Only then does staker NAV decline, which
   is `backing_only`.

With no accrued and undistributed carry, the first event is day zero: the yield is gone
the moment carry turns negative. `daysToStakerYieldZero` measures how long an accrued
cushion lasts, `daysToBufferDepletion` measures the buffer, and `firstEvent` says which
arrives first.

## Using it from `/simulate`

```ts
import { estimateBufferDepletion, timeToYieldWipeout } from "@poyz/risk-buffer";

// Hourly funding rate to the short, signed. `null` when there is no observation.
const hourlyFundingRate = -0.0000125; // -0.00125%/hr

const depletion = estimateBufferDepletion({
  bufferBalanceUsd: 1_700_000,
  supplyUsd: 100_000_000,
  hourlyFundingRate,
  asOfMs: requestReceivedAtMs, // passed in; this package never reads the clock
});

// depletion.runwayDays               56.666...
// depletion.annualizedFundingRate    -0.1095
// depletion.dailyFundingCostUsd      30_000
// depletion.coverageFractionOfTarget 0.5667   (against the default 300 bps target)
// depletion.stage                    "draining"
// depletion.isEstimate               true
// depletion.assumptions              6 strings, safe to render verbatim

const wipeout = timeToYieldWipeout({
  hourlyFundingRate,
  hedgeNotionalUsd: 100_000_000,
  bufferBalanceUsd: 1_700_000,
  accruedStakerCarryUsd: 300_000,
  asOfMs: requestReceivedAtMs,
});

// wipeout.daysToStakerYieldZero  10
// wipeout.daysToBufferDepletion  56.666...
// wipeout.firstEvent             "staker_yield_zero"
```

Rendering rules for whatever consumes this:

- `insufficientData === true`, or any `null` field, means **render nothing** for that
  field. There is no fallback number and inventing one would be a fabricated figure.
- `isEstimate` is always `true`. Label the figure as an estimate wherever it appears.
- `assumptions` is never empty and is written in English for direct display. Show it next
  to the number, not behind a tooltip; the number is only meaningful with it.
- `stage` maps to `negativeFundingPlaybook(stage)` for the action set and the operator
  prose.

## Backward compatibility

The earlier four-stage vocabulary (`nominal`, `watch`, `throttle`, `unwind`) is retained
as `LegacyPlaybookStage` and `PlaybookStage`, both `@deprecated`.
`negativeFundingPlaybook` accepts either vocabulary and always answers in the five-stage
one, with `legacyStage` carrying the nearest old name. `selectPlaybookStage`,
`projectBufferDepletion`, `requiredTopUpUsd`, `coverageRatio`, `coverageShortfallUsd`,
`BufferState`, `NegativeFundingScenario`, `BufferProjection`, `PlaybookStep`,
`PlaybookThresholds` and `DEFAULT_PLAYBOOK_THRESHOLDS` all still exist and behave as
before. The `PlaybookThresholds` fields added for the five-stage triggers are optional, so
existing threshold literals keep compiling.

## Units

- All amounts are USD.
- Funding rates are **signed decimal fractions per hour**. `-0.0000125` is `-0.00125%/hr`.
  Positive means the protocol receives carry, negative means it pays.
- `annualizedFundingRate` is simple, `f_h * 8760`. `HOURS_PER_YEAR_JULIAN` (8766) is
  exported separately for callers that must match a venue API figure annualized on
  `24 * 365.25`.
- Runway is in days. `depletesAtMs` and `stakerYieldZeroAtMs` are Unix milliseconds and are
  only produced when the caller supplies `asOfMs`.
- Coverage of supply and coverage of target are different quantities on different scales.
  Do not compare them.

## Honest framing

Every projection assumes the funding rate holds flat for the whole window, the hedge is
full (`H ~= S`), the buffer is the sole first-loss layer and no new mint arrives. Real
regimes do none of those things, and a regime that deepens shortens every number above.

The runway also says nothing about the hazards that sit outside the funding rate: venue
exploit, socialized loss, auto-deleverage of the short exactly when it is most profitable,
oracle deviation, liquidation of the hedge's margin slice, or a redemption queue moving
faster than the unwind. Those are `risk-spec` sections 2, 3 and 4, and they are correlated
with the negative-funding regime rather than independent of it. A buffer bounds losses; it
does not remove them, and it can be exhausted.

## Build and test

Built from the POYZ monorepo, not installed on its own. No runtime dependencies.

```bash
npm run build      --workspace @poyz/risk-buffer   # tsc -p tsconfig.build.json, excludes tests
npm run typecheck  --workspace @poyz/risk-buffer   # tsc --noEmit, includes tests
npm run test       --workspace @poyz/risk-buffer   # vitest run
```

The suite pins the `risk-spec` 1.4 table cell by cell, the `-10.95%/yr` annualization, the
five stage boundaries, the hysteresis behaviour, the insufficient-data paths, and the
purity of the package: no clock reads, no network, no external imports.

## License

MIT
