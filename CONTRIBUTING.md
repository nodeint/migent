# Contributing to Migent

Repository: `nodeint/migent`.

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

## Testing

Tests use Vitest with explicit imports (`import { expect, test } from 'vitest'`; no globals).
Package tests live in `packages/<package>/test/`, cross-package suites in `integration/`.

### Unit and integration tests

| Kind | File | Run | Use for |
| --- | --- | --- | --- |
| Unit | `*.test.ts`, `scripts/**/*.test.mjs` | `pnpm test:unit`; no build | Behavior inside the test process: functions, and command entry points run through `main()` with injected fakes. Child processes, `git` repositories, and local sockets may serve as fixtures, such as scripted `node -e` providers or a temporary repository |
| Integration | `*.integration.test.ts`, `scripts/**/*.integration.test.mjs` | `pnpm test:integration`; build first; files run one at a time | Tests whose subject is a process, socket, cross-process lock, signal, `git` itself (such as installed hooks), or the built CLI (`packages/cli/dist`) |

- Classify a test by what it checks, not by what it uses. Name it `*.integration.test.*` when the behavior under
  test is one of the subjects above; otherwise it is a unit test, even if it uses a child process, a `git`
  repository, or a socket as a fixture, and even under `integration/`.

### Writing tests

- Decide whether a test should exist with the `testing` skill: tests protect logic, not coverage.
- Name each test as a behavior sentence: `test('a command that is not on PATH warns too', ...)`.
- Test one behavior per test and assert what a user or caller observes: exit code, stdout and stderr, files, JSON.
- Never call real client CLIs. Inject fake `which`/`runCommand` into command entry points.
  End-to-end tests put `integration/fixtures/bin` first on `PATH`.
- Give each test a fresh temp directory (`mkdtempSync` or `tempWorkspace`) and remove it in `finally` or `afterEach`.
- Put helpers in `test/support.ts` and fixtures in `test/fixtures` of the same package.
- Use snapshots only to pin serialized output such as `--json` payloads, rendered prompts, and file bytes.
- Tests must pass on Ubuntu, macOS, and Windows. Guard POSIX-only behavior with
  `test.skipIf(process.platform === 'win32')`.

## Verify changes

Run from the repository root after changing code, tests, scripts, or build configuration.
Read-only work, planning, review, and issue triage need no checks.

### Checks

Scope each check to the change; full test and lint runs are very slow.

| Check | Command | Notes |
| --- | --- | --- |
| Lint | `pnpm lint -- <paths>` | |
| Unit tests | `pnpm test:unit <paths>` | Pass paths without `--`, or every test runs. Add `-t "<name>"` to select tests. |
| Unit coverage | `pnpm test:coverage` | Reports to `coverage/`. |
| Integration tests | `node scripts/wrappers/run-integration.mjs --file <suite> [--case <name>]` | `--file` matches path substrings and repeats. `--case` takes one name and requires `--file`. |
| Typecheck and build | `pnpm build` | |
| Unused code and exports | `pnpm knip` | Whole repository, no paths. Must report nothing. |
| Duplicate code | `pnpm jscpd` | Whole repository, no paths. Must stay under the `.jscpd.json` threshold. |

- A scoped check must run at least one file or test. Ignored files and empty selections do not count.
- Run integration tests with `node`, not `pnpm`, when `--case` contains spaces;
  `pnpm` fails on Windows when its install path has a space.

### Documentation-only changes

Run only `pnpm lint:md -- <paths>`, `pnpm lint:md:links -- --path <directory>` when links changed,
and `git diff --check`.

### Before pushing

- Run the changed-package checks and `pnpm gate` if available.
- Run the full suite without client CLIs: `PATH=/usr/bin:/bin:$(dirname "$(which node)") pnpm test`.
- CI must pass on Ubuntu, macOS, and Windows. Report failures and stop.

### Reporting

Report each command with its result, and name any check not run with the reason.

## CLI conventions

Apply these when adding or changing a command. Command syntax and behavior live in [CLI](docs/cli.md);
exit codes, `--json` fields, and environment variables are generated in [Reference](docs/reference/cli-output.md).

| Topic | Convention |
| --- | --- |
| Machine output | `--json` prints exactly one JSON object on stdout, typed by a schema in `@nodeint/migent-contracts`; serialize it only with `writeJson`. `get` also accepts `-o json`, `-o yaml`, and `-o name`. |
| Streams | Results go to stdout. Errors, notices, and next-step hints go to stderr. |
| Messages | Errors use `printError` (prefix `migent:`); notices use `printNotice` (prefix `[migent]`). Color only when stderr is a TTY. |
| Next step | A command that stops before finishing prints the command that continues it, as `Resume with:` or `Reply with:`. |
| Prompts | Prompt only when stdin is a TTY and neither `--no-input` nor `MIGENT_NO_INPUT=1` is set. `-y, --yes` pre-answers confirmations. |
| Preview | Commands that change state or the network offer `--dry-run` or `--check` when a preview is meaningful. |
| Exit codes | Use the names in `@nodeint/migent-contracts` through `packages/cli/src/exits.ts`; do not add ad hoc codes. |
| Help | List the exit codes with `exitText(...)` and add examples for commands with several modes. |

Update [CLI](docs/cli.md) with any change to a command, flag, output, or exit behavior.

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
