---
name: migent-release
description: >
  Release Migent directly from main: update the changelog, bump all four
  workspace packages, build and test, commit, push main, and push the release
  tag. Watch release.yml stage packages and create the GitHub Release.
  The user approves staged packages on npm. Use when the user asks to release,
  tag a version, push the release tag, or runs /migent-release.
argument-hint: "0.1.6"
metadata:
  short-description: "Release Migent on npm"
---

# Release Migent

Release directly on `main`, without creating branches or pull requests.
Read the release guidance and pitfalls in `CONTRIBUTING.md`; this skill
overrides its branch, pull request, and merge requirements.

Work from the repository root. Reply in the user's language.

## Version and authorization

Use the version the user names. If they do not name one, propose the next
patch after the highest of `packages/*/package.json` and the `v*` tags and
confirm the version before publishing. An explicit request to release a named
version authorizes committing the release, pushing `main`, and pushing its tag.
Do not ask again for actions already authorized.

## Prepare main

```bash
git fetch origin --tags
git status --short
```

Work on `main`. If currently on another branch, switch only when it preserves
the working tree and all intended release changes are available on `main`;
otherwise stop and explain what must be brought onto `main`. Do not discard
changes or create a release branch.

Fast-forward `main` from `origin/main` when possible. Preserve local commits
already ahead of `origin/main`; stop if the histories diverge. If uncommitted
work belongs in this release, review and commit it separately before the
release commit. Stage files by name, excluding secrets and build outputs;
ask before including unrelated work.

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

### Validate, commit, and push main

```bash
pnpm -r exec npm pkg set version=X.Y.Z
pnpm install
pnpm build
pnpm test
```

`pnpm -r` sets the same version on every package under `packages/`. The CLI
reads its version from `packages/cli/package.json`. Do not edit
`packages/cli/src/version.ts`.

CI does not run on pushes to `main`, so build and tests must pass locally
before pushing. Follow the provider isolation guidance in `CONTRIBUTING.md`
when running tests. Stop and report failures.

Stage only the release files named above and commit with `Release X.Y.Z`.
Do not use `git commit -am`. Require a clean working tree afterward.

Fetch `origin` again before pushing. If `origin/main` has advanced beyond the
local history, stop and reconcile it before revalidating the release notes,
build, and tests. Never force-push.

```bash
git push origin main
```

If repository protection rejects the push, report the error and stop; do not
bypass protection or silently fall back to a pull request.

## Tag and push

After the push succeeds, fetch and verify the release commit is on
`origin/main`, its subject is `Release X.Y.Z`, and every package manifest at
that commit says `X.Y.Z`. Tag that exact commit, even if `main` later advances.

Create a lightweight tag, as with existing releases. Pushing the tag starts
publishing. Do not annotate or move the tag.

```bash
git tag vX.Y.Z <release-sha>
git push origin vX.Y.Z
```

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
