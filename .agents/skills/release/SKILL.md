---
name: release
description: Prepare release notes and PRs; merge and publish with authorization.
---

# Release

## Steps

1. Read repository contribution and release docs. Identify base, branch and tag
   rules, versioning, notes format, packages, checks, and publishing mechanism.
   Ask about missing required information.
2. Fetch the remote and tags. Check branch, status, and existing release branches
   or PRs. Require a clean entry tree and resume existing release work when present.
   Preserve unrelated work.
3. Compare changes since the previous release with the notes. Use the requested
   version or propose and confirm one under repository policy. Check tag and
   registry availability before editing.
4. Create the release branch and draft notes. Describe user-visible changes and
   breaking-change migration steps. Preserve released notes and follow categorization
   and retention rules. Keep version changes and commits pending notes approval.
5. Review version, notes, and diff locally. Resolve findings and obtain required notes
   approval; this review does not require a release commit or CI run.
6. Update version sources and lockfiles with documented commands. Run required
   checks and inspect the diff against approved release scope. Report failures and
   stop; do not bypass checks or hooks.
7. When authorized, commit, push, and open the PR with the documented base, title,
   template, and draft status. Wait for required CI on the current head and base.
   Repeat affected review and checks after changes; obtain review again for changed
   version or notes.
8. Read [publishing prerequisites](references/publishing.md#prerequisites).
   Confirm required authorization before merging or publishing; reuse existing
   authorization within scope. Use the documented mechanism and preserve protections
   and automation-owned tags.
9. Find the publishing run for the release commit. On failure, report job and step
   and stop before retrying. For authorized recovery, follow
   [recovery steps](references/publishing.md#recovery).
10. Verify tag, release record, registry artifacts, installable version, and required
    branch synchronization. Report version, commit, output URLs, checks, publishing
    results, and anything unverified. A tag alone does not prove completion.
