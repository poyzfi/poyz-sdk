/**
 * Unit conversion.
 *
 * On-chain amounts are integers in base units. They are converted to `number`
 * only for display; every conversion that could lose precision says so.
 */

/**
 * Convert SPL base units to whole token units for display.
 *
 * Display precision only. Above 2^53 base units the result is approximate, so
 * keep balances in `bigint` for arithmetic and call this at the edge.
 *
 * @throws RangeError when `decimals` is not a non-negative integer.
 */
export function baseUnitsToDecimal(baseUnits: bigint, decimals: number): number {
  assertDecimals(decimals);
  const divisor = 10n ** BigInt(decimals);
  const whole = baseUnits / divisor;
  const remainder = baseUnits - whole * divisor;
  return Number(whole) + Number(remainder) / Number(divisor);
}

/**
 * Convert whole token units to SPL base units, truncating toward zero.
 *
 * Truncation is deliberate: rounding up would move more collateral than the
 * caller asked for. The conversion goes through a fixed-point string rather
 * than `amount * 10 ** decimals`, because that multiplication is inexact for
 * ordinary values such as 0.1 at nine decimals.
 *
 * @throws RangeError on a non-finite amount or a malformed `decimals`.
 */
export function decimalToBaseUnits(amount: number, decimals: number): bigint {
  assertDecimals(decimals);
  if (!Number.isFinite(amount)) {
    throw new RangeError("amount must be a finite number");
  }
  return parseDecimalToBaseUnits(amount.toFixed(Math.min(decimals, 100)), decimals);
}

/**
 * Parse a decimal string into base units without going through `number`.
 *
 * Use this for user input: `parseDecimalToBaseUnits("1234567.123456789", 9)` is
 * exact where the `number` path is not.
 *
 * @throws RangeError when the text is not a decimal number, or carries more
 *   fractional digits than the mint has decimals.
 */
export function parseDecimalToBaseUnits(text: string, decimals: number): bigint {
  assertDecimals(decimals);
  const trimmed = text.trim();
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (match === null || (match[2] === "" && (match[3] ?? "") === "")) {
    throw new RangeError(`"${text}" is not a decimal number`);
  }
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2] === "" ? "0" : (match[2] as string);
  const fraction = match[3] ?? "";
  if (fraction.length > decimals) {
    const significant = fraction.slice(decimals).replace(/0+$/, "");
    if (significant.length > 0) {
      throw new RangeError(
        `"${text}" has ${fraction.length} fractional digits but the mint has only ${decimals}`,
      );
    }
  }
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  return sign * BigInt(whole + padded);
}

/**
 * Render base units as a fixed-point string.
 *
 * Exact for any u64, unlike `baseUnitsToDecimal`. Trailing zeros are dropped.
 *
 * @param maxFractionDigits Truncate the fraction to this many digits.
 */
export function formatBaseUnits(baseUnits: bigint, decimals: number, maxFractionDigits?: number): string {
  assertDecimals(decimals);
  const negative = baseUnits < 0n;
  const magnitude = negative ? -baseUnits : baseUnits;
  const divisor = 10n ** BigInt(decimals);
  const whole = (magnitude / divisor).toString();
  let fraction = (magnitude % divisor).toString().padStart(decimals, "0");
  if (maxFractionDigits !== undefined) {
    assertDecimals(maxFractionDigits);
    fraction = fraction.slice(0, maxFractionDigits);
  }
  fraction = fraction.replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fraction.length === 0 ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

/** Lamports per SOL. */
export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Convert whole SOL to lamports, truncating toward zero. */
export function solToLamports(sol: number | string): bigint {
  return typeof sol === "string" ? parseDecimalToBaseUnits(sol, 9) : decimalToBaseUnits(sol, 9);
}

/** Render lamports as a SOL string. */
export function lamportsToSol(lamports: bigint, maxFractionDigits = 9): string {
  return formatBaseUnits(lamports, 9, maxFractionDigits);
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError("decimals must be a non-negative integer");
  }
}
