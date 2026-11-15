# Release preparation

Read [repository policy](../../../../CONTRIBUTING.md) first.

## Prepare and review

- Fetch `origin` and tags; require a clean entry tree, preserve unrelated work,
  and resume existing release branches/PRs. Revisions retain only expected release edits.
- Compare `git log <previous-tag>..HEAD` with Unreleased for missing changes;
  stop if there is no user-facing change.
- Use the requested version; otherwise confirm one before editing, based on the
  highest workspace version or release tag:

| Categories | Before 1.0 | From 1.0 |
| --- | --- | --- |
| Breaking, Removed | minor | major |
| Added, Deprecated | minor | minor |
| Changed, Fixed, Security only | patch | patch |

- CLI/public wire incompatibilities are Breaking; internal-only changes are not.
  Stop if the tag exists locally/remotely or the version was ever published to npm.
- Create `release/X.Y.Z` under CONTRIBUTING.md branch rules.
- Draft `CHANGELOG.md` only: no version bumps, commits, pushes, or PR until notes approval.
  Review version/notes/diff locally; approval needs neither CI nor an existing release commit.
- Move Unreleased into `## X.Y.Z` (no date), leaving Unreleased empty. An unchanged
  changelog blocks release; never rewrite released notes.
- Categories: Breaking, Added, Changed, Deprecated, Removed, Fixed, Security; omit empty ones.
  Use 1–2 sentences per bullet ending with its PR link; Breaking includes
  migration steps. Exclude internal refactors, CI, tests, and internal docs.
- Keep five versions in full; move older versions to GitHub Release links under
  `## Older versions`, newest first, preserving existing links.

## Open PR and pass CI

After notes approval, synchronize all workspace versions:

```bash
pnpm -r exec npm pkg set version=X.Y.Z
pnpm install
pnpm build
# Run the full suite with client CLIs off PATH, per CONTRIBUTING.md.
```

- Confirm the diff matches approved notes/version and CONTRIBUTING.md release scope.
  Follow its naming/PR rules and the create-pr skill for commit, push, and draft PR creation.
- Wait for required CI; mark ready only when green.
  If `next` advances, update and repeat review/checks. Changed notes/version
  need approval again.
