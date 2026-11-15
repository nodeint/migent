---
name: create-pr
description: Commit, push, open a non-release PR, and report CI; stop before merging.
---

# Create a pull request

## Steps

1. Read contribution rules for repository, remote, base, branches, setup, checks,
   changelog, PR template, and attribution. Ask about missing required settings.
2. Fetch the configured remote. Check branch, status, upstream, and diff against
   the required base; require that ref to exist. Follow setup and branch rules.
   If on a protected branch, preserve changes and create an allowed branch when
   permitted. Stop and ask about unrelated changes or an empty diff.
3. Resolve incorrect tracking under repository rules. Confirm the push destination
   uses the current branch name; never rewrite published history or force-push.
4. Complete required changelog updates. Run checks and gates for the changed scope.
   Report failures and stop. Inspect the diff for unrelated or sensitive files;
   do not edit generated output or bypass verification.
5. Stage outstanding files by name, inspect the staged diff, and commit using
   repository subject and attribution rules. Preserve existing commits.
   Do not use `git add -A` or `git commit -am`; exclude secrets and build output.
6. Draft the PR body using the repository template, closing references, and required
   attribution. Include changes, purpose, checks, and anything unverified.
   Name the PR and squash subject per CONTRIBUTING.md.
   Write the body to a temporary file.
7. When authorized, push with
   `git push -u <remote> refs/heads/<branch>:refs/heads/<branch>`.
   Verify upstream, then open the PR with the required draft status:
   `gh pr create --draft --repo <owner>/<repo> --base <base> --head <branch> --title "<subject>" --body-file <notes>`.
8. Inspect CI for the current PR head and base. Wait when repository rules require it;
   report failures and stop. Report branch, commit, PR URL, and check results in the
   user's language. Do not merge without the user's instruction.
