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
pnpm lint        # inspect
pnpm lint:fix    # automatic fixes
pnpm lint:strict # zero warnings
```

Append `-- <paths>` for scoped checks. See `scripts/wrappers/run-eslint.mjs`.

## Issues

Use `.github/ISSUE_TEMPLATE/`: `bug.yml` for bugfixes, `feature.yml` otherwise;
labels follow Work types. Blank issues are disabled; write issues in English.

Read issues and comments through the API (`gh issue view` may return nothing):

```bash
gh api repos/nodeint/migent/issues/<n>
gh api --paginate repos/nodeint/migent/issues/<n>/comments
```

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

## Branch and pull request rules

- `next` is the integration/default branch; `main` holds the latest release,
  advanced by `release.yml`. Never commit/push directly to either, force-push,
  use `--no-verify`, or bypass protections.
- Require `origin/next`; branch from it with no upstream. Use the work-type prefix
  above or `release/X.Y.Z`. Later upstreams must be `origin/<same-branch-name>`;
  remove incorrect tracking and push with an explicit same-name refspec.
- All changes enter `next` via draft PRs, squash-merged; delete working branches
  afterward. Require resolved conversations, linear history, and no bypass actors.
  Title/commit subject: one short imperative line. Include supplied attribution
  in commits and PRs.
- Fill `.github/pull_request_template.md`; link closing issues with `Fixes #<n>`.
- User-visible changes add a bullet ending with its PR link under the appropriate
  `## Unreleased` category in `CHANGELOG.md`, in the same PR. Only releases
  change package versions.

## Release procedure

Prepare → approve notes → open PR → pass CI → authorized merge → verify publishing.

### Publishing prerequisites

- `main: immutable release history`: block deletion/force-push, allow release token
  fast-forward. Legacy `main: release maintainers only` blocks publishing; stop
  and obtain approval before changing rulesets.
- Immutable `v*` tags are created only by `.github/workflows/release.yml`; never
  create or move them manually.
- Each npm package needs trusted publisher `nodeint/migent`, workflow `release.yml`,
  empty environment, action `npm publish`. Update publisher settings if workflow,
  repository, or `repository.url` changes. First publication must be manual;
  configure trusted publishing before dispatching subsequent publication.

### Prepare and review

- Fetch `origin` and tags; require a clean entry tree, preserve unrelated work,
  and resume existing release branches/PRs. Revisions retain only expected release edits.
- Compare `git log <previous-tag>..HEAD` with Unreleased for missing changes;
  stop if there is no user-facing change.
- Use the requested version; otherwise confirm one before editing, based on the
  highest workspace version or release tag:

| Categories | Before 1.0 | From 1.0 |
| --- | --- | --- |
| Breaking, Removed | minor | major |
| Added, Deprecated | minor | minor |
| Changed, Fixed, Security only | patch | patch |

- CLI/public wire incompatibilities are Breaking; internal-only changes are not.
  Stop if the tag exists locally/remotely or the version was ever published to npm.
- Create `release/X.Y.Z` under the branch rules above.
- Draft `CHANGELOG.md` only: no version bumps, commits, pushes, or PR until notes approval.
  Review version/notes/diff locally; approval needs neither CI nor an existing release commit.
- Move Unreleased into `## X.Y.Z` (no date), leaving Unreleased empty. An unchanged
  changelog blocks release; never rewrite released notes.
- Categories: Breaking, Added, Changed, Deprecated, Removed, Fixed, Security; omit empty ones.
  Use 1–2 sentences per bullet under the changelog rules above; Breaking includes
  migration steps. Exclude internal refactors, CI, tests, and internal docs.
- Keep five versions in full; move older versions to GitHub Release links under
  `## Older versions`, newest first, preserving existing links.

### Open PR and pass CI

After notes approval, synchronize all workspace versions:

```bash
pnpm -r exec npm pkg set version=X.Y.Z
pnpm install
pnpm build
# Run the full suite with client CLIs off PATH, as above.
```

- Only `CHANGELOG.md`, `packages/*/package.json`, and changed `pnpm-lock.yaml` belong
  in the release commit. Never edit `packages/cli/src/version.ts` or the version in
  `docs/backlogs.md`. Confirm the diff matches approved notes/version.
- Commit/title: `Release X.Y.Z`. Push and open the PR under the rules above,
  using `gh pr create --body-file <notes>`.
- Wait for required CI; mark ready only when green.
  If `next` advances, update and repeat review/checks. Changed notes/version
  need approval again.

### Merge and verify

- A named-version request authorizes preparation and pushing the PR; merging needs
  explicit authorization (reuse existing authorization). Confirm publishing
  prerequisites before merging.
- Squash-merge with subject `Release X.Y.Z (#N)`; `.github/workflows/release.yml`
  validates versions, tags, advances `main`, creates a GitHub Release, and publishes
  via npm OIDC.
- Find the run with `gh run list --workflow release.yml --branch next --commit <sha>
  --json databaseId,status,conclusion,url`; watch with `gh run watch <id> --exit-status`.
  If absent, retry every 30 seconds, at most five times. On failure, report job/step and stop.
- After success, fetch; confirm `origin/main` equals the tag commit; install
  `npm i -g --prefer-online @nodeint/migent@X.Y.Z` and check `migent --version`.
  Report version, tag, run URL/result, GitHub Release URL, npm and `main` results.

### Recovery

- After fixing the cause, use `gh run rerun <id> --failed`; verify reused tags,
  releases, and packages. A tag alone does not prove npm or `main` succeeded.
- Existing tag without a retryable run: `gh workflow run release.yml --ref next -f version=X.Y.Z`
  (npm job only).
- Versions are single-use even after unpublishing. If completion is impossible,
  release the next patch. Deprecate bad releases rather than deleting:
  `npm deprecate "@nodeint/migent@X.Y.Z" "Upgrade to X.Y.W"`.
- For propagation/ETARGET, use `--prefer-online` and check
  `npm view "@nodeint/<package>@X.Y.Z" version`.
- Manual publishing: avoid `pnpm -r publish` (2FA hangs); use
  `pnpm -r pack --pack-destination <dir>`,
  then `npm publish <tarball> --access public`. Never publish package directories
  directly: workspace references remain unresolved.
- Dependency order: `@nodeint/migent-{contracts,workflow,prompts,kernel,session,engine,doctor,adapters,registry}`,
  then `@nodeint/migent`. Packages use `@nodeint`; unscoped `migent` was rejected,
  and `@migent` is reserved against squatting.
