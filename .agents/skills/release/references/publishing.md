# Publishing and recovery

Read [repository policy](../../../../CONTRIBUTING.md) first.

## Prerequisites

- Verify required checks, merge permissions, tag ownership, and publisher settings
  against repository policy. Stop on missing prerequisites; changing protections or
  publisher settings requires explicit authorization.
- First publication must be manual; configure trusted publishing before subsequent runs.

## Merge and verify

- A named-version request authorizes preparation and pushing the PR; merging needs
  explicit authorization (reuse existing authorization). Confirm publishing
  prerequisites before merging.
- Squash-merge with the release subject from CONTRIBUTING.md to trigger publishing.
- Find the run with `gh run list --workflow release.yml --branch next --commit <sha>
  --json databaseId,status,conclusion,url`; watch with `gh run watch <id> --exit-status`.
  If absent, retry every 30 seconds, at most five times. On failure, report job/step and stop.
- After success, fetch; confirm `origin/main` equals the tag commit; install
  `npm i -g --prefer-online @nodeint/migent@X.Y.Z` and check `migent --version`.
  Report version, tag, run URL/result, GitHub Release URL, npm and `main` results.

## Recovery

Inspect the failed run and existing artifacts first. Retry only authorized steps;
ask before undocumented recovery or new external mutations.

- After fixing the cause, use `gh run rerun <id> --failed`; verify reused tags,
  releases, and packages. A tag alone does not prove npm or `main` succeeded.
- Existing tag without a retryable run: `gh workflow run release.yml --ref next -f version=X.Y.Z`
  (npm job only).
- Versions are single-use even after unpublishing. If completion is impossible,
  release the next patch. Deprecate bad releases rather than deleting:
  `npm deprecate "@nodeint/migent@X.Y.Z" "Upgrade to X.Y.W"`.
- For propagation/ETARGET, use `--prefer-online` and check
  `npm view "@nodeint/<package>@X.Y.Z" version`.
- Manual publishing: avoid `pnpm -r publish` (2FA hangs); use
  `pnpm -r pack --pack-destination <dir>`,
  then `npm publish <tarball> --access public`. Never publish package directories
  directly: workspace references remain unresolved.
- Dependency order: `@nodeint/migent-{contracts,workflow,prompts,kernel,session,engine,doctor,adapters,registry}`,
  then `@nodeint/migent`.
