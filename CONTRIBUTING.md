# Contributing to Migent

This guide covers local development, testing, and releases. User-facing
behavior is documented in [README.md](README.md) and [docs/](docs/).

## Requirements

- macOS, Linux, or Windows.
- Node.js 22 or later. CI uses Node 24.
- pnpm 12.6.0.

## Repository layout

| Path | npm package | Role |
|---|---|---|
| `packages/contracts` | `@nodeint/migent-contracts` | Public data contracts (TypeBox schemas) |
| `packages/prompts` | `@nodeint/migent-prompts` | Prompt templates and renderers |
| `packages/kernel` | `@nodeint/migent-kernel` | Workflow engine, config, session store, libc bindings |
| `packages/doctor` | `@nodeint/migent-doctor` | Health checks and diagnostics: config, workflows, clients, sessions, model availability |
| `packages/adapters` | `@nodeint/migent-adapters` | Antigravity, Claude, Codex, Grok, and OpenCode clients |
| `packages/registry` | `@nodeint/migent-registry` | Machine-local workspace registry service |
| `packages/cli` | `@nodeint/migent` | The `migent` command |
| `integration/` | — | End-to-end tests against fake client binaries |

Users install `@nodeint/migent`. `@nodeint/migent-contracts` is the public
data contract: its schemas describe the CLI's JSON output and the structure of
the config files, additive changes are
allowed in minor releases, and a breaking wire change needs a major release.
It is a leaf package that depends only on `typebox`; the kernel depends on it
to validate config structure. The other packages have no
stable API and are published only because the CLI depends on them. Import them by
package name (`@nodeint/migent-kernel`), never by relative path across package
boundaries.

The workspace root is `migent-monorepo` and is private.

## Everyday commands

```bash
pnpm install
pnpm setup:git       # install local branch and push safeguards
pnpm build           # tsc -b for all packages, then copy CLI templates
pnpm test            # vitest: packages/**/test and integration/
pnpm migent --help   # run the local build
```

Run one file or one test:

```bash
pnpm vitest run packages/cli/test/config.test.ts
pnpm vitest run packages/cli/test/config.test.ts -t "keeps the model name"
```

## Writing tests

- **Never call a real client CLI.** Pass the test's fake `which` *and*
  `runCommand` to every command entry point. A missing `runCommand` falls back
  to `spawnSync` on whatever `codex` or `grok` is on `PATH`: it passes on a
  developer machine and fails on CI.
- Integration tests put `integration/fixtures/bin` on `PATH` instead. Each fake
  client there is a `sh` shim and a `.cmd` shim around
  `integration/fixtures/fake-provider.mjs`, so Windows runs exercise the same
  `.cmd` path as npm-installed CLIs.
- Before pushing, run the suite with client CLIs off `PATH` to catch the
  above:

  ```bash
  PATH=/usr/bin:/bin:$(dirname "$(which node)") pnpm test
  ```

- Use a fresh temporary directory per test and remove it in `finally`.

## Platform notes

CI runs the suite on Ubuntu, macOS, and Windows. Code that passes on one can
fail on another, mostly around processes. Process and lock code uses Node
built-ins and `proper-lockfile` only; do not add native dependencies or libc
calls.

- **Liveness comes from local endpoints, not pids.** The client wrapper and
  the registry service each listen on a Unix socket (a named pipe on Windows)
  for as long as they run. Another process proves one is alive by connecting;
  the OS frees the endpoint when the process dies, so pid reuse cannot fool
  it. Keep socket paths under 100 bytes; `wrapperEndpoint` and
  `serviceEndpointPath` fall back to a short path in the temp directory.
- **Owner death arrives over IPC.** Children that must not outlive their
  parent (the client wrapper, the registry child before it is published) get
  an `ipc` stdio slot and act on `disconnect`, which fires even when the
  parent is killed with SIGKILL.
- **Stop process trees with `killProcessTree`.** On POSIX it signals the
  process group (spawn with `detached: true`); on Windows it runs
  `taskkill /T /F`, and `detached` must stay false to avoid a new console.
- **Locks are `<path>.lock` directories** from `proper-lockfile`. A holder that
  dies leaves the lock stale for a few seconds before others can take it.
- The kernel process wrapper and the registry child re-execute their own
  module files (`import.meta.url`). Do not bundle the packages into a single
  file; that breaks those entry points.

## Continuous integration

The integration branch is `next`. Create working branches from `origin/next`
and target all feature, fix, documentation, and release PRs at `next`. CI must
run install, build, and test on Ubuntu, macOS, and Windows for every PR into
`next`. Require all three checks against the current base before merging.
The release workflow repeats build and tests on the merged release commit.

## Pull requests

Every development change, including release version bumps, reaches `next`
through a PR. `main` records the exact commit of the latest release; the
release workflow fast-forwards it to the tagged commit before publishing to npm.

Configure branch protection as follows:

- On `next`, require a PR and successful `test (ubuntu-latest)`,
  `test (macos-latest)`, and `test (windows-latest)` checks against the current
  base. Require resolved conversations; a second review is optional for a
  solo maintainer. Use squash merges and delete working branches after merge.
- Block force-pushes and deletion on both `next` and `main`.
- On `main`, do not require a PR: the release workflow fast-forwards it to the
  release commit, which must preserve the tagged commit SHA.
- Keep `v*` tags immutable once pushed. The release workflow creates them.

### Migration prerequisites

The `next` protection definition is `.github/next-ruleset.json`; it requires
PRs, current-base CI, linear history, and resolved conversations, with no
bypass actors. CI targets both `main` and `next`. Local safeguards protect
both branches; reinstall them with `pnpm setup:git` after pulling updates.
The CI trigger change must reach the remote branch before relying on PR
checks into `next`.

Release configuration must match the checked-in definitions:

1. Use `next` as the repository default branch.
2. Apply `.github/main-ruleset.json` to preserve release history. It has no
   update restriction, so the release workflow's `GITHUB_TOKEN` can fast-forward
   `main`; deletion, force-push, and linear-history rules have no exceptions.
   Delete any older `main: release maintainers only` ruleset.
3. The release workflow runs on pushes to `next` and acts only on a commit whose
   subject is `Release X.Y.Z (#N)` and whose package versions all equal `X.Y.Z`.
4. Run `pnpm setup:git`. The pre-push hook blocks every push to `main`
   and `next` from a clone; only the release workflow advances `main`.

Never bypass hooks or protection.

Branch names: `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `chore/<slug>`, and
`release/X.Y.Z` for releases. The pull request title is the squash commit
subject, so write it as one short imperative line.

Start work with an explicit base and no upstream:

```bash
git fetch origin
git switch --no-track -c feat/my-change origin/next
# edit, test, commit
git push -u origin refs/heads/feat/my-change:refs/heads/feat/my-change
gh pr create --draft --base next --head feat/my-change --body-file <notes>
```

Run `pnpm setup:git` once in each clone after migrating the safeguards. Working
branches start without an upstream and track their own remote name after the
first push. Hooks must block commits on `main` and `next`, direct development
pushes to either branch, and pushes to a different branch name. Tags remain
allowed. The release-only update to `main` must verify the published version
and tagged commit. Do not use `--no-verify` or force-push.

Keep published history intact. Do not reset either long-lived branch or
revert/reapply working code solely to create a retrospective PR.

A pull request that changes behavior a user can see adds a line under
`## Unreleased` in `CHANGELOG.md`, in the same pull request. Open it as a draft
until CI is green.

## Releasing

All packages share one version and are released together.

### 1. Release pull request

Create the release branch from `origin/next`. Its PR targets `next` and changes
only package versions, the changelog, and the lockfile when needed.

```bash
git fetch origin
git switch --no-track -c release/0.2.0 origin/next
# CHANGELOG.md: move ## Unreleased under ## 0.2.0, keep five versions
pnpm -r exec npm pkg set version=0.2.0
pnpm install
git add CHANGELOG.md packages/*/package.json pnpm-lock.yaml
git commit -m "Release 0.2.0"
git push -u origin refs/heads/release/0.2.0:refs/heads/release/0.2.0
gh pr create --draft --base next --head release/0.2.0 --title "Release 0.2.0" --body-file <the 0.2.0 section>
```

Merge other pull requests only before this one, or rebase it and redo the
changelog after they land. CI must pass on the release pull request. Squash
merge it; the commit subject becomes `Release 0.2.0 (#N)`.

### 2. Automatic release

Merging the release PR is the last manual step. The push to `next` starts
`.github/workflows/release.yml`, which acts only when the commit subject is
`Release X.Y.Z (#N)` and every package version equals `X.Y.Z`. In order, it:

1. takes the `## X.Y.Z` section of `CHANGELOG.md` as the release notes and fails
   when it is empty;
2. installs, builds, and tests the merged commit;
3. creates the lightweight tag `vX.Y.Z` on that commit;
4. fast-forwards `main` to that commit;
5. packs with `pnpm -r pack` (which turns `workspace:*` into exact versions) and
   runs `npm publish` in dependency order, skipping versions that are already
   public: `@nodeint/migent-contracts`, `-prompts`, `-kernel`, `-doctor`, `-adapters`,
   `-registry`, then `@nodeint/migent`;
6. installs `@nodeint/migent@X.Y.Z` and checks `migent --version`;
7. creates the GitHub Release with those notes.

It authenticates with npm trusted publishing (GitHub OIDC); there is no npm
token in the repository. Provenance is attached automatically. No one approves
packages on npmjs.com.

Git is complete (tag and `main`) before anything reaches npm. If the run fails
after step 4, `main` and the tag already point at the release commit. Fix the
cause and rerun the failed workflow run: tagging, the `main` update, publishing,
and the GitHub Release each skip work that is already done. If the version
cannot be completed, release the next patch.

### 3. Verify

The workflow already installs the published CLI. To check by hand:

```bash
for package in migent-contracts migent-prompts migent-kernel migent-doctor migent-adapters migent-registry migent; do
  npm view "@nodeint/$package@0.2.0" version
done
npm i -g --prefer-online @nodeint/migent@0.2.0
migent --version
```

`--prefer-online` matters for the first few minutes: npm may still have cached
metadata without the new version and fail with `ETARGET`.

### Trusted publisher settings

Each package on npmjs.com (including `@nodeint/migent-doctor`, which must have its trusted publisher configured before its first release) has a GitHub Actions trusted publisher:

| Field | Value |
|---|---|
| Organization | `nodeint` |
| Repository | `migent` |
| Workflow filename | `release.yml` |
| Environment | (empty) |
| Allowed actions | `npm publish` |

Renaming `release.yml`, moving the repository, or changing `repository.url`
in a manifest breaks publishing until these settings are updated. A new
package needs the same settings before its first CI release.

## Release pitfalls

- **Version numbers are single-use.** npm never accepts a version that was
  published before, even after unpublishing. If a version cannot be
  completed by rerunning the workflow, release the next patch.
- **Do not move release tags.** Tag a new version instead.
- **Only a `Release X.Y.Z (#N)` commit releases.** Do not change package
  versions in any other PR, and keep that subject format when squash merging.
- **A bad release is deprecated, not deleted:**

  ```bash
  npm deprecate "@nodeint/migent@0.1.0" "Upgrade to 0.1.2"
  ```

- **Interactive `pnpm -r publish` hangs.** pnpm hides npm's 2FA prompt in
  recursive mode. For a manual publish, pack with pnpm and publish each
  tarball with npm, kernel first:

  ```bash
  pnpm -r pack --pack-destination /tmp/migent-release
  npm publish /tmp/migent-release/nodeint-migent-kernel-<version>.tgz
  ```

  Never publish from a package directory with plain `npm publish`; it leaves
  `workspace:*` ranges unresolved.

- **Names:** npm rejected the unscoped name `migent` as too similar to
  `moment` and `giget`. Everything lives under the `@nodeint` org; the `@migent`
  org is held only to keep the name from being squatted.
