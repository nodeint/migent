---
name: create-issue
description: >
  Create a GitHub issue in this repository that follows the issue forms in
  .github/ISSUE_TEMPLATE/. Pick the form, write each form section as a heading,
  apply the form's label, and confirm with the user before creating it. Use
  when the user says create issue, tạo issue, open an issue, or file a bug.
metadata:
  short-description: "Create a GitHub issue that follows the issue forms"
---

# Create an issue

Work from the repository root. Reply in the user's language, but write the
issue in English. The repository is `nodeint/migent`.

## Pick the form

Read `.github/ISSUE_TEMPLATE/` before writing; the forms are the source of truth.
Blank issues are disabled.

Pick the work type from the table in `CONTRIBUTING.md`, then:

- bugfix: `bug.yml`, label `bug`.
- every other type: `feature.yml`, with the label from that table. Types
  without a label (refactor, migration, docs, chore) get none.

Ask when the type is unclear.

## Write the body

`gh issue create --body` bypasses issue forms, so rebuild the form by hand:

- Use each field's `label` as a `### ` heading, in form order.
- Fill every required field. Omit an optional field rather than leaving it
  empty.
- Ground every claim in repository evidence or the user's report: link run
  URLs, cite files as `path`, and quote short error text.
- Keep it concise. Never include secrets, tokens, or private user data.

## Create

Show the title, label, and body to the user, and create the issue only after they
approve it. Write the body to a file in the scratchpad to avoid quoting problems.

```bash
gh issue create --title "<title>" [--label <label>] --body-file <file>
```

Report the issue URL. To fix an existing issue, use
`gh issue edit <n> --body-file <file>`.

## Next

Do not start the work. The `checkout-issue` skill reads the issue and creates
the branch.
