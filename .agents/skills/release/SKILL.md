---
name: release
description: Prepare release notes and PRs; merge and publish with authorization.
---

# Release

## Steps

1. Read [repository policy](../../../CONTRIBUTING.md) and
   [Prepare and review](#prepare-and-review); ask about missing required inputs.
2. Prepare the branch, version, and notes. Get notes approval before version
   edits, commits, pushes, or PR creation; preserve unrelated work.
3. Follow [Open PR and pass CI](#open-pr-and-pass-ci) and
   [create-pr](../create-pr/SKILL.md) for commit, push, and PR mechanics.
   Stop on failed checks; changed notes or version need approval again.
4. Check [Prerequisites](#prerequisites), then [merge and verify](#merge-and-verify)
   with explicit merge authorization; reuse existing authorization within scope.
5. On publishing failure, report the job and step, then stop. For authorized
   retries, follow [Recovery](#recovery).
6. Report version, commit, tag, run and release URLs, CI, npm installation,
   `main` synchronization, and anything unverified. A tag alone does not
   prove completion.

## Preparation

### Prepare and review

- Fetch `origin` and tags. Require a clean entry tree, preserve unrelated work,
  and resume existing release branches or PRs. Revisions keep only expected
  release edits.
- Compare `git log <previous-tag>..HEAD` with Unreleased for missing changes;
  stop if no change is user-facing.
- Use the requested version; otherwise confirm one before editing, based on
  the highest workspace version or release tag:

| Categories | Before 1.0 | From 1.0 |
| --- | --- | --- |
| Breaking, Removed | minor | major |
| Added, Deprecated | minor | minor |
| Changed, Fixed, Security only | patch | patch |

- CLI or public wire incompatibilities are Breaking; internal-only changes are
  not. Stop if the tag exists locally or remotely, or the version was ever
  published to npm.
- Create `release/X.Y.Z` under the CONTRIBUTING.md branch rules.
- Draft only `CHANGELOG.md`: no version bumps, commits, pushes, or PR before
  notes approval. Review version, notes, and diff locally; approval needs
  neither CI nor an existing release commit.
- Move Unreleased into `## X.Y.Z` (no date), leaving Unreleased empty.
  An unchanged changelog blocks release; never rewrite released notes.
- Categories: Breaking, Added, Changed, Deprecated, Removed, Fixed, Security;
  omit empty ones. Write 1–2 sentences per bullet, ending with its PR link;
  Breaking includes migration steps. Exclude internal refactors, CI, tests,
  and internal docs.
- Keep five versions in full. Move older ones to GitHub Release links under
  `## Older versions`, newest first, preserving existing links.

### Open PR and pass CI

After notes approval, synchronize all workspace versions:

```bash
pnpm -r exec npm pkg set version=X.Y.Z
pnpm install
pnpm build
# Run the full suite with client CLIs off PATH, per CONTRIBUTING.md.
```

- Confirm the diff matches the approved notes and version and the
  CONTRIBUTING.md release scope. Follow its naming and PR rules and the
  create-pr skill to commit, push, and open a draft PR.
- Wait for required CI; mark ready only when green. If `next` advances,
  update and repeat review and checks. Changed notes or version need
  approval again.

## Publishing

### Prerequisites

- Verify required checks, merge permissions, tag ownership, and publisher
  settings against repository policy. Stop on missing prerequisites; changing
  protections or publisher settings needs explicit authorization.
- The first publication must be manual; configure trusted publishing before
  later runs.

### Merge and verify

- A named-version request authorizes preparing and pushing the PR; merging
  needs explicit authorization (reuse existing authorization). Confirm
  publishing prerequisites before merging.
- Squash-merge with the CONTRIBUTING.md release subject to trigger publishing.
- Find and watch the run:

  ```bash
  gh run list --workflow release.yml --branch next --commit <sha> \
    --json databaseId,status,conclusion,url
  gh run watch <id> --exit-status
  ```

  If no run appears, retry every 30 seconds, at most five times. On failure,
  report the job and step, then stop.
- After success, fetch and confirm `origin/main` equals the tag commit.
  Install with `npm i -g --prefer-online @nodeint/migent@X.Y.Z` and check
  `migent --version`. Report version, tag, run URL and result, GitHub Release
  URL, and npm and `main` results.

### Recovery

Inspect the failed run and existing artifacts first. Retry only authorized
steps; ask before undocumented recovery or new external mutations.

- After fixing the cause, run `gh run rerun <id> --failed`; verify reused
  tags, releases, and packages. A tag alone does not prove npm or `main`
  succeeded.
- Existing tag without a retryable run (npm job only):
  `gh workflow run release.yml --ref next -f version=X.Y.Z`.
- Versions are single-use, even after unpublishing. If completion is
  impossible, release the next patch. Deprecate bad releases instead of
  deleting them:
  `npm deprecate "@nodeint/migent@X.Y.Z" "Upgrade to X.Y.W"`.
- For propagation or ETARGET errors, use `--prefer-online` and check
  `npm view "@nodeint/<package>@X.Y.Z" version`.
- Manual publishing: avoid `pnpm -r publish` (2FA hangs). Use
  `pnpm -r pack --pack-destination <dir>`, then
  `npm publish <tarball> --access public`. Never publish package directories
  directly: workspace references stay unresolved.
- Publish in dependency order, then `@nodeint/migent`:
  `@nodeint/migent-{contracts,workflow,prompts,kernel,session,engine,doctor,adapters,registry}`.
