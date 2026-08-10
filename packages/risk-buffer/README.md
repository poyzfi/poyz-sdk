# @poyz/risk-buffer

Insurance buffer accounting, the negative-carry playbook, and the `carry_gate` mint
decision for the POYZ synthetic dollar.

## Carry is negative right now

Carry accrues to the short leg some of the time and is paid by it the rest of the time.
On Velocity's own published SOL-PERP aggregates, measured 2026-08-09 (`_DIRECTION.md`
8-1):

| Window | Rate to the short | Annualized | POYZ short leg |
| --- | --- | --- | --- |
| 24h | `-0.012013 %/hr` | **-105.3% APR** | **pays** |
| 7d | `+0.002704 %/hr` | +23.7% APR | receives |
| 30d | `-0.004937 %/hr` | **-43.3% APR** | **pays** |
| 1y | `-0.004086 %/hr` | **-35.8% APR** | **pays** |

Three of the four windows are negative, the one-year average among them. **"A
delta-neutral book collects funding" is not a true statement about this venue at this
time.** This package is written with the negative case as the default view, not as an
edge case bolted onto a positive one, and anything rendered from it must do the same.
The constants are `MEASURED_CARRY_REGIMES` and `BASELINE_CARRY_REGIME`.

In that regime the outflow has to come from somewhere. The buffer is that somewhere, and
at the 3% target it covers about **31 days** at the one-year rate. This package measures
how long the buffer lasts, when the staker pass-through reaches zero, which defensive
stage the protocol should be in, and whether new mint is permitted at all.

**Every number this package returns is an estimate under stated assumptions.** Nothing
here is a measurement, a forecast or a promise. No buffer outlasts an indefinite negative
regime. What the buffer buys is time to deleverage, and the playbook has to start acting
long before it empties. Where the input does not support a number, the result is `null`
and the caller is expected to render nothing rather than a placeholder.

Source of record: `_DIRECTION.md` 8-1 (canonical for venues, carry and the annualization
constant); `docs/risk-spec.md` sections 1.2 through 1.5 and 6; `docs/hedge-spec.md`
section 6; `docs/architecture.md` sections 10 and 11.

## Modules

| Module | Reproduces |
| --- | --- |
| `units.ts` | `_DIRECTION` 8-1 interval and annualization math (`* 24 * 365.25`) |
| `accounting.ts` | `risk-spec` 6 and `architecture` 11 buffer flows, target and draw conditions |
| `depletion.ts` | `risk-spec` 1.2 and 1.3 runway, `estimateBufferDepletion` |
| `wipeout.ts` | `risk-spec` 1.5 ordering of carry loss before backing loss, `timeToYieldWipeout` |
| `playbook.ts` | `risk-spec` 1.5 five-stage playbook, triggers and hysteresis |
| `scenarios.ts` | the measured regimes plus the `risk-spec` 1.3 stress table, as data |
| `carry-gate.ts` | `_DIRECTION` 8-1 decision 3, `risk-spec` 1.4 mint gate |

`src/index.ts` is a barrel and re-exports all of it.

## The math

With `S` supply, `H` hedge notional, `f_h` the hourly carry rate to the short (negative
means the protocol pays), `B` the buffer, `b = B/S` and `f_d = |f_h| * 24`:

```
carry per hour  = f_h * H
carry per day   = f_h * 24 * H              funding settles hourly, so 24 intervals a day
annualized      = f_h * 24 * 365.25 * H     simple, not compounded; 8766 hours
buffer runway   = B / (|f_h| * 24 * H) = b / f_d        days, assuming H ~= S
```

### The annualization constant is `24 * 365.25 = 8766`, not 8760

`_DIRECTION.md` 8-1 fixes it and names `8760` as the wrong number. The `.25` is the
leap-year average. `HOURS_PER_YEAR` and `DAYS_PER_YEAR` are defined once in `units.ts`
with that rationale; `@poyz/funding-vault` defines the same pair with the same values in
its `apy.ts`. The two packages share no code by design, so each pins the literal against
`_DIRECTION.md` 8-1 in its own test suite -- if either drifts, its own tests fail.

**Only per-year figures moved when the basis changed.** `HOURS_PER_YEAR / DAYS_PER_YEAR`
is exactly `HOURS_PER_DAY`, so every per-day quantity -- the buffer runway above all -- is
identical under both year lengths. The runway table below is unchanged, and a test pins
that identity so it stays that way.

Concretely: a sustained `-0.01%/8h` is `-0.00125%/hr`, which is `-0.03%/day` and
**`-10.9575%/yr`**. Earlier `risk-spec` drafts printed `-10.95%/yr` for the same rate;
that is the 365-day reading, and the 0.0075-point gap is the leap-day quarter and nothing
else. It is **not** `-3.65%/yr`; that figure comes from treating the 8-hour number as a
daily one, understates the cost threefold, and is wrong under either year length. The
test suite pins all three figures explicitly, including the exclusion.

## `carry_gate` -- the protocol refuses to mint below the floor

`_DIRECTION.md` 8-1 decision 3 and `risk-spec` 1.4: minting into a negative-carry regime
adds hedge notional that bleeds the buffer, so the program reverts `mint` unless EWMA net
carry is at or above a floor. This is on-chain behaviour, not a risk paragraph. POYZ does
not print when printing does not pay.

The floor is derived from the buffer, not chosen:

```
carry_floor(daily)  = -(b / min_runway_days)
carry_floor(annual) = carry_floor(daily) * 365.25
```

Read backwards it is the definition of the runway: at exactly the floor, `b / |f_d|` is
exactly `min_runway_days`. Any admitted regime leaves at least that many days of buffer at
the observed rate, and the floor tightens by itself as the buffer drains.

At the POYZ target (`b = 3%`, `min_runway_days = 30`) the floor is `-0.1%/day`, that is
**-36.525%/yr**. Against the measured windows:

| Window | Annualized | Decision |
| --- | --- | --- |
| 24h | -105.3% | **blocked** |
| 7d | +23.7% | allowed |
| 30d | -43.3% | **blocked** |
| 1y | -35.8% | allowed, by 0.71 points of headroom |

Two of the four measured windows block new mint. The gate is not a tail-risk device; on
this data it is load-bearing today.

```ts
import { evaluateCarryGate } from "@poyz/risk-buffer";

const gate = evaluateCarryGate({
  netCarry: { basis: "hourly", rate: -0.00004086 }, // EWMA net carry, signed
  bufferFraction: 0.03,                             // b = B / S
  asOfMs: requestReceivedAtMs,                      // never read from a clock here
});

// gate.decision             "allow_mint"
// gate.mintAllowed          true
// gate.reason               "carry_at_or_above_floor"
// gate.reasonText           one English sentence, safe to render verbatim
// gate.netCarryAnnualRate   -0.35817876
// gate.carryFloorAnnualRate -0.36525
// gate.headroomAnnualRate   +0.00707124
// gate.impliedRunwayDays    30.59
```

The `basis` tag on the observation is required, not inferred: reading an 8-hour or annual
figure as an hourly one is the most common error in funding math, and here it would decide
whether the protocol may issue.

**The gate fails closed.** No carry observation, or no buffer measurement, blocks the
mint rather than admitting it on an assumed rate.

### On-chain agreement

The program compares integers and does not divide. Multiplying `f_daily >= -(b / d)`
through by `d` gives, in basis points:

```
net_carry_daily_bps * min_runway_days >= -buffer_bps
```

That is `carryGateAllowsMintBps(netCarryDailyBps, bufferBps, minRunwayDays)`, exact in
`i64`. The floating-point path exists so an off-chain caller can show the floor and the
headroom; a test holds the two against each other on every measured regime so they cannot
drift. `carryRateToDailyBps` floors toward negative infinity, so a sub-basis-point residual
always falls on the stricter side.

| Parameter | Default | Basis |
| --- | --- | --- |
| `minRunwayDays` | `30` | `risk-spec` 1.5 puts the first deleveraging action at 50-75% of target and a full mint pause at 25-50%; a month is the shortest window in which a deliberate unwind is plausible into a book whose measured open interest is a few thousand dollars (`research-notes` 1.3). A starting parameter, not a proven safe value |
| `reopenMarginAnnualRate` | `0` (no hysteresis) | At `b = 3%` the baseline regime sits only 0.707 points inside the floor, so any margin above about 70 bps/yr would flip it from allowed to blocked on the re-open path. That is a policy decision with real consequences for supply, so it is not inherited from a default; an operator who wants hysteresis chooses the number |

## Five-stage playbook (`risk-spec` 1.5)

Stages trigger on the buffer's balance **as a fraction of `bufferTargetBps`**, not as a
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
| `TIER_B_HOURLY_FUNDING_CAP` | `0.00125` (0.125%/hr) | `research-notes` 1.3. Note this is 3.0%/day, not the 0.125%/day stress column |
| `minRunwayDays` | `30` | `carry_gate`, see above |
| `reopenMarginAnnualRate` | `0` | `carry_gate`, see above |

All of them are function arguments. See `.env.example`: this package reads no environment.

## Runway against the measured regime

`MEASURED_CARRY_RUNWAY_TABLE` is `b / f_d` against the four measured windows rather than
against invented ones. Days before the buffer is exhausted:

| buffer `b` \ regime | 1y, -35.8% APR (baseline) | 30d, -43.3% APR | 24h, -105.3% APR | 7d, +23.7% APR |
| --- | --- | --- | --- | --- |
| 1.0% | 10.2 d | 8.4 d | 3.5 d | no drain |
| 1.7% (Ethena anchor) | 17.3 d | 14.3 d | 5.9 d | no drain |
| 3.0% (POYZ target) | 30.6 d | 25.3 d | 10.4 d | no drain |
| 5.0% | 51.0 d | 42.2 d | 17.3 d | no drain |

Worked by hand for the baseline cell, the core number of the product:

```
f_h  = -0.00004086            (-0.004086 %/hr, the 1y measured window)
f_d  = 0.00004086 * 24        =  0.00098064        (0.098064 %/day)
days = 0.03 / 0.00098064      =  30.5924...        days
```

A 3% buffer -- nearly twice Ethena's empirical 1.7% -- buys about **one month** at the
one-year average rate, and about ten days at the spot rate. Weeks, not years, and this is
the one-year average rather than a stress case. That is the argument for `carry_gate`: the
buffer alone cannot be the answer. The positive 7d column has no drain to run out of, so
its cells are `null` rather than a large invented number.

## Stress table (`risk-spec` 1.3)

`RISK_SPEC_RUNWAY_TABLE` uses invented round-number columns for reading sensitivity. It is
computed as `b / f_d`, not transcribed, and the test suite compares every cell against the
published table. Days of runway before the buffer is exhausted:

| buffer `b` \ daily cost `f_d` | 0.015%/day (~-5.5%/yr) | 0.030%/day (~-11%/yr) | 0.060%/day (~-22%/yr) | 0.125%/day (~-46%/yr) | 3.0%/day (Tier-B hourly cap) |
| --- | --- | --- | --- | --- | --- |
| 1.0% | 66.7 d | 33.3 d | 16.7 d | 8.0 d | 0.3 d |
| 1.7% (Ethena anchor) | 113.3 d | 56.7 d | 28.3 d | 13.6 d | 0.6 d |
| 3.0% (POYZ target) | 200.0 d | 100.0 d | 50.0 d | 24.0 d | 1.0 d |
| 5.0% | 333.3 d | 166.7 d | 83.3 d | 40.0 d | 1.7 d |

Reading it: a 1.7% buffer covers about 57 days of a moderate `-0.03%/day` regime, roughly
one FTX-scale negative episode (46 to 50 days), and about 14 days of a severe
`-0.125%/day` regime. The last column is a mathematical bound only; no market sustains the
Tier-B cap for a full day. Note that the measured 30-day and 24-hour regimes are worse
than this table's `severe` column, so the invented columns are not conservative.

These invented scenarios proxy SOL funding stress from BTC and ETH bear-market behaviour,
because a primary-source SOL-PERP series has not been obtained at the needed granularity
(`research-notes` 5). SOL is more volatile, so its negative episodes may be sharper.

## Two different events

`timeToYieldWipeout` returns both, because reporting one without the other tells half the
story. The name says "yield" because callers were written against it and the export is
stable; read it as **the positive half of net carry** and nothing more.

1. **Staker carry reaches zero.** Carry turns negative, the reward index floors at zero,
   and the buffer covers the bleed. Stakers stop receiving. Principal is intact.
2. **The buffer empties**, `b / f_d` days later. Only then does staker NAV decline, which
   is `backing_only`.

With no accrued and undistributed carry, the first event is day zero: there is nothing left
to pass through the moment carry turns negative. `daysToStakerYieldZero` measures how long
an accrued cushion lasts, `daysToBufferDepletion` measures the buffer, and `firstEvent`
says which arrives first.

## Using it from `/simulate`

```ts
import {
  BASELINE_CARRY_REGIME,
  estimateBufferDepletion,
  evaluateCarryGate,
  timeToYieldWipeout,
} from "@poyz/risk-buffer";

// Hourly carry rate to the short, signed. `null` when there is no observation.
// The measured one-year baseline, for a default the simulator can honestly show.
const hourlyFundingRate = BASELINE_CARRY_REGIME.hourlyRate; // -0.00004086

const depletion = estimateBufferDepletion({
  bufferBalanceUsd: 3_000_000,
  supplyUsd: 100_000_000,
  hourlyFundingRate,
  asOfMs: requestReceivedAtMs, // passed in; this package never reads the clock
});

// depletion.runwayDays               30.5924...
// depletion.annualizedFundingRate    -0.35817876
// depletion.dailyFundingCostUsd      98_064
// depletion.coverageFractionOfTarget 1.0      (against the default 300 bps target)
// depletion.stage                    "healthy"
// depletion.isEstimate               true
// depletion.assumptions              strings, safe to render verbatim

const wipeout = timeToYieldWipeout({
  hourlyFundingRate,
  hedgeNotionalUsd: 100_000_000,
  bufferBalanceUsd: 3_000_000,
  accruedStakerCarryUsd: 300_000,
  asOfMs: requestReceivedAtMs,
});

// wipeout.daysToStakerYieldZero  3.0592...
// wipeout.daysToBufferDepletion  30.5924...
// wipeout.firstEvent             "staker_yield_zero"

const gate = evaluateCarryGate({
  netCarry: { basis: "hourly", rate: hourlyFundingRate },
  bufferFraction: 3_000_000 / 100_000_000,
  asOfMs: requestReceivedAtMs,
});

// gate.mintAllowed  true, by 0.71 points of headroom
```

Note that "healthy" describes the buffer against its target, not the regime. The regime in
that example is the measured one-year average and it is negative.

Rendering rules for whatever consumes this:

- `insufficientData === true`, or any `null` field, means **render nothing** for that
  field. There is no fallback number and inventing one would be a fabricated figure.
- `isEstimate` is always `true`. Label the figure as an estimate wherever it appears.
- `assumptions` is never empty and is written in English for direct display. Show it next
  to the number, not behind a tooltip; the number is only meaningful with it.
- `stage` maps to `negativeFundingPlaybook(stage)` for the action set and the operator
  prose.

## Backward compatibility

No export has been removed. `HOURS_PER_YEAR` and `DAYS_PER_YEAR` changed **value** (8760
to 8766, 365 to 365.25) because `_DIRECTION.md` 8-1 fixes the basis; per-day results are
unaffected and per-year results move by 0.0685%. `HOURS_PER_YEAR_JULIAN` is now a
`@deprecated` alias of `HOURS_PER_YEAR` rather than a separate value.

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
- Carry rates are **signed decimal fractions per hour**. `-0.0000125` is `-0.00125%/hr`.
  Positive means the protocol receives carry, negative means it pays. Neither sign is the
  expected one; on the measured data, negative is the common one.
- `annualizedFundingRate` is simple, `f_h * 8766`. `HOURS_PER_YEAR_JULIAN` is retained as a
  `@deprecated` alias of `HOURS_PER_YEAR` for callers written against the earlier build;
  both are `8766`. The Julian basis is no longer an alternative to anything, it is the only
  basis this package uses.
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

The suite pins the runway table cell by cell against both the invented and the measured
columns, the `24 * 365.25 = 8766` basis together with the `-10.9575%/yr` annualization and
the explicit exclusion of the wrong `-3.65%/yr`, the identity that keeps per-day results
independent of the year length, the carry gate against every measured window in both its
floating-point and its integer form, the five stage boundaries, the hysteresis behaviour,
the insufficient-data paths, and the purity of the package: no clock reads, no network, no
external imports.

## License

MIT
