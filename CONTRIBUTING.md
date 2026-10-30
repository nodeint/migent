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

The integration branch is `next`. Create working branches from `origin/next`
and target all feature, fix, documentation, and release PRs at `next`. CI must
run install, build, and test on Ubuntu, macOS, and Windows for every PR into
`next`. Require all three checks against the current base before merging.
The release workflow repeats build and tests on the exact tagged commit.

## Pull requests

Every development change, including release version bumps, reaches `next`
through a PR. `main` records the exact commit of the latest successfully
published release; it advances only after all four packages are public and
verified.

Configure branch protection as follows:

- On `next`, require a PR and successful `test (ubuntu-latest)`,
  `test (macos-latest)`, and `test (windows-latest)` checks against the current
  base. Require resolved conversations; a second review is optional for a
  solo maintainer. Use squash merges and delete working branches after merge.
- Block force-pushes and deletion on both `next` and `main`.
- On `main`, allow only the designated release maintainer or automation to
  fast-forward to the verified release commit. Do not require a squash PR
  for this update: it must preserve the tagged commit SHA. Scope any required
  protection exception to that release actor.
- Keep `v*` tags immutable once pushed. A maintainer pushes the release tag.

### Migration prerequisites

The `next` protection definition is `.github/next-ruleset.json`; it requires
PRs, current-base CI, linear history, and resolved conversations, with no
bypass actors. CI targets both `main` and `next`. Local safeguards protect
both branches; reinstall them with `pnpm setup:git` after pulling updates.
The CI trigger change must reach the remote branch before relying on PR
checks into `next`.

The remaining release migration prerequisites are:

1. Set `next` as the repository default branch for development and PRs.
2. Update `.github/main-ruleset.json` and GitHub protection for the restricted
   post-publication fast-forward described above.
3. Change the release workflow's tag ancestry check from `origin/main` to
   `origin/next`. Continue building and packing the tagged commit.
4. Add a guarded release-only fast-forward path to the local safeguards.
   Direct pushes to both long-lived branches currently remain blocked.

Do not bypass hooks or protection, or advance `main` before publication to
work around an unmigrated check. The release migration steps above must be completed before publishing
with the new flow.

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

All four packages share one version and are released together.

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

### 2. Tag the merged commit

Pushing the tag starts the release workflow. Read the exact merged commit SHA
from the release PR; verify it is on `origin/next`, all four package versions
are `0.2.0`, and its changelog contains that release. Do not select a commit
only by subject or tag the pre-merge release branch.

```bash
git fetch origin
git tag v0.2.0 <sha>
git push origin v0.2.0
```

The tag must equal every package version, or the workflow stops at its first
check. It must also be on `next`. Migrate the workflow ancestry check before tagging.
Never move an existing tag, and never tag an unmerged release PR.

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
for package in migent-kernel migent-adapters migent-registry migent; do
  npm view "@nodeint/$package@0.2.0" version
done
npm i -g --prefer-online @nodeint/migent@0.2.0
migent --version
```

`--prefer-online` matters for the first few minutes: npm may still have cached
metadata without the new version and fail with `ETARGET`.

### 5. Synchronize main with the published release

Staging packages and creating a GitHub Release do not complete publication.
After all four packages are approved, verify their exact versions and the
installed CLI version. Then fast-forward `main` to the exact tagged release
commit. There is a short interval between publication and this update; the
branches and public packages are synchronized when the release completes.

The migrated release safeguard must validate publication before allowing
this update. Use a clean checkout and the authorized release actor:

```bash
git fetch origin main next --tags
git rev-parse 'v0.2.0^{commit}' # must equal the release PR's merged SHA
git merge-base --is-ancestor v0.2.0 origin/next
git merge-base --is-ancestor origin/main v0.2.0
# Continue only if both ancestry checks and publication verification passed.
git push origin refs/tags/v0.2.0:refs/heads/main
git fetch origin main
git rev-parse origin/main 'v0.2.0^{commit}' # both SHAs must match
```

Do not merge the latest `next` HEAD: it may already contain work for the next
release. Do not create a separate merge or squash commit on `main`. If `main`
has diverged, or hooks/protection reject the update, stop and resolve the
configuration or history issue without force-pushing or bypassing safeguards.

If publication fails or is partial, leave `main` unchanged and keep the tag
intact. Verify existing package versions and staging state before any retry;
never try to publish an already public package version again. Use a new patch
release when the failed version cannot be completed safely.

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
