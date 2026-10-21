---
name: migent-release
description: >
  Release Migent. Promote CHANGELOG.md, bump the four workspace packages to one
  version, commit "Release X.Y.Z", and create lightweight tag vX.Y.Z. Push only
  when the user asks, then attach that changelog to the GitHub Release for the
  tag. Use when the user says release, tag a version, push the release tag, or
  attach the changelog to the tag, including "release phiên bản", "tag", and
  "push tag". Use when the user runs /migent-release.
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

Stop when the working tree has changes that are not part of this release.
Stop when the latest CI run on `main` failed. `release.yml` runs the same
tests and stops on failure.

## Changelog

Move the body of `## Unreleased` in `CHANGELOG.md` under `## X.Y.Z`. Leave
`## Unreleased` empty above that heading. Keep `### Added`, `### Changed`, and
`### Removed`.

Compare `git log <previous-tag>..HEAD` with those notes. Add every user-facing
change the notes missed, in the same voice. Do not put the version in
`docs/backlogs.md`. That line records when the backlog was written.

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

Push only when the user asks to push. Push the branch and the tag together:

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
