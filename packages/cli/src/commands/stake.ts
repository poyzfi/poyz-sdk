/**
 * `poyz stake`, `poyz unstake`, `poyz unstake withdraw`, `poyz claim`.
 *
 * Holding the synthetic dollar is holding a dollar. Staking it is what takes on
 * the funding exposure, and that exposure has two directions: in a positive
 * funding regime stakers are paid, and in a negative one the position is the one
 * carrying the cost. The banners say both.
 *
 * Leaving is two-legged, like issuance. `poyz unstake <amount>` starts a
 * cooldown and moves nothing; `poyz unstake withdraw` collects the balance once
 * the cooldown has elapsed. Neither command claims the other's effect.
 */

import type { ClaimFundingParams, RequestUnstakeParams, StakeParams, UnstakeParams } from "@poyz/sdk";
import { getString, type FlagSpec } from "../flags.js";
import { clientConfig, requireKeypairPath } from "../globals.js";
import { keyValues, row, sections, wrap } from "../render.js";
import { probeConfig, readAmountArgument, resolveAmount, type ResolvedAmount } from "./amounts.js";
import { loadSignerFor, type CommandInput, type CommandSpec } from "./support.js";
import { runWriteFlow } from "./write.js";

const SYNTHETIC_ACCOUNT_FLAG: FlagSpec = {
  name: "synthetic-account",
  type: "string",
  placeholder: "<address>",
  summary: "Synthetic token account. Defaults to the signer's associated token account",
};

const DECIMALS_FLAG: FlagSpec = {
  name: "decimals",
  type: "integer",
  placeholder: "<n>",
  summary: "Override the synthetic mint decimals instead of reading the protocol config",
};

const DEPLOYMENT_NOTE =
  "If the simulation below fails because the program account does not exist, POYZ is not deployed to the cluster you addressed.";

function stakeRows(input: CommandInput, resolved: ResolvedAmount, owner: string): string {
  return keyValues(
    input.palette,
    [
      row("amount", { text: `${resolved.amount} synthetic dollars`, tone: "body", align: "left" }),
      row("base units", {
        text: `${resolved.baseUnits} (decimals ${resolved.decimals} from ${resolved.decimalsFrom})`,
        tone: "muted",
        align: "left",
      }),
      row("owner", { text: owner, tone: "body", align: "left" }),
      row("cluster", { text: input.globals.cluster, tone: "muted", align: "left" }),
    ],
    "    ",
  );
}

function paragraphs(lines: readonly string[]): string {
  return [...lines, DEPLOYMENT_NOTE].map((line) => wrap(line, 76, "    ")).join("\n\n");
}

export const stakeCommand: CommandSpec = {
  path: ["stake"],
  summary: "Stake synthetic dollars to take the funding exposure",
  usage: "poyz stake <amount> --keypair <path> [--execute]",
  flags: [DECIMALS_FLAG, SYNTHETIC_ACCOUNT_FLAG],
  notes: [
    "Only staked balances accrue funding. That cuts both ways: a negative funding regime is borne by the staked position, not by unstaked holders.",
  ],
  async run(input: CommandInput) {
    const amount = readAmountArgument(input, "stake");
    const loaded = loadSignerFor(input, requireKeypairPath(input.globals));
    const client = input.ctx.createClient(clientConfig(input.globals));
    const probe = await probeConfig(client);
    const resolved = resolveAmount(input, amount, "synthetic", probe.config, probe.error);
    const ownerSynthetic = getString(input.flags, "synthetic-account");
    const params: StakeParams = {
      owner: loaded.publicKey,
      amount: resolved.baseUnits,
      ...(ownerSynthetic === undefined ? {} : { ownerSynthetic }),
    };

    return runWriteFlow({
      input,
      command: "stake",
      banner: sections(
        `  ${input.palette.paint("muted", "Stake")}`,
        stakeRows(input, resolved, loaded.publicKey),
        paragraphs([
          "Staking moves the balance into the protocol stake account and starts accruing the funding share. Funding is a market rate: when it turns negative the staked position carries the cost, and the risk buffer absorbs only the first loss.",
        ]),
      ),
      bannerData: {
        amount,
        decimals: resolved.decimals,
        amountBaseUnits: resolved.baseUnits.toString(),
        owner: loaded.publicKey,
      },
      confirmQuestion: `Stake ${amount} synthetic dollars on ${input.globals.cluster}?`,
      buildPlan: () => client.buildStake(params),
      simulate: (plan) => client.simulate(plan),
      send: () => client.stake({ ...params, signer: loaded.signer }),
    });
  },
};

export const unstakeCommand: CommandSpec = {
  path: ["unstake"],
  summary: "Start the unstake cooldown on part of the stake position",
  usage: "poyz unstake <amount> --keypair <path> [--execute]",
  flags: [DECIMALS_FLAG, SYNTHETIC_ACCOUNT_FLAG],
  notes: [
    "This moves nothing. The amount enters a pending balance and the protocol unstake cooldown starts; run poyz unstake withdraw once it has elapsed.",
    "The cooldown is what gives the keeper time to unwind hedge against staker outflow, so a staked balance is not liquid on demand.",
  ],
  async run(input: CommandInput) {
    const amount = readAmountArgument(input, "unstake");
    const loaded = loadSignerFor(input, requireKeypairPath(input.globals));
    const client = input.ctx.createClient(clientConfig(input.globals));
    const probe = await probeConfig(client);
    const resolved = resolveAmount(input, amount, "synthetic", probe.config, probe.error);
    const ownerSynthetic = getString(input.flags, "synthetic-account");
    const params: RequestUnstakeParams = {
      owner: loaded.publicKey,
      amount: resolved.baseUnits,
      ...(ownerSynthetic === undefined ? {} : { ownerSynthetic }),
    };
    const cooldown =
      probe.config === null ? null : `${probe.config.unstakeCooldownSec}s`;

    return runWriteFlow({
      input,
      command: "unstake",
      banner: sections(
        `  ${input.palette.paint("muted", "Unstake request")}`,
        stakeRows(input, resolved, loaded.publicKey),
        keyValues(
          input.palette,
          [
            row("cooldown", {
              text: cooldown ?? "unknown until the protocol config can be read",
              tone: "warn",
              align: "left",
            }),
          ],
          "    ",
        ),
        paragraphs([
          "Nothing is withdrawn by this command. It starts the cooldown; run poyz unstake withdraw afterwards to collect the balance. Funding stops accruing on the pending amount, and anything already accrued stays claimable through poyz claim.",
        ]),
      ),
      bannerData: {
        phase: "request",
        withdrawsSynthetic: false,
        amount,
        decimals: resolved.decimals,
        amountBaseUnits: resolved.baseUnits.toString(),
        owner: loaded.publicKey,
        unstakeCooldownSec: probe.config?.unstakeCooldownSec ?? null,
      },
      confirmQuestion: `Start the unstake cooldown on ${amount} synthetic dollars on ${input.globals.cluster}?`,
      buildPlan: () => client.buildRequestUnstake(params),
      simulate: (plan) => client.simulate(plan),
      send: () => client.requestUnstake({ ...params, signer: loaded.signer }),
    });
  },
};

export const unstakeWithdrawCommand: CommandSpec = {
  path: ["unstake", "withdraw"],
  summary: "Withdraw a pending unstake once its cooldown has elapsed",
  usage: "poyz unstake withdraw --keypair <path> [--execute]",
  flags: [SYNTHETIC_ACCOUNT_FLAG],
  notes: [
    "Takes no amount: the program withdraws whatever poyz unstake put into cooldown, and rejects the call with UnstakeCooldownActive while the clock is still running or NoPendingUnstake when there is nothing waiting.",
  ],
  async run(input: CommandInput) {
    const loaded = loadSignerFor(input, requireKeypairPath(input.globals));
    const client = input.ctx.createClient(clientConfig(input.globals));
    const ownerSynthetic = getString(input.flags, "synthetic-account");
    const params: UnstakeParams = {
      owner: loaded.publicKey,
      ...(ownerSynthetic === undefined ? {} : { ownerSynthetic }),
    };

    return runWriteFlow({
      input,
      command: "unstake withdraw",
      banner: sections(
        `  ${input.palette.paint("muted", "Unstake withdrawal")}`,
        keyValues(
          input.palette,
          [
            row("owner", { text: loaded.publicKey, tone: "body", align: "left" }),
            row("cluster", { text: input.globals.cluster, tone: "muted", align: "left" }),
          ],
          "    ",
        ),
        paragraphs([
          "Withdraws the pending unstake. The amount is whatever the earlier poyz unstake put into cooldown; this command does not choose it, and the program refuses while the cooldown is still running.",
        ]),
      ),
      bannerData: { phase: "withdraw", owner: loaded.publicKey },
      confirmQuestion: `Withdraw the pending unstake on ${input.globals.cluster}?`,
      buildPlan: () => client.buildUnstake(params),
      simulate: (plan) => client.simulate(plan),
      send: () => client.unstake({ ...params, signer: loaded.signer }),
    });
  },
};

export const claimCommand: CommandSpec = {
  path: ["claim"],
  summary: "Claim funding accrued to a stake position",
  usage: "poyz claim --keypair <path> [--execute]",
  flags: [SYNTHETIC_ACCOUNT_FLAG],
  notes: [
    "There is nothing to claim until funding has been settled to stakers, and the program says so directly with NothingToClaim rather than sending an empty transfer.",
  ],
  async run(input: CommandInput) {
    const loaded = loadSignerFor(input, requireKeypairPath(input.globals));
    const client = input.ctx.createClient(clientConfig(input.globals));
    const ownerSynthetic = getString(input.flags, "synthetic-account");
    const params: ClaimFundingParams = {
      owner: loaded.publicKey,
      ...(ownerSynthetic === undefined ? {} : { ownerSynthetic }),
    };

    return runWriteFlow({
      input,
      command: "claim",
      banner: sections(
        `  ${input.palette.paint("muted", "Claim funding")}`,
        keyValues(
          input.palette,
          [
            row("owner", { text: loaded.publicKey, tone: "body", align: "left" }),
            row("cluster", { text: input.globals.cluster, tone: "muted", align: "left" }),
          ],
          "    ",
        ),
        paragraphs([
          "Claims the funding already settled to this stake position. The amount depends on what the protocol has settled, which is a market outcome and can be zero.",
        ]),
      ),
      bannerData: { owner: loaded.publicKey },
      confirmQuestion: `Claim accrued funding on ${input.globals.cluster}?`,
      buildPlan: () => client.buildClaimFunding(params),
      simulate: (plan) => client.simulate(plan),
      send: () => client.claimFunding({ ...params, signer: loaded.signer }),
    });
  },
};
