---
name: release
description: Prepare release notes and PRs; merge and publish with authorization.
---

# Release

## Steps

1. Read [repository policy](../../../CONTRIBUTING.md) and
   [preparation](references/preparation.md). Ask about missing required inputs.
2. Prepare the branch, version, and notes; obtain notes approval before version edits,
   commits, pushes, or PR creation. Preserve unrelated work.
3. Follow [PR preparation](references/preparation.md#open-pr-and-pass-ci) and
   [create-pr](../create-pr/SKILL.md) for commit/push/PR mechanics.
   Stop on failed checks; obtain approval again for changed notes or version.
4. Check [publishing prerequisites](references/publishing.md#prerequisites), then
   [merge and verify](references/publishing.md#merge-and-verify) with explicit merge
   authorization. Reuse existing authorization within scope.
5. On publishing failure, report job/step and stop. For authorized retries, follow
   [recovery](references/publishing.md#recovery).
6. Report version, commit, tag, run/release URLs, CI, npm installation, `main`
   synchronization, and anything unverified. A tag alone does not prove completion.
