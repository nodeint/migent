# Issue summary template

Use these sections, in this order, in every issue summary, in the conversation or in `issue.md`.
Keep the headings exactly; write `None.` under a section that has no content.
Use the bug variant of the middle sections for bugfix and the feature variant for every other type.

```markdown
# Issue #<n>: <title>

## Source

- URL: <url>
- State: <open|closed>; labels: <labels>
- Type: <feature|bugfix|refactor|migration|docs|chore> (form: <bug|feature|none>)
- Branch: <branch> from origin/next
- Comments: <count>; <one line per relevant comment, with its URL>
- Related: <linked or duplicate issues and open pull requests, with URLs; or None>

## Problem

<One to three sentences in your own words: who is affected and what falls short.>

<!-- Feature variant -->
## Requested behavior

<Up to eight bullets condensing the issue's proposal. Name contracts, commands, and fields;
leave full detail in the issue. These are the issue's statements, not approved decisions.>

<!-- Bug variant -->
## Reproduction

<Steps, expected behavior, actual behavior, and environment, as stated in the issue.>

## Desired outcome

<Up to five bullets: what users or maintainers should be able to do or observe once the issue
is resolved, as stated in the issue. Describe product behavior, not implementation.
Use the issue's own success criteria when it has them; do not add or widen any.
For a bug: the expected behavior from Reproduction, in one line.>

## Constraints

<Constraints the issue states: compatibility, breaking changes, versions, platforms.>

## Out of scope

<Items the issue excludes.>

## Triage evidence

- Affected areas: <packages, commands, and files read, with paths>
- Scope signal: <single module | crosses contracts or packages: names>

## Gaps

- Blocking: <missing or conflicting information needed to choose the next workflow; ask the human>
- For design: <solution questions the issue leaves open; one line each, no proposed answers>

## Human decisions

<Questions asked during triage and the human's answers, one line each.>

## Workspace

<Uncommitted or unrelated changes found and what the human decided; or None.>

## Recommended next

<`design` or `implement`>: <one sentence on why, citing Triage evidence.>
Confidence: <high|low>; assumptions: <assumptions the recommendation depends on, or None>
```

## Rules

- Summarize; do not copy the issue body. The issue stays the source of detail.
- Never add requirements, criteria, solutions, or answers to gaps.
- When a later comment by the author or a maintainer changes the body, follow the comment and list it under Comments.
- Triage evidence records only what was read; it names locations, not causes or fixes.
- Desired outcome is input for `design`, which derives the acceptance criteria; never label its items AC.
- A gap is blocking only when it prevents choosing the next workflow; resolve blocking gaps with the human before finishing.
- Recommend `design` when the scope crosses contracts or packages, a bug's cause is unclear, or the solution needs structural decisions; `implement` only when one module owns the change and its solution is obvious.
