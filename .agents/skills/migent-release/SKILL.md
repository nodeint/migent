---
name: migent-release
description: >
  Release Migent through a pull request. From a green main, branch
  release/X.Y.Z, update CHANGELOG.md and keep five versions there, bump the
  four workspace packages to one version, commit "Release X.Y.Z", and open a
  pull request. After it is merged, tag that commit vX.Y.Z. Push the tag only
  when the user asks; release.yml then stages the packages and creates the
  GitHub Release from the changelog. Use when the user says release, tag a
  version, push the release tag, or open the release PR, including "release
  phiên bản", "tag", and "push tag". Use when the user runs /migent-release.
argument-hint: "0.1.6"
metadata:
  short-description: "Release Migent on npm"
---

# Release Migent

Release this repository. Read `CONTRIBUTING.md` from `## Pull requests` through
`## Release pitfalls` and follow it. The rules below override that file where
they differ.

Work from the repository root. Reply in the user's language.

A release has two stops. Do the first (the release pull request), then stop
until the user says it is merged. Do the second (the tag) from there. Do not
merge the pull request yourself.

## Version

Use the version the user names. If they do not name one, propose the next
patch after the highest of `packages/*/package.json` and the `v*` tags, and
wait for a yes.

Stop when the working tree is dirty.

## Stop 1: the release pull request

Release from `origin/main`. Fetch, then stop unless the latest `ci.yml` run on
`main` for `origin/main` succeeded. Use that run's URL in the reply. Stop when
it is missing, failed, cancelled, or still running.

```bash
git fetch origin
gh run list --branch main --workflow ci.yml --commit <sha> \
  --json databaseId,status,conclusion,url,headSha
```

`<sha>` is `origin/main`. Stop when `release/X.Y.Z` already exists locally or
on `origin`, or when `vX.Y.Z` exists. A bad version gets the next patch.

```bash
git switch -c release/X.Y.Z origin/main
```

The release branch changes only `CHANGELOG.md`, `packages/*/package.json`, and
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

### Commit and pull request

```bash
pnpm -r exec npm pkg set version=X.Y.Z
pnpm install
```

`pnpm -r` sets the same version on every package under `packages/`. The CLI
reads its version from `packages/cli/package.json`. Do not edit
`packages/cli/src/version.ts`.

Stage only the files named above. Commit with the message `Release X.Y.Z`. Do
not use `git commit -am`. Then push the branch and open the pull request. The
title is `Release X.Y.Z`. The body is the `## X.Y.Z` section and nothing above it.

```bash
git push -u origin release/X.Y.Z
gh pr create --base main --title "Release X.Y.Z" --body-file <notes>
```

Never force-push and never push `main`. Watch the pull request checks with
`gh pr checks --watch`. Report the pull request URL and the check result, then
stop. Tell the user to squash-merge it and to land no other pull request first.
If `main` moves before the merge, rebase the branch, redo the changelog, and
push again.

## Stop 2: the tag

Continue when the user says the pull request is merged. Fetch, then find the
merge commit on `origin/main`:

```bash
git fetch origin --tags
git log origin/main --grep='^Release X.Y.Z' --format='%H %s'
```

Stop unless exactly one commit matches and every `packages/*/package.json` at
that commit says `X.Y.Z`:

```bash
git show <sha>:packages/cli/package.json
```

Create a lightweight tag on that commit, the same kind as the existing release
tags:

```bash
git tag vX.Y.Z <sha>
```

Do not annotate the tag. Do not move a tag that already exists. A bad version
gets the next patch. Versions already sent to npm are single-use, including
versions that were unpublished. Stop after the tag. Pushing publishes.

## Push the tag

Push the tag only when the user asks.

```bash
git push origin vX.Y.Z
```

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
