# Contributing to Migent

Repository: `nodeint/migent`. Reply in the user's language.

## Setup

Node.js ≥22 (CI: 24), pnpm 12.6.0; macOS, Linux, Windows. Run from repo root:

```bash
pnpm install
pnpm setup:git # before branching/committing; rerun after hook changes
pnpm build     # TypeScript build + templates
```

## Packages

Paths are `packages/<name>`; package names are `@nodeint/migent-<name>`, except
`cli` → `@nodeint/migent`.
Use `@nodeint`; unscoped `migent` was rejected and `@migent` is reserved against squatting.

| Name | Owns |
| --- | --- |
| contracts | TypeBox public contracts: CLI JSON, config, exit codes, environment catalog |
| workflow | Workflow model, parser, catalog |
| prompts | Prompt templates |
| kernel | Config, authoring, migration, outputs, process execution |
| session | Stored session state |
| engine | Workflow execution |
| doctor | Health checks |
| adapters | Client adapters |
| registry | Workspace registry service |
| cli | `migent` command |

- Read each affected package's `README.md`; import cross-package code by package name.
- Never hand-edit `dist/` or `docs/reference/`.

## Test

```bash
pnpm test:unit        # no build needed
pnpm test:integration # real processes with fake clients; build first
pnpm test             # both; focused: pnpm vitest run <file> [-t "<name>"]
```

- Tests must never call real client CLIs: inject fake `which`/`runCommand` into
  command entry points; integration fixtures: `integration/fixtures/bin`.
- Each test gets a fresh temp directory, removed in `finally`.
- Before pushing, run changed-package checks, `pnpm gate` if available, and the
  full suite without client CLIs: `PATH=/usr/bin:/bin:$(dirname "$(which node)") pnpm test`.
- Required CI: Ubuntu, macOS, Windows on the current head/base; all must pass.
  Report check failures and stop.

## Lint

```bash
pnpm lint:fix    # automatic fixes; fails on remaining warnings
pnpm lint        # inspect; fails on any warning
```

Append `-- <paths>` for scoped checks. See `scripts/wrappers/run-eslint.mjs`.

## Work types

Choose one primary type per issue/branch. New types need this table and references
in the `checkout-issue` and `design` skills updated.

| Type | Meaning | Branch | Label |
| --- | --- | --- | --- |
| feature | New observable command, flag, field, output, or capability | `feat/<slug>` | `enhancement` |
| bugfix | Restore behavior promised by docs, contracts, or tests | `fix/<slug>` | `bug` |
| refactor | Restructure code; preserve behavior and contracts | `refactor/<slug>` | None |
| migration | Staged compatibility, data transformation, or cutover | `feat/<slug>` | None |
| docs | Documentation only | `docs/<slug>` | None |
| chore | Tooling, dependencies, or CI; no product behavior change | `chore/<slug>` | None |

## Issues

Use the `.github/ISSUE_TEMPLATE/` form matching the work type: `<type>.yml`; labels follow Work types.
Blank issues are disabled; write issues in English.

## Branch and pull request rules

- `next` is the integration/default branch; `main` holds the latest release,
  advanced by `release.yml`. Never commit/push directly to either, force-push,
  use `--no-verify`, or bypass protections.
- Require `origin/next`; branch from it with no upstream. Use the work-type prefix
  above or `release/X.Y.Z`. Later upstreams must be `origin/<same-branch-name>`;
  pushes use an explicit same-name refspec.
- All changes enter `next` via draft PRs, squash-merged; delete working branches
  afterward. Require resolved conversations, linear history, and no bypass actors.
  Follow the naming conventions below. Include supplied attribution in commits and PRs.
- Fill `.github/pull_request_template.md`; link closing issues with `Fixes #<n>`.
- User-visible changes add a bullet ending with its PR link under the appropriate
  `## Unreleased` category in `CHANGELOG.md`, in the same PR.

### Naming conventions

- Types: `feat`, `fix`, `refactor`, `docs`, `chore`; migrations use `feat`.
- Branch: `<type>/<issue-number>-<slug>`; omit the number without an issue.
  Slug: `[a-z][a-z0-9]*(-[a-z0-9]+)*`; issue number positive, no leading zeros.
- Commit/PR: `<type>: <imperative summary>`; short English line, no scope or final period.
  Commit describes its change; PR describes the outcome. Prefix need not match branch.
- Release: `release/X.Y.Z` → `Release X.Y.Z`, matching version, no leading zeros.
  Supporting commits may use ordinary prefixes.
- Squash: `<PR title> (#N)`. Leave existing history unchanged.
- Hooks check branch/new commit names; CI checks branch/PR title, including edits.
  Review English/imperative wording manually. Rerun `pnpm setup:git` after hook changes.

## Release policy

- Only releases change versions; all workspace package versions match.
- `.github/workflows/release.yml` owns immutable `v*` tags, fast-forwards `main`,
  creates GitHub Releases, and publishes via npm OIDC.
- `main: immutable release history` blocks deletion/force-push and permits the release
  token's fast-forward. Legacy `main: release maintainers only` blocks publishing.
- npm trusted publisher: `nodeint/migent`, workflow `release.yml`, empty environment,
  action `npm publish`; keep it aligned with workflow, repository, and `repository.url`.
- Release commits contain only `CHANGELOG.md`, `packages/*/package.json`, and changed
  `pnpm-lock.yaml`; never edit `packages/cli/src/version.ts` versions.
