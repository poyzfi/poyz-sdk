/**
 * The shared write path: build a plan, simulate it, show both, and only then
 * consider sending.
 *
 * Two properties matter more than anything else here.
 *
 * Nothing is sent without `--execute`. A dry run still does real work -- it
 * builds the instruction and asks the cluster to simulate it -- and then exits 5
 * so a script can tell "I showed you what would happen" apart from "I did it".
 *
 * A failed simulation is reported exactly as the cluster returned it, error name
 * and message unchanged. That includes the case where the program account does
 * not exist because POYZ is not deployed to the cluster being addressed: the
 * CLI says so instead of dressing the failure up as success.
 */

import type { PoyzTransactionPlan, SendResult, SimulationResult } from "@poyz/sdk";
import { EXIT_REFUSED, EXIT_RUNTIME, refusedError, type CliResult } from "../exit.js";
import { cell, heading, keyValues, row, sections, table, wrap } from "../render.js";
import { jsonResult, mapError, textResult, type CommandInput } from "./support.js";

const MAX_LOG_LINES = 14;

export function renderPlan(input: CommandInput, plan: PoyzTransactionPlan): string {
  const { palette } = input;
  const blocks: string[] = [
    `  ${palette.paint("muted", "Transaction plan")}`,
    keyValues(
      palette,
      [
        row("description", { text: plan.description, tone: "body", align: "left" }),
        row("fee payer", { text: plan.feePayer, tone: "body", align: "left" }),
      ],
      "    ",
    ),
  ];

  plan.instructions.forEach((instruction, index) => {
    blocks.push(
      keyValues(
        palette,
        [
          row(`instruction ${index + 1}`, { text: instruction.name, tone: "balance", align: "left" }),
          row("program", { text: instruction.programId, tone: "muted", align: "left" }),
          row("data", {
            text: `0x${instruction.dataHex} (${Math.ceil(instruction.dataHex.length / 2)} bytes)`,
            tone: "muted",
            align: "left",
          }),
        ],
        "    ",
      ),
    );
    if (instruction.accounts.length > 0) {
      blocks.push(
        table(
          palette,
          [cell("Account", "muted"), cell("Role", "muted"), cell("Address", "muted")],
          instruction.accounts.map((account) => [
            cell(account.name, "body"),
            cell(
              [account.isSigner ? "signer" : null, account.isWritable ? "writable" : "readonly"]
                .filter((part): part is string => part !== null)
                .join(" "),
              "muted",
            ),
            cell(account.pubkey, "body"),
          ]),
          "    ",
        ),
      );
    }
  });

  if (plan.warnings.length > 0) {
    blocks.push(
      sections(
        `    ${palette.paint("warn", "Warnings")}`,
        plan.warnings.map((warning) => wrap(`- ${warning}`, 74, "      ")).join("\n"),
      ),
    );
  }

  return blocks.join("\n\n");
}

export function renderSimulation(input: CommandInput, simulation: SimulationResult): string {
  const { palette } = input;
  const rows = [
    row("result", {
      text: simulation.ok ? "PASS" : "FAIL",
      tone: simulation.ok ? "balance" : "critical",
      align: "left",
    }),
  ];
  if (simulation.unitsConsumed !== null) {
    rows.push(row("compute units", { text: simulation.unitsConsumed.toString(), tone: "body", align: "left" }));
  }
  if (simulation.errorName !== null) {
    rows.push(row("error", { text: simulation.errorName, tone: "critical", align: "left" }));
  }
  if (simulation.errorMessage !== null) {
    rows.push(row("message", { text: simulation.errorMessage, tone: "critical", align: "left" }));
  }

  const logs =
    simulation.logs.length === 0
      ? null
      : sections(
          `    ${palette.paint("muted", `Program logs (last ${Math.min(MAX_LOG_LINES, simulation.logs.length)})`)}`,
          simulation.logs
            .slice(-MAX_LOG_LINES)
            .map((line) => `      ${palette.paint("muted", line)}`)
            .join("\n"),
        );

  return sections(`  ${palette.paint("muted", "Simulation")}`, keyValues(palette, rows, "    "), logs);
}

export interface WriteFlow {
  readonly input: CommandInput;
  readonly command: string;
  /** Human warning block shown before the plan, for example the keeper bond terms. */
  readonly banner: string | null;
  /** Structured form of the banner, carried in the JSON envelope. */
  readonly bannerData: Record<string, unknown>;
  readonly confirmQuestion: string;
  buildPlan(): Promise<PoyzTransactionPlan>;
  simulate(plan: PoyzTransactionPlan): Promise<SimulationResult>;
  send(): Promise<SendResult>;
}

function stderrOf(extra: string | null): string {
  return extra === null ? "" : `${extra}\n`;
}

/**
 * Run the build / simulate / confirm / send sequence.
 *
 * @returns exit 0 only when a transaction was actually sent and confirmed by the
 * SDK. Exit 5 when nothing was sent, exit 1 when the simulation or the send
 * failed.
 */
export async function runWriteFlow(flow: WriteFlow): Promise<CliResult> {
  const { input, command } = flow;
  const { palette } = input;

  const plan = await flow.buildPlan();
  const simulation = await flow.simulate(plan);

  const emitJson = (
    ok: boolean,
    exitCode: number,
    error: { code: string; message: string } | null,
    sent: SendResult | null,
  ): CliResult =>
    jsonResult(
      {
        ok,
        command,
        cluster: input.globals.cluster,
        source: "chain",
        available: true,
        observedAtMs: input.ctx.now(),
        data: { ...flow.bannerData, plan, simulation, executed: sent !== null, sent },
        error,
      },
      exitCode,
      stderrOf(null),
    );

  const humanBody = (tail: string | null): string =>
    sections(
      heading(palette, `POYZ ${command}`),
      flow.banner,
      renderPlan(input, plan),
      renderSimulation(input, simulation),
      tail,
    );

  if (!simulation.ok) {
    const name = simulation.errorName ?? "SimulationFailed";
    const message = simulation.errorMessage ?? "the cluster rejected the simulated transaction";
    if (input.globals.json) {
      return emitJson(false, EXIT_RUNTIME, { code: name, message }, null);
    }
    return textResult(
      humanBody(
        wrap(
          `Simulation failed with ${name}: ${message}. Nothing was sent. The error above is the cluster's own answer, reported unchanged.`,
          78,
          "  ",
        ),
      ),
      EXIT_RUNTIME,
      stderrOf(`poyz: simulation failed: ${name}`),
    );
  }

  if (!input.globals.execute) {
    const message = "dry run: no transaction was sent. Re-run with --execute to send it.";
    if (input.globals.json) {
      return emitJson(false, EXIT_REFUSED, { code: "CLI_REFUSED", message }, null);
    }
    return textResult(
      humanBody(wrap(`Dry run. No transaction was sent. Re-run the same command with --execute to send it.`, 78, "  ")),
      EXIT_REFUSED,
      stderrOf(null),
    );
  }

  if (!input.globals.yes) {
    const approved = await input.ctx.confirm(flow.confirmQuestion);
    if (!approved) {
      const error = refusedError(
        input.ctx.canPrompt ? "declined at the confirmation prompt" : "no terminal available to confirm on",
        input.ctx.canPrompt ? null : "Pass --yes to confirm without a prompt.",
      );
      if (input.globals.json) {
        return emitJson(false, EXIT_REFUSED, { code: error.code, message: error.message }, null);
      }
      return textResult(
        humanBody(wrap("Nothing was sent.", 78, "  ")),
        EXIT_REFUSED,
        stderrOf(`poyz: ${error.message}${error.detail === null ? "" : `\n${error.detail}`}`),
      );
    }
  }

  let sent: SendResult;
  try {
    sent = await flow.send();
  } catch (error) {
    const mapped = mapError(error);
    if (input.globals.json) {
      return emitJson(false, mapped.exitCode, { code: mapped.code, message: mapped.message }, null);
    }
    return textResult(
      humanBody(null),
      mapped.exitCode,
      stderrOf(`poyz: ${mapped.message}${mapped.detail === null ? "" : `\n${mapped.detail}`}`),
    );
  }

  if (input.globals.json) {
    return emitJson(true, 0, null, sent);
  }
  return textResult(
    sections(
      humanBody(null),
      keyValues(
        palette,
        [
          row("signature", { text: sent.signature, tone: "balance", align: "left" }),
          row("cluster", { text: sent.cluster, tone: "muted", align: "left" }),
          row("explorer", { text: sent.explorerUrl, tone: "muted", align: "left" }),
        ],
        "    ",
      ),
    ),
    0,
    stderrOf(null),
  );
}
