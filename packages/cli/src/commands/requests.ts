/**
 * `poyz mint`, `poyz mint cancel`, `poyz redeem`, `poyz redeem cancel`.
 *
 * Issuance is two-phase on-chain and the CLI says so in every place a reader
 * could otherwise assume otherwise.
 *
 * `poyz mint <amount>` submits a **request**: the protocol takes the collateral
 * into a pending request account and nothing is issued yet. A keeper opens the
 * offsetting perp short and calls `mint_confirm` with the fill; only then does
 * the synthetic dollar exist. If no keeper confirms before the request expires,
 * the depositor reclaims the collateral with `poyz mint cancel --nonce <n>`.
 * Redemption mirrors it: request, keeper unwinds the matching short, confirm.
 *
 * The nonce is the handle for the request account, so it is printed whenever the
 * CLI picks one.
 */

import type { MintCancelParams, MintRequestParams, RedeemCancelParams, RedeemRequestParams } from "@poyz/sdk";
import { getString, type FlagSpec } from "../flags.js";
import { clientConfig, requireKeypairPath } from "../globals.js";
import { keyValues, row, sections, wrap } from "../render.js";
import {
  collateralMintMismatch,
  probeConfig,
  readAmountArgument,
  readMinOut,
  readNonce,
  resolveAmount,
  type ResolvedAmount,
} from "./amounts.js";
import { loadSignerFor, warn, type CommandInput, type CommandSpec } from "./support.js";
import { runWriteFlow } from "./write.js";

const NONCE_FLAG: FlagSpec = {
  name: "nonce",
  type: "string",
  placeholder: "<n>",
  summary: "Request nonce. Generated and printed when omitted",
};

const DECIMALS_FLAG: FlagSpec = {
  name: "decimals",
  type: "integer",
  placeholder: "<n>",
  summary: "Override the mint decimals instead of reading them from the protocol config",
};

const MIN_OUT_FLAG: FlagSpec = {
  name: "min-out",
  type: "string",
  placeholder: "<base-units>",
  summary: "Minimum output in base units of the receiving mint (default 0)",
};

const COLLATERAL_ACCOUNT_FLAG: FlagSpec = {
  name: "collateral-account",
  type: "string",
  placeholder: "<address>",
  summary: "Collateral token account. Defaults to the signer's associated token account",
};

const SYNTHETIC_ACCOUNT_FLAG: FlagSpec = {
  name: "synthetic-account",
  type: "string",
  placeholder: "<address>",
  summary: "Synthetic token account. Defaults to the signer's associated token account",
};

const MINT_FLAGS: readonly FlagSpec[] = [NONCE_FLAG, DECIMALS_FLAG, MIN_OUT_FLAG, COLLATERAL_ACCOUNT_FLAG];
const REDEEM_FLAGS: readonly FlagSpec[] = [NONCE_FLAG, DECIMALS_FLAG, MIN_OUT_FLAG, SYNTHETIC_ACCOUNT_FLAG];

const DEPLOYMENT_NOTE =
  "If the simulation below fails because the program account does not exist, POYZ is not deployed to the cluster you addressed. Deployment is a separate, explicitly approved step.";

function amountRows(input: CommandInput, resolved: ResolvedAmount, unit: string, minOut: bigint, nonce: bigint, generated: boolean, signer: string) {
  const { palette } = input;
  return keyValues(
    palette,
    [
      row("amount", { text: `${resolved.amount} ${unit}`, tone: "body", align: "left" }),
      row("base units", {
        text: `${resolved.baseUnits} (decimals ${resolved.decimals} from ${resolved.decimalsFrom})`,
        tone: "muted",
        align: "left",
      }),
      row("minimum out", {
        text: `${minOut} base units`,
        tone: minOut === 0n ? "warn" : "body",
        align: "left",
      }),
      row("nonce", { text: `${nonce}${generated ? "  (generated)" : ""}`, tone: "warn", align: "left" }),
      row("signer", { text: signer, tone: "body", align: "left" }),
      row("cluster", { text: input.globals.cluster, tone: "muted", align: "left" }),
    ],
    "    ",
  );
}

function notes(extra: readonly string[], minOut: bigint): string {
  const lines = [...extra];
  if (minOut === 0n) {
    lines.push(
      "No minimum output was set (--min-out 0), so the request would accept any output amount. Set --min-out in base units to bound it.",
    );
  }
  lines.push(DEPLOYMENT_NOTE);
  return lines.map((line) => wrap(line, 76, "    ")).join("\n\n");
}

// ------------------------------------------------------------------- mint

export const mintCommand: CommandSpec = {
  path: ["mint"],
  summary: "Submit a mint request against SOL or LST collateral",
  usage: "poyz mint <amount> --keypair <path> [--nonce <n>] [--min-out <base-units>] [--execute]",
  flags: MINT_FLAGS,
  notes: [
    "This submits a request. A keeper must open the offsetting perp short and call mint_confirm before any synthetic dollar is issued, so the command completing does not mean tokens were minted.",
    "Keep the nonce. It addresses the request account, and it is what `poyz mint cancel` needs if no keeper confirms before the request expires.",
  ],
  async run(input: CommandInput) {
    const amount = readAmountArgument(input, "mint");
    const minOut = readMinOut(input);
    const { nonce, generated } = readNonce(input, false);
    const loaded = loadSignerFor(input, requireKeypairPath(input.globals));
    const client = input.ctx.createClient(clientConfig(input.globals));
    const probe = await probeConfig(client);
    const resolved = resolveAmount(input, amount, "collateral", probe.config, probe.error);
    const userCollateral = getString(input.flags, "collateral-account");

    const params: MintRequestParams = {
      user: loaded.publicKey,
      nonce,
      collateralAmount: resolved.baseUnits,
      minSyntheticOut: minOut,
      ...(userCollateral === undefined ? {} : { userCollateral }),
    };

    warn(input, collateralMintMismatch(input, probe.config));
    return runWriteFlow({
      input,
      command: "mint",
      banner: sections(
        `  ${input.palette.paint("muted", "Mint request")}`,
        amountRows(input, resolved, "collateral tokens", minOut, nonce, generated, loaded.publicKey),
        notes(
          [
            "This submits a request, not an issuance. The protocol moves the collateral into a pending request account; a keeper opens the offsetting perp short and calls mint_confirm before any synthetic dollar exists.",
            `If no keeper confirms before the request expires, reclaim the collateral with: poyz mint cancel --nonce ${nonce}`,
          ],
          minOut,
        ),
      ),
      bannerData: {
        amount,
        decimals: resolved.decimals,
        decimalsFrom: resolved.decimalsFrom,
        nonce: nonce.toString(),
        nonceGenerated: generated,
        collateralAmountBaseUnits: resolved.baseUnits.toString(),
        minSyntheticOutBaseUnits: minOut.toString(),
        user: loaded.publicKey,
        phase: "request",
        issuesSynthetic: false,
      },
      confirmQuestion: `Submit a mint request for ${amount} collateral tokens on ${input.globals.cluster}?`,
      buildPlan: () => client.buildMintRequest(params),
      simulate: (plan) => client.simulate(plan),
      send: () => client.mintRequest({ ...params, signer: loaded.signer }),
    });
  },
};

export const mintCancelCommand: CommandSpec = {
  path: ["mint", "cancel"],
  summary: "Reclaim the collateral behind an expired mint request",
  usage: "poyz mint cancel --nonce <n> --keypair <path> [--execute]",
  flags: [NONCE_FLAG, COLLATERAL_ACCOUNT_FLAG],
  notes: [
    "Only an expired request can be cancelled by its owner. Before the request time-to-live elapses the assigned keeper is the only party that may act on it, and the program rejects an early cancel with RequestNotExpired.",
  ],
  async run(input: CommandInput) {
    const { nonce } = readNonce(input, true);
    const loaded = loadSignerFor(input, requireKeypairPath(input.globals));
    const client = input.ctx.createClient(clientConfig(input.globals));
    const userCollateral = getString(input.flags, "collateral-account");
    const params: MintCancelParams = {
      user: loaded.publicKey,
      nonce,
      ...(userCollateral === undefined ? {} : { userCollateral }),
    };

    return runWriteFlow({
      input,
      command: "mint cancel",
      banner: sections(
        `  ${input.palette.paint("muted", "Mint cancel")}`,
        keyValues(
          input.palette,
          [
            row("nonce", { text: nonce.toString(), tone: "warn", align: "left" }),
            row("signer", { text: loaded.publicKey, tone: "body", align: "left" }),
            row("cluster", { text: input.globals.cluster, tone: "muted", align: "left" }),
          ],
          "    ",
        ),
        [
          "Cancelling returns the collateral held by the request account. It only succeeds once the request has expired; until then the assigned keeper is the only party that may act on it.",
          DEPLOYMENT_NOTE,
        ]
          .map((line) => wrap(line, 76, "    "))
          .join("\n\n"),
      ),
      bannerData: { nonce: nonce.toString(), user: loaded.publicKey, phase: "cancel" },
      confirmQuestion: `Cancel mint request ${nonce} on ${input.globals.cluster}?`,
      buildPlan: () => client.buildMintCancel(params),
      simulate: (plan) => client.simulate(plan),
      send: () => client.mintCancel({ ...params, signer: loaded.signer }),
    });
  },
};

// ----------------------------------------------------------------- redeem

export const redeemCommand: CommandSpec = {
  path: ["redeem"],
  summary: "Submit a redeem request against synthetic dollars",
  usage: "poyz redeem <amount> --keypair <path> [--nonce <n>] [--min-out <base-units>] [--execute]",
  flags: REDEEM_FLAGS,
  notes: [
    "This submits a request. A keeper must unwind the matching share of the perp short and call redeem_confirm before collateral is released, so the command completing does not mean collateral was returned.",
    "Keep the nonce. `poyz redeem cancel --nonce <n>` uses it if no keeper confirms before the request expires.",
  ],
  async run(input: CommandInput) {
    const amount = readAmountArgument(input, "redeem");
    const minOut = readMinOut(input);
    const { nonce, generated } = readNonce(input, false);
    const loaded = loadSignerFor(input, requireKeypairPath(input.globals));
    const client = input.ctx.createClient(clientConfig(input.globals));
    const probe = await probeConfig(client);
    const resolved = resolveAmount(input, amount, "synthetic", probe.config, probe.error);
    const userSynthetic = getString(input.flags, "synthetic-account");

    const params: RedeemRequestParams = {
      user: loaded.publicKey,
      nonce,
      syntheticAmount: resolved.baseUnits,
      minCollateralOut: minOut,
      ...(userSynthetic === undefined ? {} : { userSynthetic }),
    };

    warn(input, collateralMintMismatch(input, probe.config));
    return runWriteFlow({
      input,
      command: "redeem",
      banner: sections(
        `  ${input.palette.paint("muted", "Redeem request")}`,
        amountRows(input, resolved, "synthetic dollars", minOut, nonce, generated, loaded.publicKey),
        notes(
          [
            "This submits a request, not a withdrawal. A keeper unwinds the matching share of the perp short and calls redeem_confirm before any collateral is released; releasing it earlier would leave the remaining holders over-hedged.",
            `If no keeper confirms before the request expires, unwind it with: poyz redeem cancel --nonce ${nonce}`,
          ],
          minOut,
        ),
      ),
      bannerData: {
        amount,
        decimals: resolved.decimals,
        decimalsFrom: resolved.decimalsFrom,
        nonce: nonce.toString(),
        nonceGenerated: generated,
        syntheticAmountBaseUnits: resolved.baseUnits.toString(),
        minCollateralOutBaseUnits: minOut.toString(),
        user: loaded.publicKey,
        phase: "request",
        releasesCollateral: false,
      },
      confirmQuestion: `Submit a redeem request for ${amount} synthetic dollars on ${input.globals.cluster}?`,
      buildPlan: () => client.buildRedeemRequest(params),
      simulate: (plan) => client.simulate(plan),
      send: () => client.redeemRequest({ ...params, signer: loaded.signer }),
    });
  },
};

export const redeemCancelCommand: CommandSpec = {
  path: ["redeem", "cancel"],
  summary: "Unwind an expired redeem request",
  usage: "poyz redeem cancel --nonce <n> --keypair <path> [--execute]",
  flags: [NONCE_FLAG, SYNTHETIC_ACCOUNT_FLAG],
  notes: [
    "Only an expired request can be cancelled by its owner; the program rejects an early cancel with RequestNotExpired.",
  ],
  async run(input: CommandInput) {
    const { nonce } = readNonce(input, true);
    const loaded = loadSignerFor(input, requireKeypairPath(input.globals));
    const client = input.ctx.createClient(clientConfig(input.globals));
    const userSynthetic = getString(input.flags, "synthetic-account");
    const params: RedeemCancelParams = {
      user: loaded.publicKey,
      nonce,
      ...(userSynthetic === undefined ? {} : { userSynthetic }),
    };

    return runWriteFlow({
      input,
      command: "redeem cancel",
      banner: sections(
        `  ${input.palette.paint("muted", "Redeem cancel")}`,
        keyValues(
          input.palette,
          [
            row("nonce", { text: nonce.toString(), tone: "warn", align: "left" }),
            row("signer", { text: loaded.publicKey, tone: "body", align: "left" }),
            row("cluster", { text: input.globals.cluster, tone: "muted", align: "left" }),
          ],
          "    ",
        ),
        [
          "Cancelling returns the synthetic dollars held by the request account. It only succeeds once the request has expired.",
          DEPLOYMENT_NOTE,
        ]
          .map((line) => wrap(line, 76, "    "))
          .join("\n\n"),
      ),
      bannerData: { nonce: nonce.toString(), user: loaded.publicKey, phase: "cancel" },
      confirmQuestion: `Cancel redeem request ${nonce} on ${input.globals.cluster}?`,
      buildPlan: () => client.buildRedeemCancel(params),
      simulate: (plan) => client.simulate(plan),
      send: () => client.redeemCancel({ ...params, signer: loaded.signer }),
    });
  },
};
