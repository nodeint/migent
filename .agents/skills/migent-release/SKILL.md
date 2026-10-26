---
name: migent-release
description: >
  Release Migent through a pull request, end to end. First land any pending
  work on main through its own pull request (branch, PR, wait for CI,
  squash-merge). Then, from main, branch release/X.Y.Z, update CHANGELOG.md and keep five versions there, bump the
  four workspace packages to one version, commit "Release X.Y.Z", open a pull
  request, squash-merge it once its checks pass, tag the merge commit vX.Y.Z,
  and push the tag. release.yml then stages the packages and creates the
  GitHub Release from the changelog. Approving the staged packages on npm is
  the user's job. Use when the user says release, tag a version, push the
  release tag, or open the release PR, including "release phiên bản", "tag",
  and "push tag". Use when the user runs /migent-release.
argument-hint: "0.1.6"
metadata:
  short-description: "Release Migent on npm"
---

# Release Migent

Release this repository. Read `CONTRIBUTING.md` from `## Pull requests` through
`## Release pitfalls` and follow it. The rules below override that file where
they differ.

Work from the repository root. Reply in the user's language.

## Confirm once

Use the version the user names. If they do not name one, propose the next
patch after the highest of `packages/*/package.json` and the `v*` tags.

Then ask once, in one message: open a pull request for the pending work (if
Stage 0 applies), release `X.Y.Z`, squash-merge both pull requests when their
checks pass, and push the tag `vX.Y.Z` (which starts publishing). A yes covers
all of it. Do not ask again between the stages below; GitHub's results decide
whether each stage starts. Without a yes, stop before the first pull request.

## Stage 0: the pull request for pending work

`main` takes changes only through pull requests, so work that is not on
`origin/main` needs a branch first. Skip this stage when the working tree is
clean, the current branch is `main`, and `git rev-list origin/main..HEAD` is
empty. Go to Stage 1.

```bash
git fetch origin
git status --short
git rev-list --count origin/main..HEAD
```

1. Pick the branch. If the current branch is not `main`, use it. On `main`,
   create one from the work, such as `feat/<slug>` or `fix/<slug>`, with
   `git switch -c <branch>`. Never commit on `main`. If `main` has local commits
   ahead of `origin/main`, move them to the new branch and leave `main` equal to
   `origin/main`.
2. Commit uncommitted changes. Stage the files by name, not with `git add -A`
   or `git commit -am`, and skip anything that looks like a secret or a build
   output. Write a message in the style of `git log`. Stop and ask when the
   changes look unrelated to each other.
3. Push the branch and open the pull request against `main`. The title is the
   commit subject, or a short summary when there are several commits. The body
   says what changed and why.
   ```bash
   git push -u origin <branch>
   gh pr create --base main --title "<title>" --body-file <notes>
   ```
4. Wait for the checks with `gh pr checks --watch`. Stop and report the failing
   check when one fails. Never force-push and never push `main`.
5. When every check has passed on the latest commit, merge it as in Stage 2:
   `gh pr merge <number> --squash --delete-branch`. If a ruleset refuses the
   merge, report the message and stop.
6. Return to `main` and take the merge:
   ```bash
   git switch main
   git pull --ff-only origin main
   ```

Then continue with Stage 1.

Stop when the working tree is dirty after this stage.

## Stage 1: the release pull request

Release from `origin/main`. `ci.yml` does not run on pushes to `main`; every
commit there came through a pull request whose checks passed, and the release
pull request runs them again. Fetch first.

```bash
git fetch origin
```

Stop when `release/X.Y.Z` already exists locally or
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

Never force-push and never push `main`. Wait for the checks with
`gh pr checks --watch`. Stop and report the failing check when one fails. If
`origin/main` moves before the merge, rebase the branch, redo the changelog,
push again, and wait for the checks again.

## Stage 2: merge

Start when every check has passed on the latest commit of the pull request.
Confirm that the pull request is open and that `origin/main` is still the base
commit it was opened from. Stop when either is false.

```bash
gh pr merge <number> --squash --delete-branch
```

Use the default squash subject, `Release X.Y.Z (#N)`. If a ruleset refuses the
merge (for example a required review), report the message and stop. Do not
bypass it or merge by another route.

If the user merged the pull request first, skip the command and wait for the
merge instead:

```bash
gh pr view <number> --json state,mergeCommit
```

Poll it every 30 seconds for up to 30 minutes until `state` is `MERGED`. Stop
and report if the pull request is closed without a merge or the wait runs out.

## Stage 3: tag and push

Fetch, then find the merge commit on `origin/main`:

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
tags, then push it. Do not annotate the tag. Do not move a tag that already
exists. A bad version gets the next patch. Versions already sent to npm are
single-use, including versions that were unpublished. Pushing publishes.

```bash
git tag vX.Y.Z <sha>
git push origin vX.Y.Z
```

## Stage 4: watch release.yml

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
