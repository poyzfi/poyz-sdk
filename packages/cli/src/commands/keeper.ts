/**
 * `poyz keeper register`, `poyz keeper bond`, `poyz keeper unbond`, `poyz keeper run`.
 *
 * A Delta Keeper posts a bond, watches the net delta, rebalances the hedge when
 * it leaves the band, and commits a proof of what it did. The bond is what makes
 * a false proof expensive: `keeper_slash` moves it into the insurance buffer
 * against a reason code and an evidence hash.
 *
 * `keeper run` in this build observes and judges; it does not trade and it does
 * not commit proofs. No hedge venue is wired into the program yet, so there is
 * no execution to attest to, and a proof for a rebalance that never happened is
 * exactly what the slash path exists to punish. The banner says this before the
 * loop starts.
 */

import { formatBaseUnits, type DeltaStatusView, type ProtocolConfigView } from "@poyz/sdk";
import { buildEnvelope, renderEnvelope } from "../envelope.js";
import { EXIT_OK, EXIT_THRESHOLD, EXIT_UNAVAILABLE, refusedError, usageError, type CliResult } from "../exit.js";
import { getBoolean, getNumber, getString, type FlagSpec } from "../flags.js";
import { clientConfig, requireKeypairPath } from "../globals.js";
import {
  deviationTone,
  formatBps,
  formatCount,
  formatTimestamp,
  formatUsd,
  heading,
  keyValues,
  row,
  sections,
  wrap,
} from "../render.js";
import { collateralMintMismatch, probeConfig, resolveAmount, type ConfigProbe } from "./amounts.js";
import { jsonResult, loadSignerFor, warn, type CommandInput, type CommandSpec } from "./support.js";
import { runWriteFlow } from "./write.js";

const DEFAULT_INTERVAL_SECONDS = 60;

const OBSERVE_ONLY =
  "This loop observes and judges only. It places no venue orders and commits no execution proof, because no hedge venue is wired into the program yet and a proof for a rebalance that did not happen is what the slash path exists to punish.";

const SLASH_TERMS = [
  "A posted bond is slashable. The protocol authority moves it into the insurance buffer against a reason code and an evidence hash. The program enforces the conditions a proof must satisfy: the sequence must match the protocol rebalance counter (ProofSequenceMismatch), the slot must be strictly greater than the last committed proof (ProofSlotNotMonotonic), and the delta after the rebalance must be inside the threshold (DeltaThresholdExceeded).",
  "A bond can be withdrawn with poyz keeper unbond, but not immediately: the unbond cooldown measured from the last committed proof must have elapsed (UnbondCooldownActive), and a partial withdrawal may not drop the bond under the protocol minimum unless it is a full exit (BondBelowMinimum).",
];

const DEPLOYMENT_NOTE =
  "If the simulation below fails because the program account does not exist, POYZ is not deployed to the cluster you addressed.";

const BOND_ACCOUNT_FLAG: FlagSpec = {
  name: "bond-account",
  type: "string",
  placeholder: "<address>",
  summary: "Bond token account. Defaults to the signer's associated token account",
};

const DECIMALS_FLAG: FlagSpec = {
  name: "decimals",
  type: "integer",
  placeholder: "<n>",
  summary: "Override the bond mint decimals instead of reading the protocol config",
};

function bondBanner(input: CommandInput, title: string, amountText: string, keeper: string, extra: readonly string[]): string {
  return sections(
    `  ${input.palette.paint("warn", title)}`,
    keyValues(
      input.palette,
      [
        row("amount", { text: amountText, tone: "warn", align: "left" }),
        row("keeper", { text: keeper, tone: "body", align: "left" }),
        row("cluster", { text: input.globals.cluster, tone: "muted", align: "left" }),
      ],
      "    ",
    ),
    [...extra, DEPLOYMENT_NOTE].map((line) => wrap(line, 76, "    ")).join("\n\n"),
  );
}

function readBondAmount(input: CommandInput, flag: string): number {
  const amount = getNumber(input.flags, flag);
  if (amount === undefined) {
    throw usageError(`--${flag} <amount> is required`, "The amount of the bond mint, in whole tokens.");
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw usageError(`--${flag} must be a positive number, got "${amount}"`);
  }
  return amount;
}

export const keeperRegisterCommand: CommandSpec = {
  path: ["keeper", "register"],
  summary: "Register as a Delta Keeper and post the initial bond",
  usage: "poyz keeper register --bond <amount> --keypair <path> [--execute]",
  flags: [
    { name: "bond", type: "number", placeholder: "<amount>", summary: "Bond to post, in whole bond-mint tokens" },
    DECIMALS_FLAG,
    BOND_ACCOUNT_FLAG,
  ],
  notes: ["The bond is slashable and locked behind the unbond cooldown. The banner states both before the prompt."],
  async run(input: CommandInput) {
    const amount = readBondAmount(input, "bond");
    const loaded = loadSignerFor(input, requireKeypairPath(input.globals));
    const client = input.ctx.createClient(clientConfig(input.globals));
    const probe = await probeConfig(client);
    const resolved = resolveAmount(input, amount, "bond", probe.config, probe.error);
    const keeperBondSource = getString(input.flags, "bond-account");
    const params = {
      keeper: loaded.publicKey,
      bondAmount: resolved.baseUnits,
      ...(keeperBondSource === undefined ? {} : { keeperBondSource }),
    };

    const minimum =
      probe.config === null
        ? []
        : [
            `The protocol minimum bond is ${formatBaseUnits(BigInt(probe.config.minKeeperBond), probe.config.bondDecimals, 6)} bond-mint tokens. Registering below it is rejected with InsufficientBond.`,
          ];

    return runWriteFlow({
      input,
      command: "keeper register",
      banner: bondBanner(
        input,
        "Keeper bond -- read before confirming",
        `${amount} bond tokens (${resolved.baseUnits} base units)`,
        loaded.publicKey,
        [...SLASH_TERMS, ...minimum],
      ),
      bannerData: {
        amount,
        decimals: resolved.decimals,
        bondAmountBaseUnits: resolved.baseUnits.toString(),
        keeper: loaded.publicKey,
        slashable: true,
        unbondCooldownSec: probe.config?.unbondCooldownSec ?? null,
      },
      confirmQuestion: `Post ${amount} bond tokens as a slashable keeper bond on ${input.globals.cluster}?`,
      buildPlan: () => client.buildKeeperRegister(params),
      simulate: (plan) => client.simulate(plan),
      send: () => client.keeperRegister({ ...params, signer: loaded.signer }),
    });
  },
};

export const keeperBondCommand: CommandSpec = {
  path: ["keeper", "bond"],
  summary: "Add to an existing keeper bond",
  usage: "poyz keeper bond --amount <n> --keypair <path> [--execute]",
  flags: [
    { name: "amount", type: "number", placeholder: "<n>", summary: "Amount to add, in whole bond-mint tokens" },
    DECIMALS_FLAG,
    BOND_ACCOUNT_FLAG,
  ],
  notes: ["Topping up raises the amount at risk from a slash as well as the amount that satisfies the minimum."],
  async run(input: CommandInput) {
    const amount = readBondAmount(input, "amount");
    const loaded = loadSignerFor(input, requireKeypairPath(input.globals));
    const client = input.ctx.createClient(clientConfig(input.globals));
    const probe = await probeConfig(client);
    const resolved = resolveAmount(input, amount, "bond", probe.config, probe.error);
    const keeperBondSource = getString(input.flags, "bond-account");
    const params = {
      keeper: loaded.publicKey,
      amount: resolved.baseUnits,
      ...(keeperBondSource === undefined ? {} : { keeperBondSource }),
    };

    return runWriteFlow({
      input,
      command: "keeper bond",
      banner: bondBanner(
        input,
        "Keeper bond top-up",
        `${amount} bond tokens (${resolved.baseUnits} base units)`,
        loaded.publicKey,
        SLASH_TERMS,
      ),
      bannerData: {
        amount,
        decimals: resolved.decimals,
        amountBaseUnits: resolved.baseUnits.toString(),
        keeper: loaded.publicKey,
      },
      confirmQuestion: `Add ${amount} bond tokens to the keeper bond on ${input.globals.cluster}?`,
      buildPlan: () => client.buildKeeperBond(params),
      simulate: (plan) => client.simulate(plan),
      send: () => client.keeperBond({ ...params, signer: loaded.signer }),
    });
  },
};

export const keeperUnbondCommand: CommandSpec = {
  path: ["keeper", "unbond"],
  summary: "Withdraw from a keeper bond after the cooldown",
  usage: "poyz keeper unbond --amount <n> --keypair <path> [--execute]",
  flags: [
    { name: "amount", type: "number", placeholder: "<n>", summary: "Amount to withdraw, in whole bond-mint tokens" },
    DECIMALS_FLAG,
    BOND_ACCOUNT_FLAG,
  ],
  notes: [
    "The program rejects a withdrawal inside the unbond cooldown with UnbondCooldownActive, and one that would leave a bond under the protocol minimum with BondBelowMinimum.",
  ],
  async run(input: CommandInput) {
    const amount = readBondAmount(input, "amount");
    const loaded = loadSignerFor(input, requireKeypairPath(input.globals));
    const client = input.ctx.createClient(clientConfig(input.globals));
    const probe = await probeConfig(client);
    const resolved = resolveAmount(input, amount, "bond", probe.config, probe.error);
    const keeperBondDestination = getString(input.flags, "bond-account");
    const params = {
      keeper: loaded.publicKey,
      amount: resolved.baseUnits,
      ...(keeperBondDestination === undefined ? {} : { keeperBondDestination }),
    };

    const cooldown =
      probe.config === null
        ? []
        : [`The configured unbond cooldown is ${probe.config.unbondCooldownSec} seconds measured from the last committed proof.`];

    return runWriteFlow({
      input,
      command: "keeper unbond",
      banner: bondBanner(
        input,
        "Keeper unbond",
        `${amount} bond tokens (${resolved.baseUnits} base units)`,
        loaded.publicKey,
        [
          "Withdrawing lowers the stake behind the proofs this keeper has already committed. A full exit deactivates the keeper.",
          ...cooldown,
        ],
      ),
      bannerData: {
        amount,
        decimals: resolved.decimals,
        amountBaseUnits: resolved.baseUnits.toString(),
        keeper: loaded.publicKey,
        unbondCooldownSec: probe.config?.unbondCooldownSec ?? null,
      },
      confirmQuestion: `Withdraw ${amount} bond tokens from the keeper bond on ${input.globals.cluster}?`,
      buildPlan: () => client.buildKeeperUnbond(params),
      simulate: (plan) => client.simulate(plan),
      send: () => client.keeperUnbond({ ...params, signer: loaded.signer }),
    });
  },
};

// -------------------------------------------------------------------- run

function runBanner(input: CommandInput, probe: ConfigProbe, intervalSeconds: number, limit: number | null): string {
  const { palette } = input;
  const config: ProtocolConfigView | null = probe.config;
  const rows = [
    row("cluster", { text: input.globals.cluster, tone: "muted", align: "left" }),
    row("interval", { text: `${intervalSeconds}s`, tone: "body", align: "left" }),
  ];
  if (config !== null) {
    rows.push(
      row("config", { text: config.address, tone: "muted", align: "left" }),
      row("minimum bond", {
        text: `${formatBaseUnits(BigInt(config.minKeeperBond), config.bondDecimals, 6)} bond tokens`,
        tone: "warn",
        align: "left",
      }),
      row("delta band", { text: `${config.deltaBandBps} bps`, tone: "body", align: "left" }),
      row("rebalance target", { text: `${config.deltaExitBps} bps`, tone: "body", align: "left" }),
      row("unbond cooldown", { text: `${config.unbondCooldownSec}s`, tone: "body", align: "left" }),
      row("registered keepers", { text: formatCount(config.keeperCount), tone: "body", align: "left" }),
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
    );
  }
  if (limit !== null) {
    rows.push(row("alert above", { text: `${limit} bps`, tone: "warn", align: "left" }));
  }

  const notes = [...SLASH_TERMS, OBSERVE_ONLY];
  if (probe.error !== null) {
    notes.push(`The protocol config could not be read, so the bond minimum and delta band above are absent: ${probe.error}`);
  }

  return sections(
    `  ${palette.paint("warn", "Delta Keeper -- read before starting")}`,
    keyValues(palette, rows, "    "),
    notes.map((note) => wrap(note, 76, "    ")).join("\n\n"),
  );
}

interface Tick {
  readonly atMs: number;
  readonly view: DeltaStatusView | null;
  readonly source: "api" | "chain";
  readonly detail: string | null;
  readonly breached: boolean;
  readonly effectiveLimit: number | null;
}

function renderTickText(input: CommandInput, tick: Tick): string {
  const { palette } = input;
  const stamp = palette.paint("muted", formatTimestamp(tick.atMs));
  if (tick.view === null) {
    return `${stamp}  ${palette.paint("warn", "delta not available")}  ${palette.paint(
      "muted",
      tick.detail ?? "upstream has not published this metric yet",
    )}`;
  }
  const view = tick.view;
  const parts: string[] = [stamp];
  if (view.deviationBps === null) {
    parts.push(palette.paint("warn", "deviation not published"));
  } else {
    parts.push(
      palette.paint(
        deviationTone(Math.abs(view.deviationBps), tick.effectiveLimit),
        `delta ${formatBps(view.deviationBps)}`,
      ),
    );
  }
  if (tick.effectiveLimit !== null) {
    parts.push(palette.paint("muted", `band ${tick.effectiveLimit} bps`));
  }
  if (view.deviationBps !== null && tick.effectiveLimit !== null) {
    parts.push(tick.breached ? palette.paint("critical", "REBALANCE") : palette.paint("balance", "PASS"));
  }
  if (view.spotNotionalUsd !== null) {
    parts.push(palette.paint("balance", `spot ${formatUsd(view.spotNotionalUsd, 0)}`));
  }
  if (view.shortNotionalUsd !== null) {
    parts.push(palette.paint("short", `short ${formatUsd(view.shortNotionalUsd, 0)}`));
  }
  const line = parts.join("  ");
  if (!tick.breached) {
    return line;
  }
  return `${line}\n${wrap(OBSERVE_ONLY, 76, "    ")}`;
}

function renderTickJson(input: CommandInput, tick: Tick): string {
  return renderEnvelope(
    buildEnvelope({
      ok: !tick.breached && tick.view !== null,
      command: "keeper run",
      cluster: input.globals.cluster,
      source: tick.source,
      available: tick.view !== null,
      observedAtMs: tick.atMs,
      data:
        tick.view === null
          ? null
          : {
              delta: tick.view,
              thresholdBps: tick.effectiveLimit,
              rebalanceRequired: tick.breached,
              committedProof: false,
            },
      error:
        tick.view === null
          ? { code: "CLI_UNAVAILABLE", message: tick.detail ?? "upstream has not published this metric yet" }
          : tick.breached
            ? {
                code: "CLI_THRESHOLD_EXCEEDED",
                message: "delta deviation is outside the band; this build does not place venue orders or commit proofs",
              }
            : null,
    }),
  );
}

export const keeperRunCommand: CommandSpec = {
  path: ["keeper", "run"],
  summary: "Watch the delta band as a Delta Keeper would",
  usage: "poyz keeper run [--interval <sec>] [--max-deviation-bps <n>] [--once] [--json]",
  flags: [
    {
      name: "interval",
      type: "number",
      placeholder: "<sec>",
      summary: `Seconds between observations (default ${DEFAULT_INTERVAL_SECONDS})`,
    },
    {
      name: "max-deviation-bps",
      type: "number",
      placeholder: "<n>",
      summary: "Band to judge against. Defaults to the protocol delta threshold",
    },
    { name: "once", type: "boolean", summary: "Observe once and exit instead of looping" },
  ],
  notes: [
    "With --json each observation is one envelope on its own line, so the loop can be piped into a log processor.",
    "Ctrl-C stops the loop cleanly. The exit code is 4 when any observation was outside the band, otherwise 0.",
  ],
  async run(input: CommandInput): Promise<CliResult> {
    const intervalSeconds = getNumber(input.flags, "interval") ?? DEFAULT_INTERVAL_SECONDS;
    if (intervalSeconds <= 0) {
      throw usageError("--interval must be greater than zero");
    }
    const once = getBoolean(input.flags, "once");
    const limitFlag = getNumber(input.flags, "max-deviation-bps");
    if (limitFlag !== undefined && limitFlag < 0) {
      throw usageError("--max-deviation-bps must not be negative");
    }

    const client = input.ctx.createClient(clientConfig(input.globals));
    const probe = await probeConfig(client);
    warn(input, collateralMintMismatch(input, probe.config));
    const banner = runBanner(input, probe, intervalSeconds, limitFlag ?? null);

    if (input.globals.json) {
      input.ctx.emitErr(`${banner}\n\n`);
    } else {
      input.ctx.emit(`${sections(heading(input.palette, "POYZ keeper run"), banner)}\n\n`);
    }

    if (!input.globals.yes) {
      const approved = await input.ctx.confirm("Start the keeper loop with the terms above?");
      if (!approved) {
        const error = refusedError(
          input.ctx.canPrompt ? "declined at the confirmation prompt" : "no terminal available to confirm on",
          input.ctx.canPrompt ? null : "Pass --yes to start without a prompt.",
        );
        if (input.globals.json) {
          return jsonResult(
            {
              ok: false,
              command: "keeper run",
              cluster: input.globals.cluster,
              source: null,
              available: false,
              observedAtMs: null,
              data: null,
              error: { code: error.code, message: error.message },
            },
            error.exitCode,
          );
        }
        return { exitCode: error.exitCode, stdout: "", stderr: `poyz: ${error.message}\n` };
      }
    }

    const controller = new AbortController();
    const release = input.ctx.onInterrupt(() => {
      controller.abort();
    });

    let breachSeen = false;
    let lastUnavailable = false;
    try {
      for (;;) {
        const sourced = await client.getDelta({ source: input.globals.source });
        const view = sourced.available ? sourced.data : null;
        const effectiveLimit = limitFlag ?? view?.thresholdBps ?? probe.config?.deltaBandBps ?? null;
        const breached =
          view !== null &&
          view.deviationBps !== null &&
          effectiveLimit !== null &&
          Math.abs(view.deviationBps) > effectiveLimit;
        if (breached) {
          breachSeen = true;
        }
        lastUnavailable = view === null;

        const tick: Tick = {
          atMs: sourced.observedAtMs ?? input.ctx.now(),
          view,
          source: sourced.source,
          detail: sourced.detail,
          breached,
          effectiveLimit,
        };
        input.ctx.emit(input.globals.json ? renderTickJson(input, tick) : `${renderTickText(input, tick)}\n`);

        if (once || controller.signal.aborted) {
          break;
        }
        await input.ctx.sleep(intervalSeconds * 1000, controller.signal);
        if (controller.signal.aborted) {
          break;
        }
      }
    } finally {
      release();
    }

    if (once && lastUnavailable) {
      return { exitCode: EXIT_UNAVAILABLE, stdout: "", stderr: "poyz: delta status is not available\n" };
    }
    if (breachSeen) {
      return {
        exitCode: EXIT_THRESHOLD,
        stdout: "",
        stderr: "poyz: delta was observed outside the band. No venue order was placed and no proof was committed.\n",
      };
    }
    return { exitCode: EXIT_OK, stdout: "", stderr: "" };
  },
};

/** Every keeper command, in help order. */
export const keeperCommands: readonly CommandSpec[] = [
  keeperRunCommand,
  keeperRegisterCommand,
  keeperBondCommand,
  keeperUnbondCommand,
];
