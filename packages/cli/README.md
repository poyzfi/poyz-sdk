# poyz-cli

Command line interface for POYZ, a delta-neutral synthetic dollar on Solana.

POYZ takes SOL or LST collateral, holds an offsetting perpetual short of the same notional, and
issues a synthetic dollar against the pair. The offset is what holds the dollar value; the funding
paid to the short is the yield, and that rate is a market rate that can and does go negative.

Binary name: `poyz`.

---

## What this build does, and what it does not

- **Reads** delta, funding, collateral and the on-chain protocol config, from the status API, the
  chain, or both.
- **Builds and simulates** every write against the cluster, and prints the plan and the simulation
  result before anything is signed.
- **Sends nothing without `--execute`.** A dry run does real work and then exits 5, so a script can
  tell "I showed you what would happen" apart from "I did it".
- **Never reads a default wallet.** The keypair path is only ever what you passed.
- **Commits no execution proofs.** `poyz keeper run` observes and judges; it places no venue orders,
  so it has nothing truthful to attest to.

The POYZ program is not deployed to any cluster yet, so today every simulation against a real RPC
endpoint fails because the program account does not exist. The CLI reports that failure as the
cluster returned it rather than dressing it up.

---

## Install

`poyz-cli` is not published to npm yet, so there is no `npm i -g poyz-cli` to copy. Build it from
the repository:

```bash
git clone https://github.com/poyzfi/poyz-sdk.git
cd poyz-sdk
npm install
npm run build --workspace poyz-cli
node packages/cli/dist/poyz.mjs --help
```

To get a real `poyz` on your PATH, pack it and install the tarball:

```bash
npm pack --workspace poyz-cli          # writes poyz-cli-0.1.0.tgz
npm install -g ./poyz-cli-0.1.0.tgz
poyz --version
```

Node 20 or newer. The only runtime dependency is `@solana/web3.js`; the POYZ SDK is bundled into
`dist/poyz.mjs` at build time.

---

## Commands

| Command | What it does |
| --- | --- |
| `poyz mint <amount>` | Submit a mint request against SOL or LST collateral |
| `poyz mint cancel` | Reclaim the collateral behind an expired mint request |
| `poyz redeem <amount>` | Submit a redeem request against synthetic dollars |
| `poyz redeem cancel` | Unwind an expired redeem request |
| `poyz stake <amount>` | Stake synthetic dollars to take the funding exposure |
| `poyz unstake <amount>` | Start the unstake cooldown on part of the stake position |
| `poyz unstake withdraw` | Withdraw a pending unstake once its cooldown has elapsed |
| `poyz claim` | Claim funding accrued to a stake position |
| `poyz delta` | Delta deviation between the spot leg and the perp short, per venue |
| `poyz funding` | Net carry on the hedged book, signed, with the funding and cost legs apart |
| `poyz status` | Delta, collateral, funding and protocol config on one screen |
| `poyz keeper run` | Watch the delta band as a Delta Keeper would |
| `poyz keeper register` | Register as a Delta Keeper and post the opening bond |
| `poyz keeper bond` | Add to an existing keeper bond |
| `poyz keeper unbond` | Withdraw from a keeper bond after the cooldown |
| `poyz venue list` | Hedge venue slots, which are enabled, and how fresh the last reading is |
| `poyz venue report` | Report a venue's net carry and capacity. Protocol authority only |
| `poyz simulate` | Project funding over a horizon, including the negative regime |

`poyz <command> --help` prints the flags and the caveats for one command.

### Issuance is two-phase

`poyz mint 1.5` does **not** mint anything. It submits a request: the protocol escrows the
collateral in a request account, and a bonded keeper opens the offsetting perp short and calls
`mint_confirm` before any synthetic dollar exists. Redemption mirrors it, with the keeper unwinding
the matching share of the short before collateral is released.

Two consequences worth internalising before you script against this:

1. **A successful `poyz mint` means a request was accepted, not that tokens were issued.** The
   command says so on screen, and the JSON envelope carries `"phase": "request"` and
   `"issuesSynthetic": false`.
2. **Keep the nonce.** The request account is a PDA seeded by your address and the nonce, so the
   nonce is the only handle for cancelling the request if no keeper confirms it before it expires.
   Pass `--nonce <n>` to choose one; when you do not, the CLI picks one and prints it, marked
   `(generated)`.

```bash
poyz mint 1.5 --keypair ./keys/poyz.json                     # dry run, prints the nonce
poyz mint 1.5 --keypair ./keys/poyz.json --nonce 7 --execute # sends it
poyz mint cancel --nonce 7 --keypair ./keys/poyz.json        # after the request expires
```

Amounts are whole tokens. Decimals come from the on-chain protocol config, so `1.5` converts with
the mint's real precision; `--decimals <n>` overrides that. An amount is never converted against an
assumed precision, so a command stops with exit 2 rather than guessing when neither source can say
how many decimals a mint has.

### Leaving a stake position is two-phase as well

`poyz unstake 100` does **not** return anything. It moves 100 synthetic dollars into a pending
balance and starts the protocol unstake cooldown; `poyz unstake withdraw` collects them once that
cooldown has elapsed. The delay is what lets a keeper unwind hedge against staker outflow instead of
being surprised by it, so a staked balance is not liquid on demand.

`poyz unstake withdraw` takes no amount. The program withdraws whatever the request put into
cooldown, and rejects the call with `UnstakeCooldownActive` while the clock is still running, or
`NoPendingUnstake` when nothing is waiting.

```bash
poyz unstake 100 --keypair ./keys/poyz.json --execute      # starts the cooldown
poyz unstake withdraw --keypair ./keys/poyz.json --execute # after it elapses
poyz claim --keypair ./keys/poyz.json --execute            # funding already settled to you
```

### Venue state is a feed, and issuance is fail-closed on it

The protocol will not mint while it has no current reading of the hedge venue. `report_venue_state`
carries the venue's net carry and its available capacity, and mint requests are rejected while that
reading is missing, older than the configured maximum age, or short of the capacity the supply would
need. It is a recurring feed, not a setting: **stop sending it and minting stops.**

```bash
poyz venue list                                                  # slots, flags, and how stale the reading is
poyz venue report --venue velocity --net-carry-bps -1750 \
  --capacity 7646000000 --keypair ./keys/authority.json --execute
```

`venue report` is signed by the **protocol authority**, not by a keeper, which is why it is not under
`poyz keeper`. Net carry is signed: a venue that charges reports a negative number.

Venue slots are 1-based. Slot 0 is the unset `u8` value and the program rejects it, so a `venue_id`
that was never written cannot be mistaken for the primary venue. `velocity` is slot 1 and `drift`
resolves to the same slot, because that is the same venue before its rebrand. Zeta and Mango v4 no
longer operate and are refused by name with the reason.

---

## Global flags

| Flag | Meaning |
| --- | --- |
| `--json` | Emit one JSON object on stdout instead of a table |
| `--cluster <name>` | `mainnet-beta` (default), `devnet` or `localnet` |
| `--rpc <url>` | RPC endpoint |
| `--api <url>` | POYZ status API base URL |
| `--program <id>` | POYZ program address |
| `--keypair <path>` | Path to a Solana keypair JSON file |
| `--collateral-mint <mint>` | Assert the protocol holds this collateral mint |
| `--execute` | Send the transaction. Without it every write is a dry run |
| `--yes` | Skip the confirmation prompt |
| `--no-color` | Disable colour |
| `--timeout <ms>` | Request timeout |
| `--source <name>` | Read path: `api`, `chain` or `auto` (default) |
| `-h, --help` / `-V, --version` | Help and version |

Environment fallbacks: `POYZ_KEYPAIR`, `POYZ_API`, `POYZ_RPC`, `POYZ_CLUSTER`, `POYZ_PROGRAM_ID`,
`POYZ_COLLATERAL_MINT`, `NO_COLOR`. A flag always beats the environment.

`--collateral-mint` is an assertion, not a lookup: the protocol config is a singleton, so nothing
needs the mint to find anything. Passing it turns "I assume this protocol holds SOL" into a check
against the deployed config, and a mismatch is reported on stderr.

---

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Runtime error: network, RPC, or an on-chain program error |
| 2 | Usage error: unknown command or flag, missing or malformed argument |
| 3 | No data: upstream has not published that metric yet |
| 4 | Threshold exceeded: the monitored value crossed `--max-deviation-bps` |
| 5 | Refused: a write was attempted without `--execute`, or a prompt was declined |

Codes 3, 4 and 5 exist so a monitoring job can tell three different silences apart: a metric that
was never produced, a band that was breached, and a transaction that was deliberately not sent.

On the write path the order is: the plan is built, the cluster simulates it, and then

- the simulation failed -> exit 1, with the program's own error name and message,
- no `--execute` -> exit 5, nothing sent,
- prompt declined -> exit 5, nothing sent,
- sent and confirmed -> exit 0, with the signature and explorer link.

---

## JSON output

`--json` writes exactly one object to stdout, always the same shape, and turns colour off.

```json
{
  "ok": true,
  "command": "delta",
  "cluster": "mainnet-beta",
  "source": "api",
  "available": true,
  "observedAt": "2026-08-09T11:59:03.000Z",
  "data": { "deviationBps": 42, "thresholdBps": 100, "withinThreshold": true },
  "error": null
}
```

`available: false` with `data: null` is the honest answer when upstream has not published a metric.
It is never padded out with zeros, in JSON or on screen: a rendered `0` and an absent number look
the same to a reader, so absent numbers are simply not rendered.

`poyz keeper run` is the one exception to "exactly one object": the loop writes one envelope per
observation, one per line, so it can be piped into a log processor. `--once` produces a single
object like every other command.

---

## Key handling

- The keypair path comes from `--keypair <path>` or `POYZ_KEYPAIR`, and nothing else. There is no
  default location, no wallet profile lookup, and no shelling out to another tool.
- The shared Solana CLI wallet directory (`~/.config/solana`) is **refused**, not read. That key is
  global state shared with every other tool on the machine; point `--keypair` at a file that belongs
  to this deployment.
- Only the public key is ever printed. No error message is built from file content, so a malformed
  key file cannot echo itself into a terminal or a CI log.
- Buffers holding key material are zeroed once the signer has its own copy.
- A keypair file readable by group or other produces a warning on stderr with the `chmod` to fix it.

---

## GitHub Action

`action/action.yml` is a composite action that runs `poyz delta` and fails the workflow when the
band is breached.

```yaml
- id: delta
  uses: ./packages/cli/action
  with:
    max-deviation-bps: "100"
    cluster: mainnet-beta
    source: auto
```

| Input | Default | Meaning |
| --- | --- | --- |
| `cli-package` | `""` | npm spec to install globally. Empty builds `packages/cli` from the checkout, which is the only default that runs today because `poyz-cli` is not on npm |
| `workspace` | `${{ github.workspace }}` | Checked-out POYZ repository root, used when `cli-package` is empty |
| `max-deviation-bps` | `100` | Fail above this many basis points |
| `api` / `cluster` / `source` / `program-id` | SDK defaults | Passed through to the CLI |
| `fail-on-unavailable` | `false` | Whether a metric that was never published should fail the run |

Outputs: `delta-bps`, `within-threshold`, `available`, `exit-code`. The job summary gets a table of
the reading and the per-venue exposure.

Copy `action/example-workflow.yml` into `.github/workflows/` for a monitor that runs every 30
minutes. It contains two jobs: one for use inside the POYZ repository, and one for use from another
repository, which checks POYZ out into a subdirectory and points `workspace` at it. Delete the one
you do not need.

---

## Offline funding projection

`poyz simulate` touches no network, no wallet and no chain. It runs the protocol's own buffer model
over numbers you supply, which makes it the way to ask what a negative funding regime does before
committing anything:

```bash
poyz simulate --amount 100000 --days 90 --rate -0.15 --buffer 20000 --supply 1000000
```

A negative `--rate` is the interesting case: the output shows the daily drain, the buffer runway in
days, the playbook stage, and whether that stage restricts issuance or reduces hedge notional. Every
run prints the disclaimer that comes with the result, because a projection over a market rate is a
projection.

---

## Honest framing

- **Funding is a market rate.** It is positive when the perp trades above spot and negative when it
  does not. In a negative regime the protocol pays instead of being paid, and the staked position
  carries that cost. `poyz funding` says "protocol pays" in words as well as in colour.
- **Staking is the exposure.** Holding the synthetic dollar is holding a dollar; staking it is what
  takes the funding position, in both directions.
- **A keeper bond is slashable.** The protocol authority can move it into the insurance buffer
  against a reason code and an evidence hash. The program checks what it can about a proof (sequence,
  slot monotonicity, and that the post-rebalance delta is inside the band) but it cannot check that
  the venue trade happened. That is what the bond is for.
- **A bond is not liquid.** `poyz keeper unbond` is rejected while the unbond cooldown since the last
  committed proof is running, and a partial withdrawal that would drop the bond under the protocol
  minimum is rejected too.
- **`poyz keeper run` commits nothing.** No hedge venue is wired into the program yet, so the loop
  observes and reports. Committing a proof for a rebalance that did not happen is precisely what the
  slash path punishes, so it does not.
- **Mint and redeem are requests.** See "Issuance is two-phase" above.
- **The program is not deployed.** Deployment is a separate, explicitly approved step. Until it
  happens, simulations fail with the cluster's own "program does not exist" error.

---

## License

MIT.
