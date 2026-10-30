---
name: create-pr
description: >
  Commit the work on the current branch, push it, and open a pull request
  against next, then report the CI result. Stops before merging. Use when the
  user says create PR, tạo PR, open a pull request, or push and open a PR. For
  a release, use release instead.
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
git branch -vv
git rev-list --count origin/next..HEAD
```

- On `main` or `next`, create a branch with `git switch --no-track -c <branch> origin/next`.
  Never commit on `main` or `next`. Run `pnpm setup:git` once to install local safeguards.
- A working branch must have no upstream or track `origin/<same-branch-name>`.
  Remove a wrong upstream with `git branch --unset-upstream <branch>`.
- Stop and ask when the changes look unrelated to each other, or when nothing
  differs from `origin/next`.

Require `origin/next` to exist; do not fall back to `main`. All required CI
checks must pass against the current `next` base before merging.

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
against `next`.

```bash
git push -u origin refs/heads/<branch>:refs/heads/<branch>
gh pr create --draft --base next --head <branch> --title "<subject>" --body-file <notes>
```

The title is the squash commit subject. The body says what changed and why, and
relevant validation. Add `Fixes #<n>` when the work closes an issue. End it with
the attribution line the session gives, when provided. Never force-push or
push to `main` or `next`; use the explicit same-name refspec above, never a bare push or
push based on the upstream. Verify the upstream is `origin/<branch>` afterward.
If work is already on `main` or `next`, report it; do not rewrite published
history to manufacture a PR.

## Report

Show the pull request URL. Check the result once with `gh pr checks <number>`
and say which checks pass, fail, or are pending. Do not merge. Merging requires the user's instruction.
