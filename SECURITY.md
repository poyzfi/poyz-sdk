# Security Policy

## Reporting a vulnerability

Report privately. Do not open a public issue, and do not describe the finding in a
pull request.

Use GitHub's private vulnerability reporting on this repository:
**Security -> Report a vulnerability**
(<https://github.com/poyzfi/poyz-sdk/security/advisories/new>). It creates a private
advisory thread visible only to the maintainers and to you.

If that route is unavailable, send a direct message to
[@poyzfi](https://x.com/poyzfi) asking for a private channel. Do not put finding details in
a public post.

Include what you have: the affected package and function, the conditions required, and what
an attacker gains. A failing test is useful but not required to report.

## What to expect

| Stage | Target |
| --- | --- |
| Acknowledgement of the report | 72 hours |
| Initial assessment and severity | 7 days |
| Fix or documented mitigation for a confirmed high-severity finding | 30 days |
| Public disclosure | after a fix ships, coordinated with the reporter |

If a report goes unacknowledged past 72 hours, ping the same channel. Silence is a failure
on our side, not a rejection.

## Scope

The highest-severity class here is **a transaction that does something other than what the
caller was shown**. These packages build and display transactions that a user then signs,
so a mismatch between the rendering and the instruction data is a real exploit path even
though none of this code runs on chain.

In scope:

- `@poyz/sdk` instruction builders and PDA derivation: wrong account, wrong index, wrong
  amount, or a discriminator that does not match the instruction being described.
- `@poyz/sdk` Borsh decoding, where a malformed account could be decoded into a plausible
  but wrong read model.
- `poyz-cli` confirmation and dry-run behaviour, in particular anything that causes a write
  to be sent without `--execute`, or a confirmation prompt that misstates the transaction.
- Keypair handling in `poyz-cli`: any path that logs, transmits, or persists private key
  material.
- `@poyz/risk-buffer` accounting where an error would understate depletion or wipeout.
- The GitHub Action under `packages/cli/action`, in particular command injection through
  workflow inputs.

Out of scope:

- Findings that require a compromised signer key or a maliciously modified client.
- The on-chain program itself, and the protocol specifications. Those belong to
  [poyzfi/poyz](https://github.com/poyzfi/poyz) and its security policy.
- Denial of service against public RPC endpoints or the status API, which this project does
  not operate.
- Market risk. Negative funding, venue outages and liquidation are inherent to the design
  and are documented in the protocol repository. Those are disclosures, not
  vulnerabilities. A defect in how this code *reports* one of them is in scope.
- Automated scanner output with no demonstrated impact.
- Advisories against transitive dependencies with no reachable call path here. Say which
  call path reaches it and the report is in scope.

## Status

Neither `@poyz/sdk` nor `poyz-cli` is published to npm, and the protocol program is not
deployed to Solana mainnet. There is no live deployment to attack today, and no funds are
at risk. Reports against the source are still welcome and are the cheapest time to fix
anything.

This project has not been audited.

## Safe harbour

Good-faith research against a local validator, a devnet deployment, or a private fork is
welcome, and we will not pursue action over it. Do not test against third-party mainnet
infrastructure, do not access data that is not yours, and do not run anything that degrades
service for others.
