# Publishing prerequisites and recovery

Read before merging or recovering a failed release.

## Prerequisites

- Default branch is `next`. Its ruleset requires current-base Ubuntu, macOS, and
  Windows tests, resolved conversations, linear history, and no bypass actors.
  Use squash merges; working branches are deleted after merge.
- `main: immutable release history` blocks deletion and force-push, but permits the
  workflow token to fast-forward main. An older `main: release maintainers only`
  update restriction blocks releases: stop and obtain approval for ruleset changes.
- Tags `v*` are immutable and created only by `.github/workflows/release.yml`.
- Every npm package needs a trusted publisher: organization `nodeint`, repository
  `migent`, workflow `release.yml`, empty environment, allowed action `npm publish`.
  Renaming that workflow, moving the repository, or changing `repository.url`
  requires updating trusted publishers.
- Trusted publishing cannot create a package. Its first publish must be manual,
  then configure its trusted publisher before dispatching npm publishing.

## Recovery

- After fixing the cause, rerun failed jobs with `gh run rerun <id> --failed`.
  Existing tags/releases and published packages are reused; verify actual state.
- With an existing tag but no run to retry, publish through
  `gh workflow run release.yml --ref next -f version=X.Y.Z` (npm job only).
- Versions are single-use even after unpublishing. Never move a tag; if the version
  cannot be completed, release the next patch.
- Deprecate a bad release instead of deleting it:
  `npm deprecate "@nodeint/migent@X.Y.Z" "Upgrade to X.Y.W"`.
- Registry propagation may briefly cause ETARGET; use `--prefer-online` and check
  `npm view "@nodeint/<package>@X.Y.Z" version`.
- Manual publishing: `pnpm -r publish` can hang on 2FA; use
  `pnpm -r pack --pack-destination <dir>` then `npm publish <tarball> --access public`.
  Never publish directly from package directories: workspace references remain unresolved.
- Publish dependency order: `@nodeint/migent-contracts`, `-workflow`, `-prompts`,
  `-kernel`, `-session`, `-engine`, `-doctor`, `-adapters`, `-registry`, then
  `@nodeint/migent`. All packages belong to `@nodeint`; unscoped `migent` was rejected
  and `@migent` is held only against squatting.
