# Contributing to Migent

Rules for working in this repository. User-facing behavior is in

## Setup and commands

Node.js 22 or later (CI uses 24), pnpm 12.6.0; macOS, Linux, or Windows.

```bash
pnpm install
pnpm setup:git       # local branch and push safeguards; rerun after pulling hook changes
pnpm build
pnpm test:unit       # unit project: needs no build output
pnpm test:integration # *.integration.test.ts: spawns real processes, needs a build
pnpm test            # both projects; or: pnpm vitest run <file> [-t "<name>"]
```

## Packages

| Path | Package | Role |
|---|---|---|
| `packages/contracts` | `@nodeint/migent-contracts` | Public data contracts (TypeBox): CLI JSON output, config structure, exit codes, env catalog |
| `packages/workflow` | `@nodeint/migent-workflow` | Workflow model, parser, catalog |
| `packages/prompts` | `@nodeint/migent-prompts` | Prompt templates |
| `packages/kernel` | `@nodeint/migent-kernel` | Config, authoring, migration, outputs, process execution |
| `packages/session` | `@nodeint/migent-session` | Stored session state |
| `packages/engine` | `@nodeint/migent-engine` | Workflow execution |
| `packages/doctor` | `@nodeint/migent-doctor` | Health checks |
| `packages/adapters` | `@nodeint/migent-adapters` | Client adapters |
| `packages/registry` | `@nodeint/migent-registry` | Workspace registry service |
| `packages/cli` | `@nodeint/migent` | The `migent` command |
| `integration/` | — | End-to-end tests with fake clients |

## Package rules

Before changing a package, read its `README.md`: package rules and key symbols.
Import packages by name, never by relative path across package boundaries. Do
not edit `dist/` or `docs/reference/` by hand.

## Test rules

- Never call a real client CLI. Pass the fake `which` and `runCommand` to every
  command entry point; integration tests use `integration/fixtures/bin`.
- Use a fresh temporary directory per test and remove it in `finally`.
- Before pushing, run the suite without client CLIs on `PATH`:
  `PATH=/usr/bin:/bin:$(dirname "$(which node)") pnpm test`.
- CI runs on Ubuntu, macOS, and Windows; all three must pass.

## Branch and pull request rules

- `next` is the integration branch; `main` only holds the latest release and is
  advanced by `release.yml`. Never commit or push to either, force-push, use
  `--no-verify`, or bypass protection.
- Branch from `origin/next` with no upstream: `feat/`, `fix/`, `docs/`,
  `chore/<slug>`, or `release/X.Y.Z`.
- Every change reaches `next` through a draft PR, squash-merged. The PR title is
  the commit subject: one short imperative line.
- Issues use the forms in `.github/ISSUE_TEMPLATE/`; PRs fill
  `.github/pull_request_template.md` and link the issue with `Fixes #<n>`.
- A user-visible change adds a short bullet with its PR link under the right
  category of `## Unreleased` in `CHANGELOG.md` (see the release skill) in
  the same PR. Only a release PR changes package versions.

## Migent workflows

`.migent/workflows/` runs the same path: `issue` (triage, branch) → `plan`
(only when architecture decisions are needed) → `implement` → `pr` (draft PR,
no merge). Downstream workflows do not start automatically; start each one from
the completed session with `--prior` (see [Session handoff](docs/session-handoff.md)).

`release` prepares the release PR (version proposed by SemVer, notes reviewed),
then merges only after you authorize it and watches `release.yml`:
`migent session run --workflow release --task "Release"`, or name a version in the task.
