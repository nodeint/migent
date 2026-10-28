---
name: migent-release
description: >
  Release Migent through a release pull request: update the changelog, bump all
  four workspace packages, build and test, then tag the merged release commit.
  Watch release.yml stage packages and create the GitHub Release.
  The user approves staged packages on npm. Use when the user asks to release,
  tag a version, push the release tag, or runs /migent-release.
metadata:
  short-description: "Release Migent on npm"
---

# Release Migent

Follow the release pull request flow and pitfalls in `CONTRIBUTING.md`.
Never commit or push directly to `main`, bypass branch protection, or tag an
unmerged release branch.

Work from the repository root. Reply in the user's language.

## Version and authorization

Use the version the user names. If they do not name one, propose the next
patch after the highest of `packages/*/package.json` and the `v*` tags and
confirm the version before publishing. An explicit request to release a named
version authorizes preparing and pushing a release PR and tagging the merged
release commit. Merge only when the user has explicitly authorized the merge.
Do not ask again for actions already authorized.

## Prepare the release branch

```bash
git fetch origin --tags
git status --short
```

Require a clean working tree. If unrelated changes are present, stop and
explain; do not stash, discard, or include them. Feature work must reach main
through its own PR before the release.

Run `pnpm setup:git`, then create `release/X.Y.Z` from current `origin/main`
using `git switch --no-track -c release/X.Y.Z origin/main`. For an existing
release branch/PR, inspect and resume it instead of creating a duplicate.
Its upstream must be absent or `origin/release/X.Y.Z`, never `origin/main`.

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

Build and tests must pass locally. Follow the provider isolation guidance in
`CONTRIBUTING.md`. Stop and report failures. Stage only the release files
named above, commit with `Release X.Y.Z`, then push the branch explicitly:

```bash
git push -u origin refs/heads/release/X.Y.Z:refs/heads/release/X.Y.Z
gh pr create --draft --base main --head release/X.Y.Z --title "Release X.Y.Z" --body-file <notes>
```

Wait for all three CI jobs to pass. Mark the PR ready when green. If merging
has not been authorized, report the PR URL and stop before merging or tagging.
After authorization, squash-merge the green PR; never bypass required checks.

## Tag the merged release

Fetch origin after merging. Find the merged release commit on `origin/main`
using the PR's merge commit, not a commit with a similar subject. Verify its
four package versions are `X.Y.Z` and its changelog contains that release.
Stop if the PR is unmerged or the tag already exists. Never force-push or move
a tag. Create a lightweight tag on that exact merged commit:

```bash
git tag vX.Y.Z <merged-release-sha>
git push origin refs/tags/vX.Y.Z:refs/tags/vX.Y.Z
```

Pushing the tag starts publishing.

## Watch release.yml

Watch `.github/workflows/release.yml` until that run finishes. The workflow
checks that the tag is on `origin/main` and that every package version matches
the tag. It takes the `## X.Y.Z` section of `CHANGELOG.md` as the notes, then
builds, tests, packs, and runs `npm stage publish` with GitHub OIDC. There is no
npm token in the repo. After staging it creates the GitHub Release with those
notes. Say the run succeeded only when its conclusion is success, and include
the run URL.

```bash
gh run list --workflow release.yml --branch vX.Y.Z \
  --json databaseId,status,conclusion,url
gh run watch <databaseId> --exit-status
gh release view vX.Y.Z
```

If the run list is empty, wait 30 seconds and list again, up to five times.

If `release.yml` fails, leave the tag where it is. Tell the user to reject
the staged versions and release the next patch, as `CONTRIBUTING.md` describes.

On success, report the GitHub Release URL and say the packages are staged. The
user approves them on npm. Do not approve or verify them.
