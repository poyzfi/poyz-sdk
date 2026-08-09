/**
 * `poyz status` -- delta, collateral, funding and the protocol config on one
 * screen.
 *
 * Every block is optional. A block whose data was not published is left out
 * entirely rather than drawn with zeros, so the screen only ever shows numbers
 * the protocol actually reported. The protocol config is read separately from
 * the aggregated status, so a status API that is not up yet still leaves the
 * on-chain half readable, and the other way round.
 */

import { formatBaseUnits, type CollateralStatusView, type ProtocolConfigView, type ProtocolStatsView } from "@poyz/sdk";
import { clientConfig } from "../globals.js";
import {
  cell,
  formatBps,
  formatCount,
  formatPercent,
  formatTimestamp,
  formatUsd,
  fundingTone,
  heading,
  keyValues,
  row,
  sections,
  table,
  wrap,
} from "../render.js";
import { collateralMintMismatch, probeConfig } from "./amounts.js";
import {
  jsonResult,
  maybeRow,
  presentRows,
  textResult,
  unavailableResult,
  type CommandInput,
  type CommandSpec,
} from "./support.js";

const NAME = "status";

function collateralBlock(input: CommandInput, view: CollateralStatusView): string | null {
  const { palette } = input;
  const rows = presentRows([
    maybeRow("observed", formatTimestamp(view.capturedAtMs), "muted"),
    maybeRow("total", view.totalUsd === null ? null : formatUsd(view.totalUsd), "balance"),
    maybeRow("risk buffer", view.bufferUsd === null ? null : formatUsd(view.bufferUsd), "warn"),
  ]);
  if (rows.length === 0 && view.assets.length === 0) {
    return null;
  }
  const assetTable =
    view.assets.length === 0
      ? null
      : table(
          palette,
          [
            cell("Asset", "muted"),
            cell("Amount", "muted", "right"),
            cell("Value", "muted", "right"),
            cell("Weight", "muted", "right"),
          ],
          view.assets.map((asset) => [
            cell(asset.symbol, "body"),
            cell(asset.amount.toString(), "body", "right"),
            cell(formatUsd(asset.usdValue), "body", "right"),
            cell(formatPercent(asset.weight), "body", "right"),
          ]),
          "    ",
        );
  return sections(`  ${palette.paint("muted", "Collateral")}`, keyValues(palette, rows, "    "), assetTable);
}

function tokens(baseUnits: string, decimals: number): string {
  return `${formatBaseUnits(BigInt(baseUnits), decimals, 6)} (${baseUnits} base units)`;
}

function configBlock(input: CommandInput, config: ProtocolConfigView): string {
  const { palette } = input;

  const identity = keyValues(
    palette,
    presentRows([
      maybeRow("config", config.address, "body"),
      maybeRow("authority", config.authority, "muted"),
      maybeRow("collateral mint", config.collateralMint, "muted"),
      maybeRow("synthetic mint", config.syntheticMint, "muted"),
      maybeRow("bond mint", config.bondMint, "muted"),
      maybeRow("oracle", config.oracle, "muted"),
      row("vaults", {
        text: config.vaultsReady ? "ready" : "not initialized",
        tone: config.vaultsReady ? "balance" : "critical",
        align: "left",
      }),
      row("issuance", {
        text: config.mintPaused ? "paused" : "open",
        tone: config.mintPaused ? "critical" : "balance",
        align: "left",
      }),
      row("redemption", {
        text: config.redeemPaused ? "paused" : "open",
        tone: config.redeemPaused ? "critical" : "balance",
        align: "left",
      }),
    ]),
    "    ",
  );

  const balances = keyValues(
    palette,
    presentRows([
      maybeRow("collateral held", tokens(config.totalCollateral, config.collateralDecimals), "balance"),
      maybeRow("collateral pending", tokens(config.pendingCollateral, config.collateralDecimals), "warn"),
      maybeRow("synthetic supply", tokens(config.totalSynthetic, config.syntheticDecimals), "body"),
      maybeRow("redeem pending", tokens(config.pendingRedeemSynthetic, config.syntheticDecimals), "warn"),
      maybeRow("supply cap", tokens(config.maxSyntheticSupply, config.syntheticDecimals), "muted"),
      maybeRow("hedged notional", `${config.hedgedNotional} base units`, "short"),
      maybeRow("staked", tokens(config.totalStaked, config.syntheticDecimals), "body"),
      maybeRow("staker funding balance", `${config.stakerFundingBalance} base units`, "body"),
      maybeRow("insurance buffer", `${config.bufferBalance} base units`, "warn"),
    ]),
    "    ",
  );

  const keepers = keyValues(
    palette,
    presentRows([
      maybeRow("registered keepers", formatCount(config.keeperCount), "body"),
      maybeRow("minimum bond", tokens(config.minKeeperBond, config.bondDecimals), "warn"),
      maybeRow("bonded total", tokens(config.bondedTotal, config.bondDecimals), "body"),
      maybeRow("slashed total", tokens(config.slashedTotal, config.bondDecimals), "critical"),
      maybeRow("rebalances", formatCount(config.rebalanceCount), "body"),
      maybeRow("last proof slot", formatCount(config.lastProofSlot), "muted"),
      maybeRow("unbond cooldown", `${config.unbondCooldownSec}s`, "body"),
    ]),
    "    ",
  );

  const parameters = keyValues(
    palette,
    presentRows([
      maybeRow("delta band", `${config.deltaBandBps} bps`, "body"),
      maybeRow("rebalance target", `${config.deltaExitBps} bps`, "body"),
      maybeRow("collateral ratio", `${config.collateralRatioBps} bps`, "body"),
      maybeRow("mint fee", `${config.mintFeeBps} bps`, "body"),
      maybeRow("redeem fee", `${config.redeemFeeBps} bps`, "body"),
      maybeRow("buffer share", `${config.bufferShareBps} bps`, "body"),
      maybeRow("oracle confidence cap", `${config.maxConfBps} bps`, "body"),
      maybeRow("oracle staleness cap", `${config.maxPriceAgeSec}s`, "body"),
      maybeRow("request time to live", `${config.requestTtlSec}s`, "body"),
      maybeRow("settlement delay", `${config.minSettlementDelaySec}s`, "body"),
      maybeRow("unstake cooldown", `${config.unstakeCooldownSec}s`, "body"),
      maybeRow("hard delta breach", `${config.deltaHardBps} bps`, "body"),
      maybeRow("venue state max age", `${config.maxVenueStateAgeSec}s`, "body"),
    ]),
    "    ",
  );

  const fundingRows = presentRows([
    // Net carry, not funding: the program tracks the carry the authority last
    // reported for the active venue, which on a borrow-fee venue is a cost
    // rather than funding received.
    row("last net carry", {
      text: formatBps(config.lastNetCarryBps),
      tone: config.lastNetCarryBps < 0 ? "short" : "balance",
      align: "left",
    }),
    row("minimum net carry", {
      text: formatBps(config.minNetCarryBps),
      tone: "muted",
      align: "left",
    }),
    maybeRow(
      "venue state reported",
      config.venueStateAtMs === null ? null : formatTimestamp(config.venueStateAtMs),
      "muted",
    ),
    maybeRow(
      "negative since",
      config.negativeFundingSinceMs === null ? null : formatTimestamp(config.negativeFundingSinceMs),
      "short",
    ),
    maybeRow("last settled at", config.lastSettleAtMs === null ? null : formatTimestamp(config.lastSettleAtMs), "muted"),
  ]);

  return sections(
    `  ${palette.paint("muted", "Protocol")}`,
    identity,
    `  ${palette.paint("muted", "Balances")}`,
    balances,
    `  ${palette.paint("muted", "Keepers")}`,
    keepers,
    `  ${palette.paint("muted", "Parameters")}`,
    parameters,
    fundingRows.length === 0
      ? null
      : sections(`  ${palette.paint("muted", "Funding settlement")}`, keyValues(palette, fundingRows, "    ")),
    config.vaultsReady
      ? null
      : wrap(
          "The protocol vaults are not initialized, so mint, redeem and staking are rejected with VaultsNotReady until they are.",
          76,
          "    ",
        ),
  );
}

export function renderStatus(
  input: CommandInput,
  view: ProtocolStatsView | null,
  source: string | null,
  config: ProtocolConfigView | null,
  configError: string | null,
): string {
  const { palette } = input;

  const header = presentRows([
    maybeRow("cluster", view?.cluster ?? input.globals.cluster, "muted"),
    maybeRow("source", source, "muted"),
    maybeRow("program", view?.programId ?? null, "body"),
    maybeRow("anchor", view?.anchorVersion ?? null, "muted"),
  ]);

  const delta = view?.delta ?? null;
  const deltaRows =
    delta === null
      ? null
      : presentRows([
          maybeRow("observed", formatTimestamp(delta.capturedAtMs), "muted"),
          maybeRow("deviation", delta.deviationBps === null ? null : formatBps(delta.deviationBps), "body"),
          maybeRow("threshold", delta.thresholdBps === null ? null : `${delta.thresholdBps} bps`, "body"),
          delta.withinThreshold === null
            ? null
            : row("status", {
                text: delta.withinThreshold ? "PASS" : "FAIL",
                tone: delta.withinThreshold ? "balance" : "critical",
                align: "left",
              }),
          maybeRow("spot notional", delta.spotNotionalUsd === null ? null : formatUsd(delta.spotNotionalUsd), "balance"),
          maybeRow("short notional", delta.shortNotionalUsd === null ? null : formatUsd(delta.shortNotionalUsd), "short"),
        ]);

  const funding = view?.funding ?? null;
  const fundingRows =
    funding === null
      ? null
      : presentRows([
          maybeRow("observed", formatTimestamp(funding.capturedAtMs), "muted"),
          funding.netCarryRate === null
            ? null
            : row("net carry", {
                text: `${formatPercent(funding.netCarryRate, 2, true)}${funding.isEstimate ? "  estimate" : ""}`,
                tone: fundingTone(funding.netCarryRate),
                align: "left",
              }),
          funding.netCarryRate === null
            ? null
            : row("direction", {
                text: funding.netCarryRate < 0 ? "protocol pays" : "protocol receives",
                tone: funding.netCarryRate < 0 ? "short" : "balance",
                align: "left",
              }),
          funding.grossFundingRate === null
            ? null
            : row("gross funding", {
                text: formatPercent(funding.grossFundingRate, 2, true),
                tone: fundingTone(funding.grossFundingRate),
                align: "left",
              }),
          funding.hedgeCostRate === null
            ? null
            : row("hedge cost", {
                text: formatPercent(funding.hedgeCostRate, 2, true),
                tone: "short",
                align: "left",
              }),
        ]);

  const notes = view?.notes ?? [];
  const notesBlock =
    notes.length === 0
      ? null
      : sections(`  ${palette.paint("muted", "Notes")}`, notes.map((note) => wrap(note, 76, "    ")).join("\n"));

  return sections(
    heading(palette, "POYZ status"),
    keyValues(palette, header),
    deltaRows === null || deltaRows.length === 0
      ? null
      : sections(`  ${palette.paint("muted", "Delta")}`, keyValues(palette, deltaRows, "    ")),
    view?.collateral === undefined || view.collateral === null ? null : collateralBlock(input, view.collateral),
    fundingRows === null || fundingRows.length === 0
      ? null
      : sections(`  ${palette.paint("muted", "Carry")}`, keyValues(palette, fundingRows, "    ")),
    config === null ? null : configBlock(input, config),
    config !== null || configError === null
      ? null
      : wrap(`The on-chain protocol config could not be read: ${configError}`, 78, "  "),
    notesBlock,
    wrap(
      "Blocks are omitted when the protocol has not published them. Funding is a market rate and can be negative.",
      78,
      "  ",
    ),
  );
}

export const statusCommand: CommandSpec = {
  path: [NAME],
  summary: "Delta, collateral, funding and protocol config on one screen",
  usage: "poyz status [--source api|chain|auto] [--json]",
  flags: [],
  notes: [
    "The aggregated status and the on-chain config are read independently, so one being unavailable still leaves the other on screen.",
    "Passing --collateral-mint turns an assumption into an assertion: a mismatch against the deployed protocol is reported on stderr.",
  ],
  async run(input: CommandInput) {
    const client = input.ctx.createClient(clientConfig(input.globals));
    const [sourced, probe] = await Promise.all([
      client.getStats({ source: input.globals.source }),
      probeConfig(client),
    ]);

    const view = sourced.available ? sourced.data : null;
    if (view === null && probe.config === null) {
      return unavailableResult({ input, command: NAME, metric: "Protocol status", sourced });
    }

    const mismatch = collateralMintMismatch(input, probe.config);
    const stderr = mismatch === null ? "" : `${mismatch}\n`;

    if (input.globals.json) {
      return jsonResult(
        {
          ok: true,
          command: NAME,
          cluster: input.globals.cluster,
          source: sourced.source,
          available: true,
          observedAtMs: sourced.observedAtMs,
          data: { stats: view, config: probe.config, configError: probe.error },
          error: null,
        },
        0,
        stderr,
      );
    }
    return textResult(renderStatus(input, view, view === null ? null : sourced.source, probe.config, probe.error), 0, stderr);
  },
};
