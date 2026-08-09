# @poyz/sdk

TypeScript SDK for **POYZ**, a delta-neutral synthetic dollar on Solana.

POYZ takes SOL or LST collateral, holds an offsetting perpetual short of the same notional, and issues
a synthetic dollar against the pair. The offset is what holds the dollar value.

The return on the hedge is **carry, not yield**. Carry is signed. On a funding venue the short can be
paid or can pay; on an LP-pool venue the position holder always pays a borrow fee, so that leg is a
cost line. **Net carry is funding received less borrow fee paid, and at the time of writing it is
negative.** This package reports it with its sign and never sums the two legs into one yield figure.

- Browser and Node. ESM and CommonJS, with types for both.
- One runtime dependency: `@solana/web3.js`.
- Reads from the POYZ status API, from the chain, or both.
- Writes are **built unsigned by default**, so an integrating protocol signs with its own wallet.
  This SDK never holds a key.

---

## Install

**`@poyz/sdk` is not on npm.** There is no `npm install @poyz/sdk` that resolves, so this README does
not print one. Build the tarball from the repository and install that:

```bash
git clone https://github.com/poyzfi/poyz-sdk.git
cd poyz-sdk
npm install
npm run build --workspace @poyz/sdk
npm pack --workspace @poyz/sdk --pack-destination /tmp
```

Then, from your own project:

```bash
npm install /tmp/poyz-sdk-0.1.0.tgz @solana/web3.js
```

`@solana/web3.js` stays external to the bundle so your application and this SDK share one copy of
`PublicKey` and `Connection`.

---

## Quick start

```ts
import { PoyzClient } from "@poyz/sdk";

const poyz = PoyzClient.create();          // mainnet-beta, public RPC, live status API

const delta = await poyz.getDelta();
if (delta.available && delta.data !== null) {
  console.log(`${delta.data.deviationBps} bps off neutral (source: ${delta.source})`);
} else {
  console.log(`no delta reading: ${delta.detail}`);
}
```

Every read returns a `SourcedValue<T>`:

```ts
interface SourcedValue<T> {
  source: "api" | "chain";
  available: boolean;
  observedAtMs: number | null;
  detail: string | null;     // why it is unavailable, or a caveat about how it was derived
  data: T | null;
}
```

`available: false` is a normal state, not an error. It means the source answered and had no value.
Render the `detail`, or omit the indicator. Do not substitute a zero -- an unknown delta and a delta
of zero are different facts.

---

## Reading

| Method | Source | Notes |
| --- | --- | --- |
| `getDelta(opts)` | chain, api | Chain returns the delta the newest rebalance proof attested |
| `getCollateral(opts)` | chain, api | Supply and buffer are exact on chain; collateral value needs an oracle price |
| `getFunding(opts)` | api | Net carry, with the funding and borrow-fee legs kept apart |
| `getHedgeVenues(opts)` | api | Venue market and funding data; exposure is null until a position exists |
| `getRebalances(opts)` | chain | The on-chain proof chain, newest first |
| `getStats(opts)` | chain + api | Everything a header needs, with a `notes` list for each gap |
| `api.getStats()` | api | The raw indicator envelopes, each with its own `available` flag |
| `getConfig()` | chain | The protocol singleton: balances, parameters, pause flags and vault state |
| `getKeeper(pubkey)` | chain | Bond, proofs committed, active flag |
| `getStakePosition(owner)` | chain | Staked amount, unclaimed funding, pending unstake and its cooldown |
| `getMintRequest(user, nonce)` | chain | An open issuance request and whether it has expired |
| `getRedeemRequest(user, nonce)` | chain | The same for redemptions |

`source: "auto"` (the default) prefers the chain, because the chain is the record of account, and falls
back to the status API for the numbers the chain does not store.

### Venues and carry

Hedge venue slots are **1-based**, because slot `0` is the u8 zero value: if the primary venue lived
at 0, a `venue_id` that was never set would be indistinguishable from a deliberate choice and a proof
would be silently attributed to it. The program rejects 0 and so does this SDK.

| Slot | Venue | Carry model |
| --- | --- | --- |
| 1 | `velocity` (traded as `drift` before the 2026-07 rebrand; the alias resolves here) | funding-receiving |
| 2 | `jupiter-perps` | borrow-fee-paying, a confirmed cost |
| 3 | `adrena` | reserved, not implemented |
| 4 | `flash-trade` | reserved, not implemented |
| 255 | `simulated` | rejected in live mode |

```ts
import { venueIdFromName, venueName, isVenueEnabled } from "@poyz/sdk";

venueIdFromName("velocity");   // 1
venueIdFromName("drift");      // 1  -- rename alias, same slot
venueName(0);                  // "none", never a venue name
venueIdFromName("zeta");       // throws: Zeta stopped perpetual operations on 2025-05-01
isVenueEnabled(config.venueFlags, 1);
```

Zeta Markets and Mango v4 no longer operate. They are kept in `RETIRED_VENUES` so a stale string is
refused with the reason rather than falling through to "unknown venue".

Venue exposure is nullable on purpose:

```ts
const venues = await poyz.getHedgeVenues();
for (const venue of venues.data ?? []) {
  console.log(
    `${venue.venue} (${venue.status}) ${venue.market ?? "-"} ` +
    `${venue.carryModel ?? "carry model unknown"} ` +
    `${venue.carryAnnualizedRate === null ? "n/a" : `${(venue.carryAnnualizedRate * 100).toFixed(2)}%`} ` +
    `notional ${venue.shortNotionalUsd ?? "none"}`,
  );
}
```

A `null` notional means the protocol holds no position at that venue, or has not published one. It is
not a zero-size hedge, and this SDK will not round it into one.

```ts
const proofs = await poyz.getRebalances({ limit: 5 });
for (const record of proofs.data ?? []) {
  console.log(
    `#${record.sequence} ${record.deltaBpsBefore} -> ${record.deltaBpsAfter} bps on ${record.venue}` +
    ` at ${record.oraclePriceUsd} USD`,
  );
}
```

### Amounts

Anything the program stores as a `u64` is exposed as a **decimal string in base units**, because a u64
does not fit in a double. Convert at the edge with the decimals the config reports:

```ts
import { formatBaseUnits } from "@poyz/sdk";

const config = await poyz.getConfig();
formatBaseUnits(BigInt(config.totalSynthetic), config.syntheticDecimals);   // "400000"
formatBaseUnits(BigInt(config.bufferBalance), config.syntheticDecimals);    // "7000"
```

Rebalance proofs also carry `collateralNotionalUsd` and `hedgedNotionalUsd` as ordinary numbers: the
program stores those notionals in synthetic base units, and the synthetic is the dollar, so the
conversion is exact rather than a guessed scale.

---

## Writing

Issuance and redemption are **two-legged**. A user posts a request, which escrows the asset and
records a price quote; a bonded keeper settles it with a confirm once the hedge is filled or unwound;
the user reclaims the escrow with a cancel if the deadline passes unconfirmed.

```
mint_request    -> mint_confirm    (keeper, hedge filled)
                -> mint_cancel     (user, after the deadline)

redeem_request  -> redeem_confirm  (keeper, hedge unwound)
                -> redeem_cancel   (user, after the deadline)

request_unstake -> unstake         (owner, after the cooldown)
```

Unstaking is two-legged for the same reason: `requestUnstake` moves an amount into a pending balance
and starts the cooldown, and `unstake` withdraws it once that ends. The delay is what lets the keeper
unwind hedge against staker outflow instead of being surprised by it. `unstake` takes no amount -- it
withdraws whatever is pending, and the program rejects it while the cooldown runs.

`buildMintRequest` opens the request. It does not mint, and nothing in this SDK calls it a mint.

```ts
import { PoyzClient, parseDecimalToBaseUnits, walletAdapterSigner } from "@poyz/sdk";

const nonce = 1n;                       // your request id; part of the request PDA seed
const plan = await poyz.buildMintRequest({
  user: wallet.publicKey.toBase58(),
  nonce,
  collateralAmount: parseDecimalToBaseUnits("2.5", 9),
  minSyntheticOut: 0n,
});

console.log(plan.description);
for (const warning of plan.warnings) console.warn(warning);

const simulation = await poyz.simulate(plan);          // dry run against the cluster
if (!simulation.ok) console.error(simulation.errorMessage);

const result = await poyz.sendTransaction(plan, walletAdapterSigner(wallet));
console.log(result.explorerUrl);

// Later: check on it, or reclaim the collateral once it has expired.
const request = await poyz.getMintRequest(wallet.publicKey.toBase58(), nonce);
if (request.expired) {
  await poyz.mintCancel({ user: request.user, nonce, signer });
}
```

Keep the nonce. Without it you cannot look the request up or cancel it.

A plan serializes to its readable summary, so `JSON.stringify(plan)` gives you the instruction names,
the account list with signer and writable flags, and the instruction data as hex -- not a dump of
web3.js internals.

### Token accounts

Every builder derives the associated token account for the owner by default, using the token program
the config records (SPL Token or Token-2022 derive different addresses). Pass an explicit account when
you keep balances somewhere else:

```ts
await poyz.buildStake({ owner, amount, ownerSynthetic: "<token account>" });
```

### Signers

Either shape works, and the SDK picks the right one:

```ts
import { keypairSigner, walletAdapterSigner } from "@poyz/sdk";

const browser = walletAdapterSigner(wallet);       // { publicKey, signTransaction }
const server  = keypairSigner(secretKeyBytes);     // 64 byte ed25519 secret key
```

`keypairSigner` holds the key in a closure. It exposes the public key and a signing method, and no
function in this package logs, serializes or returns a secret key -- including in its error messages.

### What this SDK wraps

| Area | Methods | Notes |
| --- | --- | --- |
| Issuance | `mintRequest` `mintConfirm` `mintCancel` | Confirm is keeper-only |
| Redemption | `redeemRequest` `redeemConfirm` `redeemCancel` | Confirm is keeper-only |
| Staking | `stake` `requestUnstake` `unstake` `claimFunding` | Staking takes the funding exposure, both directions |
| Keeper | `keeperRegister` `keeperBond` `keeperUnbond` `commitRebalanceProof` | Bond is slashable |
| Buffer | `bufferDeposit` | First-loss capital; withdrawal is authority-gated |

Administrative instructions (`initialize`, `set_params`, `set_oracle`, `set_paused`,
`transfer_authority`, `accept_authority`, the `init_*_vaults` group, `keeper_slash`, `settle_funding`,
`buffer_withdraw`) exist on the program but are **deliberately not wrapped**. They are authority-only
and one-shot, and they deserve to be assembled deliberately from `POYZ_IDL` rather than made
convenient to script. Calling `buildInitialize`, `buildKeeperSlash` or `buildSettleFunding` throws
`PoyzUnsupportedError` with that reason.

Check support programmatically before offering an action in a UI:

```ts
import { POYZ_INSTRUCTION_SUPPORT } from "@poyz/sdk";

POYZ_INSTRUCTION_SUPPORT.stake.available;         // true
POYZ_INSTRUCTION_SUPPORT.keeperSlash.reason;      // why it is not wrapped
```

### Keeper obligations

`commitRebalanceProof`, `mintConfirm` and `redeemConfirm` attest to a venue-side execution the signer
performed. The program checks what it can -- sequence, slot monotonicity, oracle freshness, and that
the post-rebalance delta is inside the band -- but it cannot check that the trade happened. That is
what the bond is for, and a false attestation is slashed into the insurance buffer. Every one of these
plans carries that warning in `plan.warnings`; show it before asking anyone to sign.

---

## Funding simulation

`simulateFunding` runs a scenario through the same buffer arithmetic and negative-funding playbook the
protocol uses (`packages/risk-buffer`, compiled into this bundle -- there is no `@poyz/*` runtime
dependency).

```ts
import { simulateFunding } from "@poyz/sdk";

const stress = simulateFunding({
  amountUsd: 1_000_000,
  days: 90,
  fundingScenario: {
    annualizedRate: -0.15,          // negative: the protocol pays
    bufferBalanceUsd: 17_000,
    coveredSupplyUsd: 1_000_000,
    dailyOperatingCostUsd: 250,
  },
});

stress.buffer.daysToDepletion;      // 25.7
stress.buffer.stage;                // "throttle"
stress.buffer.actions;              // the operator playbook for that stage
stress.disclaimer;                  // travels with the result
```

The rate is an input you supply and it is held flat for the whole period, which real funding does not
do. The result is scenario arithmetic, not a forecast, and the `disclaimer` field says so wherever the
numbers go.

---

## Errors

| Class | `code` | Meaning |
| --- | --- | --- |
| `PoyzConfigError` | `config` | A config value is missing, malformed, or unsafe to ship |
| `PoyzApiError` | `api` | The status API could not be reached, or answered non-2xx |
| `PoyzUnavailableError` | `unavailable` | The source answered and has no value yet |
| `PoyzChainError` | `chain` | An RPC call failed or returned undecodable data |
| `PoyzAccountNotFoundError` | `chain` | The account does not exist on this cluster |
| `PoyzProgramError` | `chain` | The program rejected the transaction, with the IDL error name |
| `PoyzUnsupportedError` | `unsupported` | This SDK does not wrap that instruction |

Program errors are resolved to their IDL names automatically, in every shape the RPC returns them.
Anchor renumbers error codes whenever one is inserted, so resolve by code rather than hard-coding a
number:

```ts
import { describeProgramError } from "@poyz/sdk";

describeProgramError(6028);
// { code: 6028, name: "InsufficientBond", msg: "Keeper bond is below the protocol minimum." }
```

---

## Configuration

```ts
PoyzClient.create({
  cluster: "mainnet-beta",                          // or "devnet", "localnet"
  rpcUrl: "https://api.mainnet-beta.solana.com",    // must be key-free
  apiBaseUrl: "https://poyz-api-production.up.railway.app",
  programId: POYZ_PROGRAM_ID,
  commitment: "confirmed",
  requestTimeoutMs: 10_000,
  fetchImpl,                                        // optional
  connection,                                       // optional, reuse your own
  context: {                                        // optional, skips the config read
    collateralMint, syntheticMint, bondMint, oracle, tokenProgram,
  },
});
```

`resolveConfig` **rejects a keyed RPC URL** -- Helius, Alchemy, QuickNode, or anything carrying
`api-key` or `access_token`. This package runs in browsers, so a keyed endpoint passed here would ship
with the bundle. Proxy it through your own server route and give the browser a public endpoint.

Without `context`, the client reads the mints, the oracle and the token program from the protocol
config account on first use and caches them. Supply `context` to build plans offline, or against a
cluster where the protocol is not deployed.

---

## Working with the IDL directly

The compiled Anchor IDL ships with the package, so an integrator already using `@coral-xyz/anchor` does
not have to re-derive it:

```ts
import { POYZ_IDL, INSTRUCTION_DISCRIMINATORS, POYZ_IDL_ERRORS } from "@poyz/sdk";
```

Regenerate it after rebuilding the program with `npm run sync-idl --workspace @poyz/sdk`.

---

## Runnable example

`examples/readme-example.mjs` is the code above, kept as a file so it can be executed rather than only
read. Run it with:

```bash
npm run build --workspace @poyz/sdk
npm run example --workspace @poyz/sdk
```

Real output, at the time of writing:

```
program         9hefehGRVBDE2A9kby8oQnRvEF5yK42px2ssfsQjchzU
config PDA      9SgzpR2hgRXByQsYQjsZ6258t3jxVGchtPCMg6Y1GkF4
mint request #1 J5HzDg2QCryvvUFBnNzktS3TJqBx7nyo32paWH8uPcPb
venue slots     0=none 1=velocity 2=jupiter-perps (the "drift" alias resolves to slot 1)

plan: Escrow 2500000000 collateral base units and open mint request 1
  escrowing 2.5 wSOL
  instruction mint_request
    [sw] user              GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB
    [-w] config            9SgzpR2hgRXByQsYQjsZ6258t3jxVGchtPCMg6Y1GkF4
    [-w] request           J5HzDg2QCryvvUFBnNzktS3TJqBx7nyo32paWH8uPcPb
    [--] collateral_mint   So11111111111111111111111111111111111111112
    [-w] user_collateral   59btS1MqkxUBx9sHGorTuLAHMbCzzJmjagXiEac3Mtb2
    [-w] collateral_vault  5Q8HArR1KG3Xc8AC54r6LUwAS5f8VjMQ6bPEgPqeCSDU
    [--] oracle            5WcE8o73vmsSZXeeWTLm3ty3fAJKCnBWRF6VuKUme5nu
    [--] token_program     TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
    [--] system_program    11111111111111111111111111111111
warning: This is the request leg only. Collateral or synthetic dollars move into protocol escrow
  now; settlement happens when a bonded keeper confirms the hedge, and the request can be cancelled
  by you after its deadline if no keeper confirms it.

instruction support:
  mintRequest     wrapped
  stake           wrapped
  requestUnstake  wrapped
  keeperRegister  wrapped
  initialize      not wrapped
  keeperSlash     not wrapped
buildKeeperSlash refused: Authority-only. Not wrapped: slashing is an adjudication, and the evidence
  hash should be produced by the process that decided the fault.

unstake legs:
  request_unstake  Start the unstake cooldown on 1000000 synthetic base units
  unstake          Withdraw the pending unstake

negative funding stress, 90 days at -15% annualized:
  funding over the period   -36986 USD
  buffer drain per day      661 USD
  buffer runway             25.7 days
  playbook stage            throttle
  depletes within period    yes
Scenario arithmetic, not a projection. The rate is an input held flat for the whole period, which
  real funding does not do: it is a market rate that moves and can stay negative, in which case the
  position pays funding and the buffer is drawn down. Venue failure, liquidation and hedge slippage
  are not modelled here.

live carry read:
  net carry      -175.00% (estimate)
  gross funding  n/a
  hedge cost     n/a
  the protocol pays carry at this rate

live hedge venues:
  velocity  slot 1  live          funding-receiving    -175.00%  notional none
  jupiter-perps slot 2  candidate     borrow-fee-paying      -6.14%  notional none
  mango     -       discontinued  -                         n/a  notional none
  zeta      -       discontinued  -                         n/a  notional none

live delta read:
not available -- The POYZ protocol is not initialised on mainnet-beta at program
  9hefehGRVBDE2A9kby8oQnRvEF5yK42px2ssfsQjchzU (missing account
  9SgzpR2hgRXByQsYQjsZ6258t3jxVGchtPCMg6Y1GkF4).
```

The last lines are the honest state of the deployment, not a bug in the example: the program has not
been deployed to any cluster yet, and the status API is not up, so the read has no value and the SDK
says why instead of returning an empty object.

---

## Development

```bash
npm run typecheck --workspace @poyz/sdk    # tsc --noEmit
npm run build     --workspace @poyz/sdk    # esm + cjs bundles and declarations
npm test          --workspace @poyz/sdk    # node --test against the built bundle
npm run sync-idl  --workspace @poyz/sdk    # regenerate src/generated/idl.ts
```

The tests run against `dist/`, not against the sources, so what is tested is what a consumer installs.

`test/layout.test.mjs` is the guard that matters most while the program is still moving. The decoders
read account data positionally, which is silent when it is wrong, so `ACCOUNT_LAYOUTS` in
`src/accounts.ts` declares by hand the field sequence each decoder assumes and that test compares the
declaration with the shipped IDL. A field inserted, renamed, reordered or retyped in the program fails
there by name, instead of downstream as a balance that is quietly off. After `npm run sync-idl`, run
the tests before anything else.

---

## Honest framing

Carry is variable and signed, and it is negative at the time of writing: the hedge costs more than it
earns, the protocol pays, and the insurance buffer is drawn down. Staked balances carry that. The
Jupiter Perps leg is a borrow fee the position holder always pays, so it is a cost in every regime and
is never presented as a second yield source. The hedge is held on external
perpetual venues, so venue failure, liquidation and hedge slippage are real exposures. Issuance and
redemption depend on a bonded keeper actually settling the request, and an unsettled request is
cancellable but not instant. Unstaking is subject to a cooldown, so staked balances are not liquid on
demand. The buffer is a buffer, not a guarantee. `simulateFunding` output is
scenario arithmetic held flat over the period, not a forecast, and any forward-looking figure derived
from it must be labelled an estimate.

## License

MIT
