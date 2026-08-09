/**
 * The example from README.md, kept as a file so it can be run.
 *
 * Run it with `npm run example --workspace @poyz/sdk`. Everything except the
 * last two steps is offline; those deliberately call the live status API and a
 * public RPC, so the "no data yet" and "not deployed yet" paths are exercised
 * for real rather than described.
 */

import { Keypair } from "@solana/web3.js";

import {
  PoyzClient,
  POYZ_INSTRUCTION_SUPPORT,
  POYZ_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  deriveConfigAddress,
  deriveMintRequestAddress,
  venueIdFromName,
  venueName,
  formatBaseUnits,
  parseDecimalToBaseUnits,
  simulateFunding,
} from "@poyz/sdk";

const WSOL = "So11111111111111111111111111111111111111112";

// Stand-ins for real addresses. In an application the wallet comes from the
// adapter and the mints come from the protocol config; the seeds here only make
// the example reproducible.
const wallet = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey.toBase58();
const syntheticMint = Keypair.fromSeed(new Uint8Array(32).fill(21)).publicKey.toBase58();
const oracle = Keypair.fromSeed(new Uint8Array(32).fill(31)).publicKey.toBase58();

// Passing `context` lets plans be built without an RPC round trip. Omit it and
// the client reads the same addresses from the protocol config account.
const poyz = PoyzClient.create({
  cluster: "mainnet-beta",
  context: {
    collateralMint: WSOL,
    syntheticMint,
    bondMint: WSOL,
    oracle,
    tokenProgram: TOKEN_PROGRAM_ID,
  },
});

// 1. Addresses are derived locally, no RPC needed.
console.log("program        ", POYZ_PROGRAM_ID);
console.log("config PDA     ", deriveConfigAddress());
console.log("mint request #1", deriveMintRequestAddress(wallet, 1n));
console.log(
  `venue slots     0=${venueName(0)} 1=${venueName(1)} 2=${venueName(2)}` +
    ` (the "drift" alias resolves to slot ${venueIdFromName("drift")})`,
);

// 2. Open a mint request without signing it. Issuance is two-legged: this
//    escrows collateral and records a quote; a bonded keeper mints against it
//    once the hedge is filled.
const nonce = 1n;
const collateral = parseDecimalToBaseUnits("2.5", 9);
const plan = await poyz.buildMintRequest({
  user: wallet,
  nonce,
  collateralAmount: collateral,
  minSyntheticOut: 0n,
});
console.log(`\nplan: ${plan.description}`);
console.log(`  escrowing ${formatBaseUnits(collateral, 9)} wSOL`);
for (const ix of plan.instructions) {
  console.log(`  instruction ${ix.name}`);
  for (const account of ix.accounts) {
    const flags = `${account.isSigner ? "s" : "-"}${account.isWritable ? "w" : "-"}`;
    console.log(`    [${flags}] ${account.name.padEnd(17)} ${account.pubkey}`);
  }
}
for (const warning of plan.warnings) {
  console.log(`  warning: ${warning}`);
}

// 3. What this SDK wraps, and what it deliberately does not.
console.log("\ninstruction support:");
for (const name of ["mintRequest", "stake", "requestUnstake", "keeperRegister", "initialize", "keeperSlash"]) {
  const entry = POYZ_INSTRUCTION_SUPPORT[name];
  console.log(`  ${name.padEnd(15)} ${entry.available ? "wrapped" : "not wrapped"}`);
}
try {
  await poyz.buildKeeperSlash({});
} catch (error) {
  console.log(`  buildKeeperSlash refused: ${error.reason}`);
}

// 3b. Unstaking is two-legged as well.
const unstakeRequest = await poyz.buildRequestUnstake({ owner: wallet, amount: 1_000_000n });
const unstakeWithdraw = await poyz.buildUnstake({ owner: wallet });
console.log("\nunstake legs:");
console.log(`  ${unstakeRequest.instructions[0].name.padEnd(16)} ${unstakeRequest.description}`);
console.log(`  ${unstakeWithdraw.instructions[0].name.padEnd(16)} ${unstakeWithdraw.description}`);

// 4. Run a negative funding scenario through the risk buffer playbook.
const stress = simulateFunding({
  amountUsd: 1_000_000,
  days: 90,
  fundingScenario: {
    annualizedRate: -0.15,
    bufferBalanceUsd: 17_000,
    coveredSupplyUsd: 1_000_000,
    dailyOperatingCostUsd: 250,
  },
});
console.log("\nnegative funding stress, 90 days at -15% annualized:");
console.log(`  funding over the period   ${stress.grossFundingUsd.toFixed(0)} USD`);
console.log(`  buffer drain per day      ${stress.buffer.dailyDrainUsd.toFixed(0)} USD`);
console.log(`  buffer runway             ${stress.buffer.daysToDepletion.toFixed(1)} days`);
console.log(`  playbook stage            ${stress.buffer.stage}`);
console.log(`  depletes within period    ${stress.buffer.depletesWithinPeriod ? "yes" : "no"}`);
console.log(`  ${stress.disclaimer}`);

// 5. Live reads. When a source has nothing, that is a state, not an error.
const funding = await poyz.getFunding();
console.log("\nlive carry read:");
if (funding.available && funding.data !== null) {
  const pct = (rate) => (rate === null ? "n/a" : `${(rate * 100).toFixed(2)}%`);
  console.log(`  net carry      ${pct(funding.data.netCarryRate)}${funding.data.isEstimate ? " (estimate)" : ""}`);
  console.log(`  gross funding  ${pct(funding.data.grossFundingRate)}`);
  console.log(`  hedge cost     ${pct(funding.data.hedgeCostRate)}`);
  console.log(`  the protocol ${funding.data.negativeCarry ? "pays" : "receives"} carry at this rate`);
} else {
  console.log(`  not available -- ${funding.detail}`);
}

const venues = await poyz.getHedgeVenues();
console.log("\nlive hedge venues:");
for (const venue of venues.data ?? []) {
  const rate = venue.carryAnnualizedRate === null ? "n/a" : `${(venue.carryAnnualizedRate * 100).toFixed(2)}%`;
  const notional = venue.shortNotionalUsd === null ? "none" : `${venue.shortNotionalUsd} USD`;
  const slot = venue.venueId === null ? "-" : `slot ${venue.venueId}`;
  console.log(
    `  ${venue.venue.padEnd(9)} ${slot.padEnd(7)} ${(venue.status ?? "-").padEnd(13)} ` +
      `${(venue.carryModel ?? "-").padEnd(19)} ${rate.padStart(9)}  notional ${notional}`,
  );
}

const delta = await poyz.getDelta();
console.log("\nlive delta read:");
if (delta.available && delta.data !== null) {
  console.log(`  ${delta.data.deviationBps} bps off neutral (source: ${delta.source})`);
} else {
  console.log(`  not available -- ${delta.detail}`);
}
