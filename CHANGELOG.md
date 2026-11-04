# Changelog

## Unreleased

## 0.3.5

### Added

- `migent session prepare` now writes an empty `task.md` and an editable `workflow.yaml` in the session directory. The draft is the session's workflow source, so a prepared session can be adjusted without changing `.migent/workflows/`; `session run --session` validates the draft, requires its `id` to match, and freezes it when the session starts.

### Changed

- The README explains role sessions, workflow capabilities, and the roadmap, with expanded setup and workflow examples, role instructions, human questions, and published outputs.

### Fixed

- A session no longer stays stuck in `running` when `migent session run` is killed right after a stage starts. Each execution now records its host and owner pid when it is created, not only after the provider spawns, so `migent session continue` can tell the owner is gone, fail the orphaned execution, and resume instead of refusing with "has an unverified live provider process". Executions created by earlier versions still need manual recovery (#51).

## 0.3.4

### Added

- `migent update` upgrades Migent to the latest published version with the package manager that installed it (npm, pnpm, yarn, or bun), or prints the command when it cannot tell. `--check` (or `--dry-run`) only reports; `--json` prints one object. After an upgrade it suggests `migent migrate` and `migent skill update` (#46).

### Changed

- Stage prompts are restructured as Markdown sections, ordered stable to variable: the response contract (status table, decisions, question rules) first, then the stage (`Role` and `Stage` instructions as separate lists, with stage lines already in the role list dropped, then constraints and verify), then upstream and routing context, then an `Execution` block with the task, session, question file and artifact paths, and a closing `Do` that is the only instruction for the turn. The instruction follows what the turn is (start, revisit, human reply, answers, verify repair, question-file correction); the kind is saved as `turn_kind` in `execution.json` so a resumed turn keeps it. The header format is shown as a block, and prompts no longer mention routing or execution IDs. The contract states that `recommended` holds the option letters Migent assigns (#44).

- Answers to stage questions are structured: every answer is numbered, echoes its question and selection kind, always has `Selected:` (option ID and label, or `none`), and adds `Free text:` only when given (#44).

- A turn that goes back to the same agent under the same response protocol (answering its questions, a verify repair, a question-file correction) no longer resends the full contract. It sends the new `Execution` paths, the previous artifact directory when resuming a question, and a short status reminder (#44).

### Fixed

- `migent session continue <session> --stage <stage> --reply` keeps running the workflow after the answered stage. Before, it dispatched only that stage, like `--once`, and left downstream stages undispatched. `--stage` without `--reply` still dispatches one stage.

## 0.3.3

### Added

- `migent doctor` warns about workflow and role keys Migent does not use, with a suggested key, and about decision `when` text left as the migration placeholder.

- `migent session continue --reply` redirects a stopped (cancelled) workflow stage or role session. The reply runs as a new execution in the same conversation.

### Changed

- Agents ask questions by writing a JSON document to a request file whose path is in the response contract, then answering `status: question`. The response body is a normal report and is never parsed for questions, which removes the contradiction between "the body is JSON" and "use a blank line before the report body". An unusable file gets one correction turn, then the stage fails with `question_file_invalid` and an error that names the file, the problem and how to recover. `parseStageOutcome` from `@nodeint/migent-kernel` now reads response headers only; `resolveStageOutcome` loads the question file. Inline JSON in the response is no longer accepted.

- Prompt templates and renderers live in the new `@nodeint/migent-prompts` package and render from packaged Markdown templates while preserving workflow and conversation behavior.

- Stage prompts state status meanings once, describe the verify gate as engine behavior, name the artifact once, and render answered questions as readable Q/A text. Re-entry prompts name the task, the stage's previous response, and upstream artifacts updated since its last visit.

- `migent init` renders role models and sample workflows from packaged project templates.

## 0.3.1

### Fixed

- Release tags are validated on `next`; `main` advances to the exact tagged commit only after all four npm packages and the installed CLI are verified.

- `migent migrate` upgrades and versions `config.local.yaml`, resolves providers across config layers, and preserves shared roles whose default model is supplied locally.

## 0.3.0

### Added

- Internal packages include README files linking to the Migent CLI on npm.

- Workflows can suggest `downstream` runs with explicit artifact mappings. Completed sessions publish `next.json` and copyable commands using `--prior`. Target sessions snapshot named context at start; `--prior` without a matching suggestion accepts an explicit task and all published source outputs.

- Stages can opt into human decisions with `ask: human` and return `status: question` with a structured JSON question batch. Session `questions.json` records all rounds, context, options, single/multiple selection modes, and answers; each execution keeps its original batch. Migent numbers questions and letters options in order, accepting short replies such as `1A, 2B, 3 explain further` or `2A+C` for multiple selections. Free-text answers are always allowed. Reply with `session continue --reply` or `--reply-file`, selecting `--stage` when needed. Answers are validated before dispatch. Questions stop only their branch, exit with code 9, and preserve artifacts and the remaining verification budget across replies. Standalone role sessions can ask the human too.

### Changed

- Schema v4 removes workflow `requires`; workflows run independently. `migent migrate` removes prerequisites with guidance for manual downstream setup. Prepared sessions freeze workflow, models, and prior artifacts when started, so edits before `run` take effect.

- Schema v3 declares each stage decision with `when` instructions for the agent and a `navigate` destination. `migent migrate` converts older values/routes while preserving existing stage instructions. Frozen sessions retain their original schema and behavior.

## Older versions

- [0.2.1](https://github.com/nodeint/migent/releases/tag/v0.2.1)
- [0.2.0](https://github.com/nodeint/migent/releases/tag/v0.2.0)
- [0.1.11](https://github.com/nodeint/migent/releases/tag/v0.1.11)
- [0.1.10](https://github.com/nodeint/migent/releases/tag/v0.1.10)
- [0.1.9](https://github.com/nodeint/migent/releases/tag/v0.1.9)
- [0.1.8](https://github.com/nodeint/migent/releases/tag/v0.1.8)
- [0.1.7](https://github.com/nodeint/migent/releases/tag/v0.1.7)
- [0.1.6](https://github.com/nodeint/migent/releases/tag/v0.1.6)
- [0.1.5](https://github.com/nodeint/migent/releases/tag/v0.1.5)
