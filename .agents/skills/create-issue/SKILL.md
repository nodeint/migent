---
name: create-issue
description: Create or update GitHub issues using repository templates and labels.
---

# Create an issue

## Steps

1. Resolve the repository from contribution rules or Git remotes. Read its issue
   language, templates, configuration, work types, and labels. Ask if the target
   or required policy is unclear.
2. Select the matching template and labels. If no template exists, use problem,
   expected behavior, evidence, and constraints only when repository rules permit it.
3. Gather required fields from the user's report and repository evidence.
   Ask for missing required information or an unclear work type.
4. Draft the title and body in the repository's issue language. For YAML forms,
   reproduce field labels as headings in order, fill required fields, and omit empty
   optional fields. For Markdown templates, retain the required structure.
5. Link supporting sources and remove secrets or private data. Show the title,
   labels, and body for approval; reuse approval for that exact content.
6. Write the approved body to a temporary file. Create or update using the explicit
   repository, title, and labels:
   `gh issue create --repo <owner>/<repo> --title "<title>" --body-file <file> --label "<label>"` or
   `gh issue edit <n> --repo <owner>/<repo> --title "<title>" --body-file <file> --add-label "<label>"`.
   Repeat label flags as needed; omit them when none apply. On edits, preserve
   unrelated labels and use `--remove-label` only for approved removals.
7. Report the issue URL in the user's language. Do not create a branch or start
   implementation unless requested.
