---
name: release
description: >
  Release Migent: prepare and review notes before opening a release PR,
  wait for CI, then merge with authorization and verify GitHub and npm publishing.
  Use for release requests, a named version, or /release.
metadata:
  short-description: "Release Migent on npm"
---

# Release Migent

Follow `CONTRIBUTING.md`. Work from the repository root and reply in the user's language.
Sequence: prepare -> review notes -> open PR and pass CI -> authorized merge -> verify.
The release workflow owns stage routing; this skill defines each step's requirements.

## Prepare

- Fetch `origin` and tags. Require a clean tree on entry; preserve unrelated changes.
  On revisions, retain only this release's expected edits. Resume an existing release
  branch/PR instead of duplicating it.
- Check changes since the previous release tag, including changes missing from Unreleased.
  Stop if there is no user-facing change to release.
- Use the named version; otherwise propose and confirm one before editing, relative to
  the highest workspace package version or release tag:

| Categories | Before 1.0 | From 1.0 |
| --- | --- | --- |
| Breaking, Removed | minor | major |
| Added, Deprecated | minor | minor |
| Changed, Fixed, Security only | patch | patch |

- CLI or public wire incompatibilities are Breaking; internal-only changes are not.
  Stop if the target tag exists locally/remotely or the version was ever published to npm.
- Run `pnpm setup:git`; create `release/X.Y.Z` from current `origin/next` with
  `git switch --no-track -c release/X.Y.Z origin/next`.
  Its upstream must be absent or `origin/release/X.Y.Z`.
- Draft `CHANGELOG.md` locally. Do not bump versions, commit, push, or open a PR yet.

## Notes and review

- Compare notes with `git log <previous-tag>..HEAD` for completeness and categorization.
- Move Unreleased under exact heading `## X.Y.Z`, without a date; leave Unreleased empty.
  Never rewrite released notes. An unchanged changelog blocks the release.
- Category order: Breaking, Added, Changed, Deprecated, Removed, Fixed, Security;
  omit empty categories. Each bullet explains the user-visible change in one or two
  sentences and ends with its PR link. Breaking entries include migration steps.
  Exclude internal refactors, CI, tests, and internal docs.
- Keep full notes for the five newest versions; replace older notes with GitHub Release
  links under `## Older versions`, newest first, preserving existing links.
- Review the version, notes, and local diff before opening a PR. Resolve findings locally;
  do not require CI or an existing release commit for notes approval.

## Open PR and pass CI

Only after notes approval:

```bash
pnpm -r exec npm pkg set version=X.Y.Z
pnpm install
pnpm build
pnpm test
```

- All workspace packages use the same version. Run tests with client CLIs off PATH
  as required by `CONTRIBUTING.md`; stop and report failures.
- Verify the final diff matches the reviewed notes and version. Only `CHANGELOG.md`,
  `packages/*/package.json`, and a changed `pnpm-lock.yaml` belong in the release commit.
  Do not edit `packages/cli/src/version.ts` or the version recorded in `docs/backlogs.md`.
- Commit as `Release X.Y.Z`, then push and open a draft PR:

```bash
git push -u origin refs/heads/release/X.Y.Z:refs/heads/release/X.Y.Z
gh pr create --draft --base next --head release/X.Y.Z --title "Release X.Y.Z" --body-file <notes>
```

Wait for Ubuntu, macOS, and Windows CI on the current head; mark ready only when green.
If new commits land on next, update the branch and repeat notes review and checks before
merging. Any change to reviewed notes or version requires another notes review.

## Merge and verify

- A named-version release request authorizes preparation and pushing the PR.
  Merge requires explicit authorization; reuse authorization already given.
- Before merging, check [publishing prerequisites](references/publishing.md).
  Never bypass branch protection, push releases directly to main/next, force main,
  or create/move release tags manually.
- Squash-merge the green PR with subject `Release X.Y.Z (#N)`; this starts
  `.github/workflows/release.yml`. It validates versions, tags, advances main,
  creates the GitHub Release, and publishes to npm using OIDC.
- Find the run by merge SHA with `gh run list --workflow release.yml --branch next
  --commit <sha> --json databaseId,status,conclusion,url`, then watch with
  `gh run watch <id> --exit-status`. If absent, retry every 30 seconds up to five times.
- On failure, report the job and step and stop. See [recovery](references/publishing.md)
  before retrying; a tag alone does not prove main or npm succeeded.
- After success, fetch and confirm `origin/main` equals the tag commit; install
  `npm i -g --prefer-online @nodeint/migent@X.Y.Z` and confirm `migent --version`.
  Report version, tag, run URL/conclusion, GitHub Release URL, npm and main results.
