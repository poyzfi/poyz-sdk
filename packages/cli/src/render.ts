/**
 * Text rendering: headings, aligned label blocks, box-drawn tables, and the
 * number and time formatters they share.
 *
 * Cells carry their tone rather than pre-painted escape sequences, so widths are
 * measured on the plain text and alignment survives colour being switched on.
 */

import type { Palette, Tone } from "./color.js";

export type Align = "left" | "right";

export interface Cell {
  readonly text: string;
  readonly tone: Tone;
  readonly align: Align;
}

export function cell(text: string, tone: Tone = "plain", align: Align = "left"): Cell {
  return { text, tone, align };
}

/** A label / value pair for `keyValues`. */
export interface Row {
  readonly label: string;
  readonly value: Cell;
}

export function row(label: string, value: Cell | string): Row {
  return { label, value: typeof value === "string" ? cell(value) : value };
}

function pad(text: string, width: number, align: Align): string {
  if (text.length >= width) {
    return text;
  }
  const fill = " ".repeat(width - text.length);
  return align === "right" ? `${fill}${text}` : `${text}${fill}`;
}

function paintPadded(palette: Palette, target: Cell, width: number): string {
  return palette.paint(target.tone, pad(target.text, width, target.align));
}

/** Section heading followed by a rule the width of the title. */
export function heading(palette: Palette, title: string): string {
  return `${palette.bold(palette.paint("body", title))}\n${palette.paint("muted", "─".repeat(title.length))}`;
}

/**
 * Aligned label / value block.
 *
 * Rows whose value is `null` are dropped by the caller, never rendered as a
 * zero: a metric the protocol has not published must not look like one it has.
 */
export function keyValues(palette: Palette, rows: readonly Row[], indent = "  "): string {
  if (rows.length === 0) {
    return "";
  }
  const width = rows.reduce((max, entry) => Math.max(max, entry.label.length), 0);
  return rows
    .map((entry) => {
      const label = palette.paint("muted", pad(entry.label, width, "left"));
      return `${indent}${label}  ${palette.paint(entry.value.tone, entry.value.text)}`;
    })
    .join("\n");
}

/** Box-drawn table. Column widths come from the plain text of every cell. */
export function table(
  palette: Palette,
  headers: readonly Cell[],
  rows: readonly (readonly Cell[])[],
  indent = "  ",
): string {
  const columns = headers.length;
  const widths: number[] = headers.map((header) => header.text.length);
  for (const current of rows) {
    for (let i = 0; i < columns; i += 1) {
      const target = current[i];
      if (target !== undefined) {
        widths[i] = Math.max(widths[i] ?? 0, target.text.length);
      }
    }
  }

  const rule = (left: string, mid: string, right: string): string =>
    palette.paint("muted", left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right);

  const bar = palette.paint("muted", "│");
  const renderRow = (cells: readonly Cell[]): string => {
    const painted = widths.map((width, i) => {
      const target = cells[i] ?? cell("");
      return ` ${paintPadded(palette, target, width)} `;
    });
    return `${indent}${bar}${painted.join(bar)}${bar}`;
  };

  return [
    `${indent}${rule("┌", "┬", "┐")}`,
    renderRow(headers),
    `${indent}${rule("├", "┼", "┤")}`,
    ...rows.map(renderRow),
    `${indent}${rule("└", "┴", "┘")}`,
  ].join("\n");
}

/** Join sections, collapsing the blanks left by sections that rendered nothing. */
export function sections(...parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null && part.length > 0).join("\n\n");
}

/** Wrap a paragraph at `width` columns without breaking words. */
export function wrap(text: string, width = 78, indent = ""): string {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= width - indent.length) {
      line = `${line} ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) {
    lines.push(line);
  }
  return lines.map((entry) => `${indent}${entry}`).join("\n");
}

/** Wrap a list item so continuation lines hang under the text, not the marker. */
export function bullet(text: string, width = 78, indent = "  ", marker = "- "): string {
  const hanging = `${indent}${" ".repeat(marker.length)}`;
  const wrapped = wrap(text, width - marker.length, hanging);
  return `${indent}${marker}${wrapped.slice(hanging.length)}`;
}

// ---------------------------------------------------------------- formatters

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `1234.5` -> `$1,234.50`. Negative values keep the sign in front of the mark. */
export function formatUsd(value: number, fractionDigits = 2): string {
  const negative = value < 0;
  const fixed = Math.abs(value).toFixed(fractionDigits);
  const parts = fixed.split(".");
  const whole = group(parts[0] ?? "0");
  const fraction = parts[1] === undefined ? "" : `.${parts[1]}`;
  return `${negative ? "-" : ""}$${whole}${fraction}`;
}

/** `0.1234` -> `12.34%`. Pass `signed` for rates where the sign is the message. */
export function formatPercent(rate: number, fractionDigits = 2, signed = false): string {
  const percent = rate * 100;
  const sign = signed && percent > 0 ? "+" : "";
  return `${sign}${percent.toFixed(fractionDigits)}%`;
}

/** Signed basis points, for delta deviation where the direction matters. */
export function formatBps(bps: number, fractionDigits = 0): string {
  const sign = bps > 0 ? "+" : "";
  return `${sign}${bps.toFixed(fractionDigits)} bps`;
}

export function formatCount(value: number): string {
  return group(Math.trunc(value).toString());
}

/** Epoch milliseconds -> `2026-08-09 11:59:03 UTC`. */
export function formatTimestamp(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

export function formatIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Shorten a base58 address for table cells. Never used for a contract address. */
export function shortAddress(address: string): string {
  if (address.length <= 16) {
    return address;
  }
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

/** Tone for a signed funding rate: green when received, magenta when paid. */
export function fundingTone(annualizedRate: number): Tone {
  return annualizedRate < 0 ? "short" : "balance";
}

/** Tone for a delta deviation measured against its threshold. */
export function deviationTone(absBps: number, thresholdBps: number | null): Tone {
  if (thresholdBps === null || thresholdBps <= 0) {
    return "body";
  }
  if (absBps > thresholdBps) {
    return "critical";
  }
  if (absBps > thresholdBps * 0.75) {
    return "warn";
  }
  return "balance";
}
