# Contributing

Thanks for taking a look. This covers what a change is expected to carry, and the two
conventions enforced by CI rather than by review.

## Building

```bash
git clone https://github.com/poyzfi/poyz-sdk.git
cd poyz-sdk

npm install       # workspace root: links the three packages to each other
npm run typecheck
npm run build
npm test
```

This repository is an npm workspace. `@poyz/sdk` depends on `@poyz/risk-buffer` and
`poyz-cli` depends on `@poyz/sdk`, and neither is published to a registry yet, so the
workspace link is what makes a plain `npm install` resolve. Installing inside a single
package directory will fail with `E404`; install from the root.

Work on one package with `--workspace`:

```bash
npm run test --workspace @poyz/sdk
npm run build --workspace poyz-cli
```

## Commit messages

Write a plain sentence describing what the change does.

```
annualise funding from the venue interval instead of assuming hourly
return null rather than zero when the API omits a reading
add the negative regime to the funding projection
```

**Colon prefixes are rejected by CI.** `feat:`, `fix:`, `chore:`, `docs(sdk):` and anything
else shaped like `word:` or `word(scope):` fails the `commit messages` workflow.
Conventional Commits is a coordination protocol for large teams; this repository does not
use it, and a history carrying both styles reads as machine generated.

Also rejected: emoji, and `Co-authored-by` / `Signed-off-by` trailers.

Check before committing:

```bash
./scripts/check-commit-messages.sh --message "your subject line here"
./scripts/check-commit-messages.sh --range origin/main..HEAD
```

## Conventions

- **No emoji.** Anywhere: code, comments, documentation, commit messages. Use `O` / `X` or
  `PASS` / `FAIL` where a status marker is needed.
- **No stub markers on main.** `// TODO`, `// FIXME`, `throw new Error("not implemented")`,
  empty function bodies. If a path is not finished, leave it out and say so.
- **Nullable means nullable.** A reading the protocol cannot produce is `null`, never `0`
  and never a placeholder string. Consumers gate on `isPresent`. A change that substitutes
  a default for a missing reading will be rejected.
- **Estimates are labelled.** Anything derived rather than measured carries the estimate
  flag through to the caller. Do not smooth it away in a render path.
- **The generated IDL is generated.** `packages/sdk/src/generated/idl.ts` comes from
  `idl/poyz.json` in [poyzfi/poyz](https://github.com/poyzfi/poyz) via
  `npm run sync-idl --workspace @poyz/sdk`. Do not hand-edit it; regenerate it when the
  program changes, in the same pull request as the code that depends on the change.

## Risk language

The yield behind these numbers is perpetual funding, a market rate that goes negative.
Documentation must not describe it as `risk-free`, `guaranteed`, or `no downside`. Name the
failure mode and let the reader decide.

## Pull requests

1. One logical change per pull request.
2. `npm run typecheck`, `npm run build` and `npm test` clean from the repository root.
3. If the program interface changed, the regenerated IDL is in the same commit.
4. If behaviour changed, say which README or doc comment you updated, or why none needed it.
5. Security-relevant findings go through `SECURITY.md`, not a public pull request.

## Layout

| Path | Contents |
| --- | --- |
| `packages/sdk/` | `@poyz/sdk`, the client library |
| `packages/cli/` | `poyz-cli`, plus the delta-monitor GitHub Action under `action/` |
| `packages/risk-buffer/` | `@poyz/risk-buffer`, buffer accounting and scenarios |
| `scripts/` | Repository policy checks, also run by CI |

The Anchor program and the protocol specifications live in
[poyzfi/poyz](https://github.com/poyzfi/poyz).
