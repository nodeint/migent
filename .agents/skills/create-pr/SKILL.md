---
name: create-pr
description: >
  Commit the work on the current branch, push it, and open a pull request
  against main, then report the CI result. Stops before merging. Use when the
  user says create PR, tạo PR, open a pull request, or push and open a PR. For
  a release, use migent-release instead.
argument-hint: "[issue number]"
metadata:
  short-description: "Open a pull request for the current branch"
---

# Create a pull request

Read `CONTRIBUTING.md` from `## Pull requests` to `## Releasing`. Work from the
repository root. Reply in the user's language.

## Check

```bash
git fetch origin
git branch --show-current
git status --short
git rev-list --count origin/main..HEAD
```

- On `main`, create a branch first, named as `CONTRIBUTING.md` says. Never
  commit on `main`.
- Stop and ask when the changes look unrelated to each other, or when nothing
  differs from `origin/main`.

## Verify

Run the tests for the packages you changed, and `pnpm gate` when it exists.
If you changed `skills/migent/`, apply the same change to `.agents/skills/migent/`;
`packages/cli/test/skill-sync.test.ts` compares the two. Do not edit `dist/`.
A user-visible change adds a line under `## Unreleased` in `CHANGELOG.md`.
Report any test that fails and stop.

## Commit

Stage files by name. Do not use `git add -A` or `git commit -am`. Skip secrets
and build output. Write the message in the style of `git log`, one short
imperative subject. End it with the attribution line the session gives.

## Confirm, then push

Pushing and opening a pull request are visible to others. Ask once, unless the
user already asked for the pull request: push `<branch>` and open a pull request
against `main`.

```bash
git push -u origin <branch>
gh pr create --base main --title "<subject>" --body-file <notes>
```

The title is the squash commit subject. The body says what changed and why, and
what was not done. Add `Fixes #<n>` when the work closes an issue. End it with
the attribution line the session gives. Never force-push.

## Report

Show the pull request URL. Check the result once with `gh pr checks <number>`
and say which checks pass, fail, or are pending. Do not merge. Merging is the
user's call, or `migent-release` Stage 0 for a release.
