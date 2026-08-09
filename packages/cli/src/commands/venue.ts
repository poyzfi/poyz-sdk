/**
 * `poyz venue list`, `poyz venue report`.
 *
 * The protocol is fail-closed on venue state: issuance is rejected while the
 * reading is missing, older than `max_venue_state_age_sec`, or short of the
 * capacity the supply would need. So a stale reading is not a cosmetic gap, it
 * is a halted mint, and these commands exist to make that visible and fixable.
 *
 * `report` is signed by the protocol authority, not by a keeper. It is grouped
 * under `venue` rather than `keeper` for that reason: putting an
 * authority-signed instruction under a keeper command would tell a keeper it can
 * run something it cannot sign.
 */

import {
  VENUE_ALIASES,
  VENUE_ID_MAX_ASSIGNABLE,
  VENUE_ID_UNSET,
  VENUE_RETIRED,
  VENUE_SLOTS,
  isVenueEnabled,
  requireVenueId,
  venueName,
  type ProtocolConfigView,
  type ReportVenueStateParams,
} from "@poyz/sdk";
import { getNumber, getString, type FlagSpec } from "../flags.js";
import { clientConfig, requireKeypairPath } from "../globals.js";
import { EXIT_OK, EXIT_UNAVAILABLE, usageError, type CliResult } from "../exit.js";
import { cell, heading, keyValues, row, sections, table, wrap } from "../render.js";
import { formatBps, formatTimestamp } from "../render.js";
import { loadSignerFor, textResult, jsonResult, type CommandInput, type CommandSpec } from "./support.js";
import { runWriteFlow } from "./write.js";

const VENUE_FLAG: FlagSpec = {
  name: "venue",
  type: "string",
  placeholder: "<name|slot>",
  summary: "Venue name or slot number. Names resolve through the program's published contract",
};

const CARRY_FLAG: FlagSpec = {
  name: "net-carry-bps",
  type: "integer",
  placeholder: "<bps>",
  summary: "Net carry the venue currently offers, signed, in basis points",
};

const CAPACITY_FLAG: FlagSpec = {
  name: "capacity",
  type: "integer",
  placeholder: "<base-units>",
  summary: "Hedge capacity available at the venue, in synthetic base units",
};

/**
 * Resolve `--venue` to a slot.
 *
 * Accepts a slot number as well as a name, because an operator reading a proof
 * account sees the number. A retired venue is refused with the reason the
 * program published rather than mapped to anything.
 */
function resolveVenue(input: CommandInput): number {
  const raw = getString(input.flags, "venue");
  if (raw === undefined) {
    throw usageError(
      "venue report needs --venue. Names: " +
        Object.keys(VENUE_SLOTS)
          .filter((name) => VENUE_SLOTS[name] !== VENUE_ID_UNSET)
          .join(", "),
    );
  }
  if (/^\d+$/.test(raw.trim())) {
    const slot = Number.parseInt(raw.trim(), 10);
    if (slot === VENUE_ID_UNSET) {
      throw usageError(
        `venue slot ${VENUE_ID_UNSET} is the unset value and the program rejects it. Slots start at 1.`,
      );
    }
    return slot;
  }
  try {
    // Strict on purpose: this name came from a flag a person typed, so a
    // misspelling is worth reporting here rather than surfacing later as
    // "venue id 0 is the unset value".
    return requireVenueId(raw);
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
}

function venueRows(config: ProtocolConfigView | null): readonly (readonly [string, string, string, string])[] {
  const out: (readonly [string, string, string, string])[] = [];
  for (let slot = 1; slot <= VENUE_ID_MAX_ASSIGNABLE; slot += 1) {
    const name = venueName(slot);
    const enabled = config === null ? "unknown" : isVenueEnabled(config.venueFlags, slot) ? "enabled" : "disabled";
    const active = config !== null && config.lastVenueId === slot ? "yes" : config === null ? "unknown" : "no";
    out.push([String(slot), name, enabled, active] as const);
  }
  return out;
}

export const venueListCommand: CommandSpec = {
  path: ["venue", "list"],
  summary: "Hedge venue slots, which are enabled, and how fresh the last reading is",
  usage: "poyz venue list [--json]",
  flags: [],
  notes: [
    "Slot numbering starts at 1. Slot 0 is the unset u8 value and the program rejects it, so a venue_id that was never written cannot be mistaken for the primary venue.",
    "Issuance is rejected while the venue reading is missing or older than the configured maximum age, so a stale reading here means minting is halted.",
  ],
  async run(input: CommandInput): Promise<CliResult> {
    const client = input.ctx.createClient(clientConfig(input.globals));
    let config: ProtocolConfigView | null = null;
    let detail: string | null = null;
    try {
      config = await client.getConfig();
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }

    const ageSeconds =
      config === null || config.venueStateAtMs === null
        ? null
        : Math.round((input.ctx.now() - config.venueStateAtMs) / 1000);
    const stale =
      config === null || ageSeconds === null ? null : ageSeconds > config.maxVenueStateAgeSec;

    // The slot table always renders: it comes from the program's published
    // contract, not from the chain. The live reading is what decides the exit
    // code, because a missing or stale reading means issuance is halted, and a
    // script that read exit 0 here would call a halted protocol healthy.
    const exitCode = config === null || stale === true ? EXIT_UNAVAILABLE : EXIT_OK;

    if (input.globals.json) {
      return jsonResult({
        ok: exitCode === EXIT_OK,
        command: "venue list",
        cluster: input.globals.cluster,
        source: config === null ? null : "chain",
        available: config !== null,
        observedAtMs: config?.venueStateAtMs ?? null,
        data: {
          slots: venueRows(config).map(([slot, name, enabled, active]) => ({
            slot: Number(slot),
            venue: name,
            enabled,
            lastReported: active === "yes",
          })),
          aliases: VENUE_ALIASES,
          retired: VENUE_RETIRED,
          venueFlags: config?.venueFlags ?? null,
          lastVenueId: config?.lastVenueId ?? null,
          netCarryBps: config?.lastNetCarryBps ?? null,
          capacityNotional: config?.venueCapacityNotional ?? null,
          reportedAgeSeconds: ageSeconds,
          maxAgeSeconds: config?.maxVenueStateAgeSec ?? null,
          stale,
        },
        error:
          detail !== null
            ? { code: "CLI_UNAVAILABLE", message: detail }
            : stale === true
              ? {
                  code: "CLI_UNAVAILABLE",
                  message:
                    `The venue reading is ${ageSeconds}s old and the protocol accepts at most ` +
                    `${config?.maxVenueStateAgeSec}s, so mint requests are rejected until it is refreshed.`,
                }
              : null,
      }, exitCode);
    }

    const { palette } = input;
    const blocks = [
      heading(palette, "POYZ hedge venues"),
      table(
        palette,
        [cell("Slot", "muted", "right"), cell("Venue", "muted"), cell("Flag", "muted"), cell("Last reported", "muted")],
        venueRows(config).map(([slot, name, enabled, active]) => [
          cell(slot, "muted", "right"),
          cell(name, "body"),
          cell(enabled, enabled === "enabled" ? "balance" : "muted"),
          cell(active, active === "yes" ? "balance" : "muted"),
        ]),
      ),
    ];

    if (config !== null) {
      blocks.push(
        `  ${palette.paint("muted", "Last reading")}`,
        keyValues(
          palette,
          [
            row("net carry", {
              text: formatBps(config.lastNetCarryBps),
              tone: config.lastNetCarryBps < 0 ? "short" : "balance",
              align: "left",
            }),
            row("minimum accepted", { text: formatBps(config.minNetCarryBps), tone: "muted", align: "left" }),
            row("capacity", { text: `${config.venueCapacityNotional} base units`, tone: "body", align: "left" }),
            row("reported at", {
              text: config.venueStateAtMs === null ? "never" : formatTimestamp(config.venueStateAtMs),
              tone: config.venueStateAtMs === null ? "critical" : "muted",
              align: "left",
            }),
            row("age", {
              text: ageSeconds === null ? "unknown" : `${ageSeconds}s of ${config.maxVenueStateAgeSec}s allowed`,
              tone: stale === true ? "critical" : "body",
              align: "left",
            }),
            row("issuance", {
              text: stale === true ? "blocked by a stale reading" : config.mintPaused ? "paused" : "open",
              tone: stale === true || config.mintPaused ? "critical" : "balance",
              align: "left",
            }),
          ],
          "    ",
        ),
      );
    } else if (detail !== null) {
      blocks.push(wrap(`Protocol config not read: ${detail}`, 78, "  "));
    }

    if (Object.keys(VENUE_RETIRED).length > 0) {
      blocks.push(
        `  ${palette.paint("muted", "Retired")}`,
        Object.entries(VENUE_RETIRED)
          .map(([name, reason]) => wrap(`${name}: ${reason}`, 74, "    "))
          .join("\n"),
      );
    }

    if (stale === true && config !== null) {
      blocks.push(
        wrap(
          `The venue reading is ${ageSeconds}s old and the protocol accepts at most ` +
            `${config.maxVenueStateAgeSec}s. Mint requests are rejected until poyz venue report ` +
            "refreshes it.",
          78,
          "  ",
        ),
      );
    }

    return textResult(sections(...blocks), exitCode);
  },
};

export const venueReportCommand: CommandSpec = {
  path: ["venue", "report"],
  summary: "Report a venue's net carry and capacity. Protocol authority only",
  usage: "poyz venue report --venue <name> --net-carry-bps <n> --capacity <n> --keypair <path> [--execute]",
  flags: [VENUE_FLAG, CARRY_FLAG, CAPACITY_FLAG],
  notes: [
    "Signed by the protocol authority, not by a keeper. A keeper key cannot send this.",
    "The protocol is fail-closed on this reading: while it is missing, stale past the configured maximum age, or short of the capacity the supply needs, mint requests are rejected. This is a recurring feed, not a one-off setting.",
    "Report what the venue actually offers. Overstating capacity lets the protocol issue more than the hedge can absorb, which is the failure the cap exists to prevent.",
  ],
  async run(input: CommandInput): Promise<CliResult> {
    const venueId = resolveVenue(input);
    const netCarryBps = getNumber(input.flags, "net-carry-bps");
    const capacity = getNumber(input.flags, "capacity");
    if (netCarryBps === undefined) {
      throw usageError("venue report needs --net-carry-bps. It is signed, so a cost is negative.");
    }
    if (capacity === undefined || capacity < 0) {
      throw usageError("venue report needs --capacity as a non-negative number of synthetic base units.");
    }

    const loaded = loadSignerFor(input, requireKeypairPath(input.globals));
    const client = input.ctx.createClient(clientConfig(input.globals));
    const params: ReportVenueStateParams = {
      authority: loaded.publicKey,
      venueId,
      netCarryBps,
      capacityNotional: BigInt(Math.trunc(capacity)),
    };

    return runWriteFlow({
      input,
      command: "venue report",
      banner: sections(
        `  ${input.palette.paint("muted", "Venue state report")}`,
        keyValues(
          input.palette,
          [
            row("venue", { text: `${venueName(venueId)} (slot ${venueId})`, tone: "body", align: "left" }),
            row("net carry", {
              text: formatBps(netCarryBps),
              tone: netCarryBps < 0 ? "short" : "balance",
              align: "left",
            }),
            row("capacity", { text: `${capacity} base units`, tone: "body", align: "left" }),
            row("authority", { text: loaded.publicKey, tone: "body", align: "left" }),
            row("cluster", { text: input.globals.cluster, tone: "muted", align: "left" }),
          ],
          "    ",
        ),
        [
          "Issuance stays blocked while this reading is missing or older than the configured maximum age, so this is a feed the protocol depends on rather than a setting.",
          "If the simulation below fails because the program account does not exist, POYZ is not deployed to the cluster you addressed.",
        ]
          .map((line) => wrap(line, 76, "    "))
          .join("\n\n"),
      ),
      bannerData: {
        venueId,
        venue: venueName(venueId),
        netCarryBps,
        capacityNotional: String(Math.trunc(capacity)),
        authority: loaded.publicKey,
      },
      confirmQuestion: `Report ${venueName(venueId)} at ${formatBps(netCarryBps)} on ${input.globals.cluster}?`,
      buildPlan: () => client.buildReportVenueState(params),
      simulate: (plan) => client.simulate(plan),
      send: () => client.reportVenueState({ ...params, signer: loaded.signer }),
    });
  },
};

