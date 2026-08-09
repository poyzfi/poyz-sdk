/**
 * Rate units, interval conversions and numeric guards shared by the risk-buffer
 * modules.
 *
 * Every rate in this package is a **signed decimal fraction**, never a
 * percentage. `-0.0000125` means -0.00125% per hour. Getting the interval wrong
 * is the most common error in funding math: a secondary source annualized
 * -0.01% per 8h as -3.65%/yr by treating the 8-hour figure as a daily figure,
 * understating the cost by a factor of three. The correct simple annualization
 * of that rate is -10.9575%/yr. These helpers exist so that conversion is
 * written once and tested against the worked example.
 *
 * Sign convention: the rate is the rate accruing **to the short leg**. Positive
 * means the protocol receives carry, negative means the protocol pays it.
 * Neither sign is the expected one: on the measured venue data carry is
 * negative on the 24h, 30d and 1y windows (`scenarios.ts`).
 */

/**
 * Funding settles hourly on the primary venue, so a day is 24 intervals
 * (`risk-spec.md` 1.2, carry math).
 */
export const HOURS_PER_DAY = 24;

/**
 * Days per year, on the Julian basis. The `.25` is the leap-year average: three
 * common years and one leap year average to 365.25 days.
 *
 * `_DIRECTION.md` 8-1 fixes this as the annualization basis for every POYZ rate
 * and calls out `8760` explicitly as the wrong number:
 *
 * ```
 * annualization : * 24 * 365.25   (not 8760)
 * ```
 *
 * `funding-vault` defines the same pair of constants with the same values. The
 * two packages deliberately share no code, so the agreement is held by hand and
 * by test; if they diverge the same funding observation produces two different
 * APRs on the same page.
 */
export const DAYS_PER_YEAR = 365.25;

/**
 * `24 * 365.25 = 8766`. The annualization factor from `_DIRECTION.md` 8-1.
 *
 * Both constants move together on purpose. `HOURS_PER_YEAR / DAYS_PER_YEAR` is
 * exactly `HOURS_PER_DAY`, so anything expressed per **day** -- the buffer
 * runway `b / f_d` above all -- is unchanged by the choice of year length. Only
 * figures quoted per year move. A test pins that identity, because breaking it
 * would silently shift the runway table.
 *
 * `365.25` is exactly representable in binary floating point (it is `1461/4`),
 * so `24 * 365.25` is exactly `8766` and `8766 / 365.25` is exactly `24`. No
 * tolerance is needed on either identity.
 */
export const HOURS_PER_YEAR = HOURS_PER_DAY * DAYS_PER_YEAR;

/**
 * @deprecated Alias of {@link HOURS_PER_YEAR}, retained so callers written
 * against the earlier build keep compiling. The Julian basis is no longer an
 * alternative to anything: it is the only basis this package uses
 * (`_DIRECTION.md` 8-1).
 */
export const HOURS_PER_YEAR_JULIAN = HOURS_PER_YEAR;

/** Legacy perp venues quote funding per 8-hour interval; the 2022 bear-market history is quoted that way. */
export const HOURS_PER_EIGHT_HOUR_INTERVAL = 8;

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** One basis point as a decimal fraction. */
export const ONE_BPS = 0.0001;

export function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number`);
  }
}

export function assertFiniteNonNegative(value: number, label: string): void {
  assertFinite(value, label);
  if (value < 0) {
    throw new RangeError(`${label} must be greater than or equal to zero`);
  }
}

/** Basis points to a decimal fraction. `300` bps becomes `0.03`. */
export function bpsToFraction(bps: number): number {
  assertFinite(bps, "bps");
  return bps * ONE_BPS;
}

/** Decimal fraction to basis points. `0.03` becomes `300`. */
export function fractionToBps(fraction: number): number {
  assertFinite(fraction, "fraction");
  return fraction / ONE_BPS;
}

/** Hourly rate to daily rate. `f_d = f_h * 24` (`risk-spec.md` 1.2). */
export function hourlyToDailyRate(hourlyRate: number): number {
  assertFinite(hourlyRate, "hourlyRate");
  return hourlyRate * HOURS_PER_DAY;
}

/**
 * Hourly rate to a simple annual rate. `f_h * 24 * 365.25` (`_DIRECTION.md`
 * 8-1, `risk-spec.md` 1.2).
 *
 * Simple, not compounded. Compounding a funding rate implies the carry is
 * reinvested into the same hedge at the same rate, which is not how the hedge is
 * operated, so the simple figure is the honest one.
 */
export function hourlyToAnnualRate(hourlyRate: number): number {
  assertFinite(hourlyRate, "hourlyRate");
  return hourlyRate * HOURS_PER_YEAR;
}

/** Daily rate to a simple annual rate. `f_d * 365.25`. */
export function dailyToAnnualRate(dailyRate: number): number {
  assertFinite(dailyRate, "dailyRate");
  return dailyRate * DAYS_PER_YEAR;
}

/**
 * A rate quoted per 8-hour interval to the hourly equivalent.
 *
 * `-0.0001` per 8h (that is -0.01%/8h, the 2022 bear-market average) becomes
 * `-0.0000125` per hour, which is `-0.03%/day` and `-10.9575%/yr`.
 *
 * On the 365-day basis the same rate reads `-10.95%/yr`, which is the figure
 * earlier drafts quoted. The 0.0075 point of difference is nothing but the
 * leap-day quarter; `-3.65%/yr` is a different thing entirely and is wrong.
 */
export function perEightHourToHourlyRate(perEightHourRate: number): number {
  assertFinite(perEightHourRate, "perEightHourRate");
  return perEightHourRate / HOURS_PER_EIGHT_HOUR_INTERVAL;
}

/** Simple annual rate back to the hourly rate. Inverse of `hourlyToAnnualRate`. */
export function annualToHourlyRate(annualRate: number): number {
  assertFinite(annualRate, "annualRate");
  return annualRate / HOURS_PER_YEAR;
}

/**
 * Buffer runway in days: `b / f_d` (`risk-spec.md` 1.2).
 *
 * `bufferFraction` is `b = B / S`, the buffer as a share of supply.
 * `dailyCostFraction` is `f_d = |f_h| * 24`, the daily funding cost as a share
 * of hedge notional, and must be a non-negative magnitude.
 *
 * **The annualization basis does not enter here.** Both inputs are per-day
 * quantities, so the runway is the same number under a 365-day year and a
 * 365.25-day year. Anything that makes the runway table move when
 * {@link DAYS_PER_YEAR} changes is a bug in the caller, not in this function.
 *
 * Returns `null` when `f_d` is zero or negative, because there is no drain to
 * run out of and a division would produce `Infinity`. Callers must treat `null`
 * as "no runway figure to show" and render nothing rather than a placeholder.
 *
 * Assumes a full hedge (`H ~= S`), the buffer as the sole first-loss layer, no
 * new mint, and a flat rate for the whole window. Those are the stated
 * assumptions of the `risk-spec.md` 1.3 stress table and they do not hold in a
 * real regime; the output is an estimate under them.
 */
export function bufferRunwayDays(
  bufferFraction: number,
  dailyCostFraction: number,
): number | null {
  assertFiniteNonNegative(bufferFraction, "bufferFraction");
  assertFinite(dailyCostFraction, "dailyCostFraction");
  if (dailyCostFraction <= 0) {
    return null;
  }
  return bufferFraction / dailyCostFraction;
}
