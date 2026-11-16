---
name: markdownlint
description: >
  Check and write repository Markdown to the markdownlint rules.
  Use when creating or changing Markdown, or
  when validating Markdown style and links.
user-invocable: true
---

# Markdownlint

Run commands from the repository root.

## Commands

Check every Markdown file included by the repository configuration:

```bash
pnpm lint:md
```

Check only selected files or directories:

```bash
pnpm lint:md -- <paths>
```

Apply supported automatic fixes only when the user requested them:

```bash
pnpm lint:md:fix -- <paths>
```

Check local Markdown links across the repository when links changed or link validity matters:

```bash
pnpm lint:md:links
```

Limit the link check to selected paths:

```bash
pnpm lint:md:links -- --path <dir>
```

The lint commands apply `.markdownlint-cli2.jsonc`, including its ignored paths.
Confirm the output names the files that were linted;
zero findings do not verify a requested file when the command reports that it linted zero files.

Read [`scripts/docs/lint-md.mjs`](../../../scripts/docs/lint-md.mjs) for lint command behavior.
Read [`scripts/docs/lint-md-links.mjs`](../../../scripts/docs/lint-md-links.mjs) for link-check command behavior.

## Handoff

Report each command and its result. Name any requested file that configuration excluded from the run.
Do not report Markdown verification as passing when a required command failed, was not run,
or linted no requested files.
