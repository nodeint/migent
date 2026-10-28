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
| `packages/kernel` | `@nodeint/migent-kernel` | Workflow engine, config, session store, libc bindings |
| `packages/adapters` | `@nodeint/migent-adapters` | Antigravity, BytePlus, Claude, Codex, Grok, and OpenCode providers |
| `packages/registry` | `@nodeint/migent-registry` | Machine-local workspace registry service |
| `packages/cli` | `@nodeint/migent` | The `migent` command |
| `integration/` | — | End-to-end tests against fake provider binaries |

Users install only `@nodeint/migent`. The other three packages have no stable
API and are published only because the CLI depends on them. Import them by
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

- **Never call a real provider CLI.** Pass the test's fake `which` *and*
  `runCommand` to every command entry point. A missing `runCommand` falls back
  to `spawnSync` on whatever `codex` or `grok` is on `PATH`: it passes on a
  developer machine and fails on CI.
- Integration tests put `integration/fixtures/bin` on `PATH` instead. Each fake
  provider there is a `sh` shim and a `.cmd` shim around
  `integration/fixtures/fake-provider.mjs`, so Windows runs exercise the same
  `.cmd` path as npm-installed CLIs.
- Before pushing, run the suite with provider CLIs off `PATH` to catch the
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

- **Liveness comes from local endpoints, not pids.** The provider wrapper and
  the registry service each listen on a Unix socket (a named pipe on Windows)
  for as long as they run. Another process proves one is alive by connecting;
  the OS frees the endpoint when the process dies, so pid reuse cannot fool
  it. Keep socket paths under 100 bytes; `wrapperEndpoint` and
  `serviceEndpointPath` fall back to a short path in the temp directory.
- **Owner death arrives over IPC.** Children that must not outlive their
  parent (the provider wrapper, the registry child before it is published) get
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

`.github/workflows/ci.yml` runs install, build, and test on Ubuntu, macOS, and
Windows for every pull request into `main`. It does not run on pushes to
`main`: a change reaches `main` only through a pull request whose checks
passed. Make it a required status check on `main`. The release workflow runs the same tests again
for the tag and stops on failure.

## Pull requests

Every change, including a release version bump, reaches `main` through a
pull request. The ruleset definition is in `.github/main-ruleset.json`;
maintainers apply it in GitHub repository settings or through the API:

- Require a pull request and successful `test (ubuntu-latest)`,
  `test (macos-latest)`, and `test (windows-latest)` checks on the current base.
- Block force-pushes and deletion; leave the bypass list empty, including admins.
- Require resolved review conversations. A solo-maintained repository need not
  require a second person's approval.
- Allow squash merge only, and delete the branch after merge.
- Leave `v*` tags outside the ruleset: a maintainer pushes the release tag
  directly.

Branch names: `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `chore/<slug>`, and
`release/X.Y.Z` for releases. The pull request title is the squash commit
subject, so write it as one short imperative line.

Start work with an explicit base and no upstream:

```bash
git fetch origin
git switch --no-track -c feat/my-change origin/main
# edit, test, commit
git push -u origin refs/heads/feat/my-change:refs/heads/feat/my-change
gh pr create --draft --base main --head feat/my-change --body-file <notes>
```

Run `pnpm setup:git` once in each clone. It installs pre-commit/pre-push hooks,
disables automatic upstream inheritance, and removes working branches' accidental
`origin/main` upstreams. A branch should track its own remote name after its
first push. Hooks block commits on `main`, direct pushes to `main`, and branch
pushes to a different name, including pushes from an editor. Tags remain allowed.
Do not bypass the hooks with `--no-verify`. GitHub's ruleset enforces the PR
requirement for all clones, even when local hooks are absent.

Keep published history intact. If a commit already reached `main` directly,
retain it and fix the workflow in a new PR; do not reset or force-push main,
or revert/reapply working code solely to create a retrospective PR.

A pull request that changes behavior a user can see adds a line under
`## Unreleased` in `CHANGELOG.md`, in the same pull request. Open it as a draft
until CI is green.

## Releasing

All four packages share one version and are released together.

### 1. Release pull request

`main` is always releasable. A release is a pull request that changes only the
version and the changelog.

```bash
git fetch origin
git switch --no-track -c release/0.2.0 origin/main
# CHANGELOG.md: move ## Unreleased under ## 0.2.0, keep five versions
pnpm -r exec npm pkg set version=0.2.0
pnpm install
git add CHANGELOG.md packages/*/package.json pnpm-lock.yaml
git commit -m "Release 0.2.0"
git push -u origin refs/heads/release/0.2.0:refs/heads/release/0.2.0
gh pr create --draft --base main --head release/0.2.0 --title "Release 0.2.0" --body-file <the 0.2.0 section>
```

Merge other pull requests only before this one, or rebase it and redo the
changelog after they land. CI must pass on the release pull request. Squash
merge it; the commit subject becomes `Release 0.2.0 (#N)`.

### 2. Tag the merged commit

Pushing the tag publishes. Tag the commit on `origin/main` whose subject starts
with `Release 0.2.0`, and check that its `packages/*/package.json` say `0.2.0`.

```bash
git fetch origin
git tag v0.2.0 <sha>
git push origin v0.2.0
```

The tag must equal every package version, or the workflow stops at its first
check. It must also be on `main`, or the workflow stops at its second.

`.github/workflows/release.yml` runs on `v*` tags. It takes the `## 0.2.0`
section of `CHANGELOG.md` as the release notes, builds, tests, packs with
`pnpm -r pack` (which turns `workspace:*` into exact versions), runs
`npm stage publish` for each tarball, then creates the GitHub Release with
those notes. It authenticates with npm trusted publishing (GitHub OIDC); there
is no npm token in the repository. Provenance is attached automatically.

### 3. Approve on npmjs.com

Staged versions are invisible until a maintainer approves them with 2FA. Open
the **Staged Packages** tab on npmjs.com (or use `npm stage list` /
`npm stage approve <id>`, npm 11.15+) and approve in dependency order:

1. `@nodeint/migent-kernel`
2. `@nodeint/migent-adapters`
3. `@nodeint/migent-registry`
4. `@nodeint/migent`

Approving the CLI before its dependencies leaves `npm i -g @nodeint/migent`
broken until the rest are approved.

### 4. Verify

```bash
npm view @nodeint/migent version
npm i -g --prefer-online @nodeint/migent
migent --version
```

`--prefer-online` matters for the first few minutes: npm may still have cached
metadata without the new version and fail with `ETARGET`.

### Trusted publisher settings

Each of the four packages on npmjs.com has a GitHub Actions trusted publisher:

| Field | Value |
|---|---|
| Organization | `nodeint` |
| Repository | `migent` |
| Workflow filename | `release.yml` |
| Environment | (empty) |
| Allowed actions | stage only, not `npm publish` |

Renaming `release.yml`, moving the repository, or changing `repository.url`
in a manifest breaks publishing until these settings are updated. A new
package needs the same settings before its first CI release.

## Release pitfalls

- **Version numbers are single-use.** npm never accepts a version that was
  published before, even after unpublishing. If a release fails before
  approval, reject the staged versions and release the next patch.
- **Do not move release tags.** Tag a new version instead.
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
