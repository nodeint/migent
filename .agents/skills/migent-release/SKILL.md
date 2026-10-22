---
name: migent-release
description: >
  Release Migent. Fast-forward production to main, wait for CI on that branch,
  then update CHANGELOG.md and keep five versions there, bump the four
  workspace packages to one version, commit "Release X.Y.Z", and create
  lightweight tag vX.Y.Z. Push the tag only when the user asks, then attach
  that changelog to the GitHub Release for the tag. Use when the user says
  release, tag a version, push the release tag, or attach the changelog to the
  tag, including "release phiên bản", "tag", and "push tag". Use when the user
  runs /migent-release.
argument-hint: "0.1.6"
metadata:
  short-description: "Release Migent on npm"
---

# Release Migent

Release this repository. Read `CONTRIBUTING.md` from `## Releasing` through
`## Release pitfalls` and follow it. The rules below override that file where
they differ.

Work from the repository root. Reply in the user's language.

## Version

Use the version the user names. If they do not name one, propose the next
patch after the highest of `packages/*/package.json` and the `v*` tags, and
wait for a yes.

Stop when the working tree is dirty. The release commit does not exist yet.

## Production CI

`.github/workflows/ci.yml` runs only on a push to `production`. Do this before
the changelog, the version bump, and the tag.

The release candidate is `origin/main`. Fetch, then stop unless `HEAD` is that
commit. Stop unless that commit's `.github/workflows/ci.yml` triggers on a
push to `production`.

`production` is the CI branch. Update it from `origin/main` only as a
fast-forward. Create it with the same push when it is absent.

```bash
git fetch origin
git push origin origin/main:production
```

Stop when `origin/production` exists and is not an ancestor of `origin/main`.
When `origin/production` already points at `origin/main`, skip the push.

Wait until the `ci.yml` run for that commit exists, then watch it. A run can
take a moment to appear. Continue only when its conclusion is success, and
include the run URL. Stop when it fails, is cancelled, or never appears.
Leave `main` untagged.

```bash
gh run list --branch production --workflow ci.yml --commit <sha> \
  --json databaseId,status,conclusion,url,headSha
gh run watch <databaseId> --exit-status
```

`<sha>` is `origin/main`. After the run succeeds, stop if `HEAD` is no longer
that commit. The release commit's parent is that commit.

`release.yml` runs the same tests on the tag and stops on failure. It does
not replace this wait.

## Changelog

Every release updates `CHANGELOG.md`. The release commit includes that file.
Do not tag when it is unchanged.

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

Put the `## X.Y.Z` section in the reply that reports the commit and the tag.

## Commit and tag

```bash
pnpm -r exec npm pkg set version=X.Y.Z
pnpm install
```

`pnpm -r` sets the same version on every package under `packages/`. The CLI
reads its version from `packages/cli/package.json`. Do not edit
`packages/cli/src/version.ts`.

Stage only `CHANGELOG.md`, `packages/*/package.json`, and `pnpm-lock.yaml`
when that file changed. Commit with the message `Release X.Y.Z`. Do not use
`git commit -am`.

Create a lightweight tag, the same kind as the existing release tags:

```bash
git tag vX.Y.Z
```

Do not annotate the tag. Do not move a tag that already exists. A bad version
gets the next patch. Versions already sent to npm are single-use, including
versions that were unpublished.

Stop after the commit and the tag. Pushing publishes.

## Push

Pushing the tag publishes. Push it only when the user asks. Push `main` and
the tag together. Leave `production` at the commit CI already passed. The
next release fast-forwards it.

```bash
git push origin main vX.Y.Z
```

Watch `.github/workflows/release.yml` until that run finishes. The workflow
checks that every package version matches the tag, then builds, tests, packs,
and runs `npm stage publish`. It authenticates with GitHub OIDC. There is no
npm token in the repo. Say the run succeeded only when its conclusion is
success, and include the run URL.

Then attach the changelog to that tag as a GitHub Release. The tag is
lightweight, so it cannot hold the notes. Do not delete or recreate the tag
to add an annotation. A new push of `v*` runs `release.yml` again.

```bash
gh release view vX.Y.Z
gh release create vX.Y.Z --verify-tag --title "X.Y.Z" --notes-file <notes>
```

`<notes>` is the `## X.Y.Z` section and nothing above it. `--verify-tag`
refuses to create a tag. Skip `gh release create` when the release already
exists. If the user asks to attach the changelog after the tag is already on
the remote, do only this step.

If `release.yml` fails, leave the tag where it is. Tell the user to reject
the staged versions and release the next patch, as `CONTRIBUTING.md` describes.

## After a successful stage

Tell the user to approve the staged packages on npm with 2FA, in the
dependency order in `CONTRIBUTING.md`. Do not approve them yourself. Approving
the CLI before its dependencies makes `npm i -g @nodeint/migent` fail until
the others are approved.

After they say the packages are approved, verify:

```bash
npm view @nodeint/migent version
npm i -g --prefer-online @nodeint/migent
migent --version
```
