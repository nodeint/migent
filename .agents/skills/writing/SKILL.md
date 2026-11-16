---
name: writing
description: >
  Write and restructure repository Markdown content.
  Use when creating, changing, splitting, merging, or reviewing Markdown documents, skills, or issue and PR text.
---

# Writing

These rules govern content and file structure.
Load the `markdownlint` skill for style and link validation.

## Language

- Write all content in English, regardless of the language of the request or source material.
- Translate non-English input; do not quote it unless the exact wording is the subject.

## Content

- Be concise: one idea per sentence, no filler, no repetition across sections or files.
- Describe the current state as-is: what the code, command, or process does now.
  Do not describe intended, planned, or historical behavior unless the document is about it.
- Verify every claim against repository evidence before writing it.
- State facts and rules; limit interpretation, rationale, and speculation to what a reader needs to act.
- Prefer lists and tables over prose when content is enumerable.
- Link to the owning document instead of restating its content.

## Outline

- Start with a single `#` title, followed by a one- or two-sentence purpose when the title is not self-explanatory.
- Order sections by how a reader uses them, for example overview, rules, steps, then reference.
- Keep headings short, specific, and parallel in form; do not skip heading levels.
- Keep each section focused on one topic; split a section that mixes topics.

## File size and structure

- Keep one topic per file. Split a file when it covers several independent topics
  or readers routinely need only part of it.
- Merge a file into its parent or sibling when it is too small to stand alone,
  such as a few lines that are only read together with another file.
- When splitting or merging, review the surrounding directory:
  - Group related files in a directory named for their shared topic.
  - Avoid directories holding a single file and flat directories mixing unrelated topics.
  - Keep names consistent with sibling files and directories.
- After moving, renaming, or removing a file, update every link and index that references it,
  including `AGENTS.md`, `docs/README.md`, and package READMEs.
- Confirm structural changes with the user before applying them when they reach beyond the requested files.

## Handoff

1. Run the `markdownlint` skill checks, including the link check when files moved or links changed.
2. Report files created, changed, moved, or removed, and any claim not verified against the repository.
