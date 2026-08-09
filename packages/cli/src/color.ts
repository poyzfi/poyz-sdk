/**
 * 24-bit ANSI colour, drawn from the POYZ palette.
 *
 * Colour is a presentation detail and never carries meaning on its own: every
 * state that is coloured is also spelled out in text (PASS / FAIL, a sign, a
 * word), so a pipe, a log file or a colour-blind reader loses nothing.
 */

/** Palette roles. Hex values are the POYZ palette and must not drift. */
const RGB = {
  /** #3FBFA0 -- spot long leg, balanced state. */
  balance: [0x3f, 0xbf, 0xa0],
  /** #D6427F -- perp short leg, protocol-pays funding. */
  short: [0xd6, 0x42, 0x7f],
  /** #E5B769 -- approaching a limit, estimate labels. */
  warn: [0xe5, 0xb7, 0x69],
  /** #C7443A -- threshold breached, failure. */
  critical: [0xc7, 0x44, 0x3a],
  /** #8E96A3 -- secondary text, rules, labels. */
  muted: [0x8e, 0x96, 0xa3],
  /** #EFE7D8 -- body text. */
  body: [0xef, 0xe7, 0xd8],
} as const;

export type Tone = keyof typeof RGB | "plain";

const RESET = "\u001B[39m";
const BOLD_ON = "\u001B[1m";
const BOLD_OFF = "\u001B[22m";

export interface Palette {
  readonly enabled: boolean;
  /** Paint `text` in the given role. Returns `text` unchanged when disabled. */
  paint(tone: Tone, text: string): string;
  bold(text: string): string;
}

export function createPalette(enabled: boolean): Palette {
  return {
    enabled,
    paint(tone: Tone, text: string): string {
      if (!enabled || tone === "plain" || text.length === 0) {
        return text;
      }
      const rgb = RGB[tone];
      return `\u001B[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}${RESET}`;
    },
    bold(text: string): string {
      if (!enabled || text.length === 0) {
        return text;
      }
      return `${BOLD_ON}${text}${BOLD_OFF}`;
    },
  };
}

export interface ColorDecision {
  /** `--json` was given. JSON output is never coloured. */
  readonly json: boolean;
  /** `--no-color` was given. */
  readonly noColorFlag: boolean;
  /** Value of the `NO_COLOR` environment variable, if set. */
  readonly noColorEnv: string | undefined;
  /** Whether stdout is a terminal. */
  readonly isTty: boolean;
}

/**
 * Decide whether to emit escape sequences.
 *
 * Off for JSON, off for `--no-color`, off when `NO_COLOR` is set to a non-empty
 * value (the no-color.org convention), and off whenever stdout is not a
 * terminal so redirected output stays clean.
 */
export function shouldUseColor(decision: ColorDecision): boolean {
  if (decision.json || decision.noColorFlag) {
    return false;
  }
  if (decision.noColorEnv !== undefined && decision.noColorEnv !== "") {
    return false;
  }
  return decision.isTty;
}

const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

/** Remove escape sequences. Used to measure display width and by the tests. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}
