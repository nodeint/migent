---
name: release
description: >
  Release Migent through a release pull request: update the changelog, bump all
  workspace packages, build and test, then squash-merge it. Watch release.yml
  tag the commit, fast-forward main, publish to npm, and create the GitHub
  Release. Use when the user asks to release, tag a version, or runs /release.
metadata:
  short-description: "Release Migent on npm"
---

# Release Migent

Follow the release pull request flow and pitfalls in `CONTRIBUTING.md`.
Never commit directly to `main` or `next`, push feature/release changes directly
to either branch, bypass branch protection, or tag an unmerged release branch.
`main` is advanced only by `release.yml`, never by hand.

Work from the repository root. Reply in the user's language.

## Version and authorization

Use the version the user names. If they do not name one, propose the next
patch after the highest of `packages/*/package.json` and the `v*` tags and
confirm the version before publishing. An explicit request to release a named
version authorizes preparing and pushing a release PR. Merging that PR tags,
publishes to npm, and advances `main`, so merge only when the user has
explicitly authorized the merge.
Do not ask again for actions already authorized.

Before merging, check the migration prerequisites in `CONTRIBUTING.md`: the
npm trusted publishers allow `npm publish` and the `main` ruleset lets the
GitHub Actions app update `main`. Stop if they do not.

## Prepare the release branch

```bash
git fetch origin --tags
git status --short
```

Require a clean working tree. If unrelated changes are present, stop and
explain; do not stash, discard, or include them. Feature work must reach next
through its own PR before the release.

Run `pnpm setup:git`, then create `release/X.Y.Z` from current `origin/next`
using `git switch --no-track -c release/X.Y.Z origin/next`. For an existing
release branch/PR, inspect and resume it instead of creating a duplicate.
Its upstream must be absent or `origin/release/X.Y.Z`, never `origin/main` or `origin/next`.

Stop if `vX.Y.Z` exists locally or on `origin`. Versions already sent to npm
are single-use, including versions that were unpublished. Use the next patch
for a failed release; never move an existing release tag.

## Prepare the release

The release commit changes only `CHANGELOG.md`, `packages/*/package.json`, and
`pnpm-lock.yaml` when that file changed.

### Changelog

Every release updates `CHANGELOG.md`. Stop when it is unchanged.

Move the body of `## Unreleased` under `## X.Y.Z`. Leave `## Unreleased` empty
above that heading. Keep `### Added`, `### Changed`, and `### Removed`. Do not
rewrite a version section that is already released.

Compare `git log <previous-tag>..HEAD` with those notes. Add every user-facing
change the notes missed, in the same voice. If `## Unreleased` is empty, write
that section from the log before moving it. Stop when the log has no
user-facing change to record.

Keep the full notes of the five newest versions, newest first. Replace the
notes of every older version with one link, newest of those first. Keep links
that are already there.

```markdown
## Older versions

- [0.1.1](https://github.com/nodeint/migent/releases/tag/v0.1.1)
```

Do not put the version in `docs/backlogs.md`. That line records when the
backlog was written.

### Validate and open the release PR

```bash
pnpm -r exec npm pkg set version=X.Y.Z
pnpm install
pnpm build
pnpm test
```

`pnpm -r` sets the same version on every package under `packages/`. The CLI
reads its version from `packages/cli/package.json`. Do not edit
`packages/cli/src/version.ts`.

Build and tests must pass locally. Follow the client isolation guidance in
`CONTRIBUTING.md`. Stop and report failures. Stage only the release files
named above, commit with `Release X.Y.Z`, then push the branch explicitly:

```bash
git push -u origin refs/heads/release/X.Y.Z:refs/heads/release/X.Y.Z
gh pr create --draft --base next --head release/X.Y.Z --title "Release X.Y.Z" --body-file <notes>
```

Wait for all three CI jobs to pass. Mark the PR ready when green. If merging
has not been authorized, report the PR URL and stop before merging.
After authorization, squash-merge the green PR with the subject
`Release X.Y.Z (#N)`; the workflow acts only on that subject. Never bypass
required checks.

## Watch release.yml

Merging pushes to `next` and starts `.github/workflows/release.yml`. Do not
create or push the tag yourself. Find the run for the merge commit and watch it:

```bash
gh run list --workflow release.yml --branch next --commit <merge-sha> \
  --json databaseId,status,conclusion,url
gh run watch <databaseId> --exit-status
gh release view vX.Y.Z
```

If the run list is empty, wait 30 seconds and list again, up to five times.

The workflow checks the package versions against the subject, takes the
`## X.Y.Z` section of `CHANGELOG.md` as the notes, builds and tests, tags the
commit, fast-forwards `main` to it, runs `npm publish` in dependency order with
GitHub OIDC (no npm token), installs the published CLI, then creates the GitHub
Release. Nobody approves packages on npm. Say the run succeeded only when its
conclusion is success, and include the run URL.

If the run fails, report the failing step. Do not move the tag or force `main`.
Once the tag exists, `main` is already at the release commit. Rerun the failed
run (`gh run rerun <id> --failed`) after the cause is fixed; each step skips
work already done. If the version cannot be completed, release the next patch.

## Verify

After a successful run, confirm `origin/main` equals the tag's commit and
`migent --version` from `npm i -g --prefer-online @nodeint/migent@X.Y.Z`
reports `X.Y.Z`. Report the version, tag, run URL, GitHub Release URL, and the
`main` result.
