# Review: quality of the prompts Migent sends to agents

## Goal and scope

Record concrete weaknesses in the prompts that the shipped `implement` and
`plan` workflows produce, with the exact prompt text as evidence, so a
follow-up change can fix them. This document changes no behavior.

Two kinds of finding are kept apart because they have different owners:

- **Template findings (T1-T9)** are content in `templates/config.yaml` and
  `templates/workflows/*.yaml`. A workspace created by `migent init` receives
  these bytes unchanged.
- **Engine findings (E1-E5)** are text assembled by `packages/kernel`, which no
  workflow file can override.

Out of scope: how a project's own `AGENTS.md` is discovered, and model or
effort selection.

## Evidence base

Six sessions of the VS Code extension repository (`migent-vscode`), run on
2026-11-02 with the `implement` workflow. Their `.migent/config.yaml` and
`.migent/workflows/*.yaml` match the templates in this repository, apart from
the model placeholders in `config.yaml`. The sessions produced 26 prompt
files. Prompts of the same kind differ only in session paths, so five kinds
exist: implement (first), review (first), implement (revision), review
(revision), and implement (reply to a human answer).

Session `a895aac7` (task: "tiếp tục implement S11") ran five executions:
implement, review (`revise`), implement (asked the human), then two more
implement runs answering the human. It is the main case study for T4 and T7.

Prompt-engineering criteria used for judging, with their limits:

- Keep the context to the smallest set of information that fully describes the
  expected behavior, at an altitude between brittle rules and vague direction
  ([Anthropic, Effective context engineering for AI agents][ctx]).
- Do not repeat or contradict instructions; repetition adds tokens without
  signal.
- A reviewer needs a decision rule it can apply, a fixed severity scale, and a
  required evidence format per finding. Practitioner reports describe fewer
  false positives with these ([G-Research][gr], [cubic][cubic]). These are
  vendor and practitioner write-ups, not a standard.
- A multi-step agent needs explicit stop and escalation conditions
  ([OpenAI, GPT-4.1 prompting guide][oai]).

Not verified: the full text of Anthropic's model-specific "Prompting best
practices" page was not available when this was written. Claims about
positive framing and stating the reason for a rule are general guidance, not
quoted from it.

## Template findings

### T1. Decision criteria are placeholders that restate the decision name

Prompt text sent to the reviewer (`0002-review_work--attempt-01`):

```text
Choose exactly one decision using these instructions:
- approved: Choose approved according to the stage instructions.
- revise: Choose revise according to the stage instructions.
```

Source: `templates/workflows/implement.yaml:31` and `:34`;
`templates/workflows/plan.yaml:34` and `:37`. The same string is what
`packages/kernel/src/migration.ts:138` generates, and `docs/workflows.md`
(section "Decisions and routes") tells users to review these placeholders and
move their criteria into `when`. The shipped template therefore contains the
value the documentation says to replace.

Impact: the section meant to define the decision contains no information. The
real rule sits in a separate instruction bullet
(`implement.yaml:28`, "Choose approved when the task is complete and
verified; otherwise choose revise."), so the agent must connect two places.

Proposal: put the rule in `when`, using the form the docs already show:

```yaml
- approved:
    when: Every requirement in the task is met, the relevant checks passed with
      evidence, and no required fix remains.
- revise:
    when: At least one required fix remains. List each with file, evidence,
      impact, and correction.
```

### T2. Role and stage instructions say the same thing twice

The prompt prints both lists, one after the other. For the developer role in
the first implement prompt:

```text
Role instructions:
- Follow any agreed architecture. Report blockers and seek a decision before changing it.
- Run relevant checks or tests and fix failures caused by your changes.
- Report what changed, the verification results, and anything not verified.

Instructions:
- Report architectural blockers with evidence. Seek a decision before changing the agreed design.
- Run relevant checks and tests, and report results and anything unverified.
```

Other duplicated pairs:

| Idea | Place A | Place B |
|---|---|---|
| Follow conventions and agreed architecture | `config.yaml` developer bullets 2 and 4 | `implement.yaml:10` |
| Report all findings together | `config.yaml` reviewer bullet 5 | `implement.yaml` review stage bullet 4; `plan.yaml:29` |
| No personal-preference blocking | `config.yaml` reviewer bullet 6 | `implement.yaml` review stage bullet 3 |
| Do not change source (planner) | `config.yaml` planner bullet 2 | `plan.yaml:4` constraint |
| Keep design proportional | `config.yaml` planner bullet 4 | `plan.yaml:14` |

Impact: the developer prompt has 12 bullets for roughly 6 ideas. Duplicated
wording that differs slightly ("blockers" versus "architectural blockers with
evidence") invites the agent to infer two different rules.

Proposal: a role states stance and boundaries (who you are, what you may
touch). A stage states the procedure, the output, and the done condition for
that stage. Each idea appears once.

### T3. No definition of done and no artifact structure

The implement stage tells the developer to "Implement within scope"
(`implement.yaml:10`) and to "report results and anything unverified"
(`:14`). It never says where the acceptance criteria come from, and it names
the artifact (`produces: artifact: implement.md`) without describing its
contents. The review stage consumes that file as its only upstream artifact:

```text
Upstream artifacts on this session:
- implement: ...\0001-implement--attempt-01\artifacts\implement.md
```

Impact: the reviewer cannot tell which files belong to this run. In the
sessions, the working tree held uncommitted changes from earlier slices, and
one task said "Preserve existing uncommitted slice 9 changes". Without a list
of changed files, the reviewer's scope is a guess. The same gap applies to
`plan.md`.

Proposal: add to the implement stage an output rule such as: "`implement.md`
has these sections: Changed files; Requirement-to-evidence table; Checks run
(command and result); Not verified, with reason; Open questions." Add a
similar section list for `plan.md`.

### T4. No rule for when to ask the human, so unverifiable work is reported as complete

`implement` has `ask: human`, and the engine explains how to ask
(`runtime.ts:70-74`), but no instruction says when asking is required.

Session `a895aac7`, first review response, in full:

```text
status: complete
decision: revise

Two required parts of S11 remain incomplete:

1. **Windows manual verification is missing.** implement.md:21 confirms AC2,
   AC3, AC7, AC10, AC13, and AC18 were not exercised. ...
2. **AC22 performance evidence is insufficient.** The 487 ms standalone
   `SessionStore.load()` measurement does not verify the required host
   budgets. ...
```

The first `implement` attempt had already written those gaps into
`implement.md` and still returned `status: complete`. Only the revision attempt
(`0003-implement--attempt-02`) recognised that the items need a person or a
real host and returned `status: question` ("I can run VS Code on this Windows
machine only through the automated integration harness. I cannot drive the
GUI ..."). That question was then answered in two further rounds (`0004`,
`0005`).

Impact: one full implement-plus-review round was spent before the question
that could have been asked at the start.

Proposal, in the implement stage: "Before changing code, list the
requirements that cannot be verified by running commands here (manual steps,
real-host measurements, missing access). Ask the human about them with
`status: question` first. Report `status: complete` only when every
requirement is verified or the human has accepted the gap." In the review
stage: "Evidence that only the human can supply is a question for the human,
not a required fix for the developer."

The workflow has only `approved` and `revise` today. Whether a third decision
(for example `escalate`) is feasible is an open question for the maintainers.

### T5. The revise rule is vague and asymmetric

`implement.yaml:28`: "Choose approved when the task is complete and verified;
otherwise choose revise." Any finding, including a stylistic one, satisfies
"otherwise". The plan workflow is better: `plan.yaml:30` and `:31` say "Choose
revise for substantive gaps" and "Do not revise for style or formatting".
Reviewer role bullet 6 adds "Do not block on personal preference", but gives
no scale for what counts as blocking.

Proposal: define two classes once, in the review stage.

- Required: wrong behavior, regression, unmet requirement, missing or
  unconvincing verification evidence.
- Optional: style, preference, out-of-scope improvements. List separately; they
  never cause `revise`.

### T6. No re-review rule

`implement.yaml:15` tells the developer to "address all required review
findings". The reviewer side has no matching rule for the second visit. In the
sessions the reviewer on the revision pass received only
`Continue this stage.` (see E1) and nothing in the workflow tells it to check
the previous findings first.

Impact: a reviewer can open new, unrelated findings on every pass, which makes
`max_revisions` an exhaustion limit rather than a convergence aid.

Proposal: "On a re-review, first confirm that each required fix from the
previous review is resolved. Raise a new required fix only if the revision
introduced it or it is a serious defect missed earlier."

### T7. "Evidence appropriate to the work" does not say what evidence is

Reviewer role bullet 2: "Assess correctness, completeness, scope, and
maintainability using evidence appropriate to the work." Review stage bullet 4:
"Report all required fixes together with file locations, impact, and required
corrections."

In session `a895aac7` the reviewer ended with: "Runtime and integration
suites were not rerun during this review." Nothing in the prompt asked for a
rerun, and nothing forbade trusting `implement.md`.

Proposal: require each finding to carry `file:line`, the evidence (code
excerpt or command with output), the impact, and the correction. State that
the reviewer checks claims in `implement.md` against the diff and reruns the
narrowest relevant checks when it can.

### T8. The plan excludes the information the developer later lacks

`plan.yaml:16`: "Exclude implementation steps, code-level details, and test
procedures." `plan.yaml:28` makes the reviewer enforce the same exclusion.
Acceptance criteria and a verification method are not mentioned in either
stage.

Impact: the implement stage receives a plan with no statement of what to
measure and what threshold to meet. In session `a895aac7` the missing piece
was exactly that: how AC22 was to be measured on the host.

Proposal: allow, and require, acceptance criteria and the verification
approach at the "what, threshold, and who runs it" level, while still
excluding step-by-step test procedures.

### T9. Style of the instructions

- Bullets mix levels (scope, procedure, output, escalation) without labels.
  Short labels such as `Scope:`, `Output:`, `Done when:`, `Escalate:` make the
  purpose of each line obvious.
- Most rules are negative ("Do not modify project files", "Do not block...").
  A rule with the replacement action and a short reason is easier to follow:
  "Do not edit project files, so the review stays independent; put proposed
  edits in the finding."

## Engine findings

### E1. The revision prompt for a review stage has no task, criteria, or prior findings

`buildStageResumePrompt` (`packages/kernel/src/prompt.ts:63-72`) returns
`Continue this stage.` plus continuation sections. For a stage that is not the
target of a routed decision, the sections contain only the upstream artifact.
Entire prompt `0004-review_work--attempt-02`, before the contract:

```text
Continue this stage.

Upstream artifacts on this session:
- implement: ...\0003-implement--attempt-02\artifacts\implement.md
```

It works only because the provider conversation is resumed
(`execution.json`: `"resumes_execution_id": "0002-review_work--attempt-01"`).
It names no task file, no previous review response, and no instruction to check
earlier findings. If the conversation is lost or compacted, the reviewer has no
criteria.

Proposal: include the task file location and the stage's own previous
`response.md` in the resume prompt, as `routedResultLines` already does for
routed stages (`prompt.ts:178-188`).

### E2. The response contract repeats a large block that is mostly an example

`addStageOutcomeContract` (`packages/kernel/src/runtime.ts:56-86`) appends the
whole ask-the-human block (lines 70-74, about 1.3 KB) to every prompt of a
stage that has `ask`, including the revision prompt and the reply prompt. In
the first implement prompt (2,844 bytes) that block is about half the text.

Some of it is redundant: line 72 "Never choose on the recipient's behalf." and
line 74 "Do not choose a decision while asking."; line 71 "Put every choice and
its explanation in the JSON, not in prose." beside line 85 "Use a blank line
before the report body."

The example in line 70 is unrelated to the user's task and may bias wording:

```text
{"schema_version":1,"questions":[{"question":"Include existing sessions?","context":"Migration adds work.", ...
```

Proposal: send the full contract on the first visit and a one-line reminder on
resumed visits; shorten the rules; use a neutral example or a schema.

### E3. The reply prompt is raw JSON with empty fields

`buildStageReplyPrompt` (`prompt.ts:58-60`) returns
`Reply to: ${question}\n${reply}`. Session `a895aac7`, `0005-implement--attempt-04`:

```text
Reply to: I wrote the Windows manual checklist and the AC22 measurement procedure. Please review it, then choose how S11 should proceed.
{
  "answers": [
    {
      "question_id": "1",
      "selected": [],
      "text": "Chạy các bước tự động hóa khả thi theo phương án A: ...",
      "question": "I wrote the Windows manual checklist ...",
      "labels": []
    }
  ]
}
```

The question is printed twice, `selected` and `labels` are empty, and the prompt
does not say what to do with the answer.

Proposal: render `Question: ... / Answer: ...` (with selected labels when
present) and one line: "Act on the answer. Ask again only for decisions that
still belong to the human."

### E4. Placeholder `when` is generated and shipped

See T1: `migration.ts:138` writes the tautology, and the templates contain it.
Proposal: have `migrate` leave `when` empty and fail validation with a message,
or write an explicit `TODO` the doctor reports, so the placeholder cannot reach
an agent unnoticed. `migent doctor` could warn on a `when` that equals the
generated string.

### E5. Repeated paths and a duplicated artifact line

- The session directory path appears in the task line, the session line, the
  upstream artifact line, and the artifact directory line of each prompt.
- The artifact instruction is printed twice: `prompt.ts:49-53` ("Write the
  file artifact as `implement.md` in the execution artifacts directory.") and
  `runtime.ts:50-53` ("Write the file artifact as `implement.md` in that
  directory."). Both are visible in `0001-implement--attempt-01/prompt.md`.

Proposal: state the artifact instruction once, after the artifact directory.

## Suggested order

1. T1 and E4: fill `when` and stop shipping placeholders.
2. T4 and T5: escalation and the required/optional scale. These cut the most
   wasted attempts.
3. E1 and T6: complete the revision prompt and add the re-review rule.
4. T2, T3, T7, T8: remove duplication and add output and evidence rules.
5. E2, E3, E5: shorten engine text.

## How to verify a change

Re-run the same workflow with a task that has a requirement needing the human
(like AC22) and compare, per attempt: whether the agent asked before
`complete`, the number of attempts, the size of each prompt, and whether every
review finding carries location, evidence, impact, and correction. Prompt
tests in `packages/kernel/test/prompt.test.ts` should pin the new wording.

[ctx]: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
[gr]: https://www.gresearch.com/news/building-a-code-review-tool-the-llm-patterns-that-actually-work/
[cubic]: https://cubic.dev/blog/learnings-from-building-ai-agents
[oai]: https://cookbook.openai.com/examples/gpt4-1_prompting_guide
