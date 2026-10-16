# Plan: CLI developer-experience improvements

Scope: `packages/cli/src/commands/*` and the command wiring in `packages/cli/src/program.ts`.

Mark a task `[x]` when it is merged. This version was revised after a review that checked the first draft against the code. Claims below were verified against the code unless marked **(verify)**.

## Decisions (resolved)

1. **stdout contracts do not change.** `start` and `continue` keep printing one JSON object on stdout. `service start` keeps `host:port`. `workspace register` and `workspace remove` keep their JSON. `sessions --json` stays a bare array. Tests, `docs/cli.md` and the skill template depend on these. New human-readable text goes to stderr only.
2. **`--once` never resets revisions.** `stage` does not reset them, `continue` does. After the merge, `continue S --once` behaves like the old `stage S` (no reset) and `continue S` behaves as today.
3. **Fewer merges than first proposed.** `skill install/update` stay separate (merging changes exit codes and `--force` meaning). `service` with no subcommand stays as help. Result: 21 leaf commands down to 18 (`stage` and `watch` removed, `agent start/continue` become one `agent`), not 13.
4. **No TTY-dependent output.** Nothing switches between JSON and text based on a TTY, because agent hosts allocate TTYs.
5. **Changed exit codes are listed in the changelog:** 1.2 (`init`), 1.5 (`service status`), 0.4 (bare `config`), 1.6 (prompt cancel, 2 to 130).

## Order

Phases are **not** independent: later tasks use the Phase 0 names. Order: Phase 0, then 1 to 4 in any order, then Phase 5 (docs) once at the end, so the docs are rewritten one time. Phase 5 also covers the extra doc files below.

---

## Phase 0: Merge commands

| Before | After |
|---|---|
| `stage SESSION` | `continue SESSION --once` |
| `stage --workflow W --task T` | `start W --task T --once` |
| `agent start`, `agent continue S` | `agent --role R [--session S]` |
| `watch S`, `watch S --once` | `sessions S --follow`, `sessions S` |
| `config show` | bare `config` (also keeps `config show`) |

### 0.1 `--once` on `start` and `continue`
Implementation: reuse the existing `action: "stage"` path in `execute.ts` (`once: true`, `resetRevisions: false`, attempts and dispatch ceilings `null`). Build the old `stage` behaviour on top of it before deleting `stage`.
- [x] Add `--once` to `start` and `continue`.
- [x] Reject `--once` with `--attempts`, `--max-dispatches` or `--unlimited-dispatches`. Check the **raw Commander option values** (`attemptsOf` and `dispatchCeiling` always return defaults, so checking resolved numbers would reject every `--once` run).
- [x] `--once` exit codes are `STAGE_EXITS` (0, 1, 2, 4, 130). Do not advertise 3 or 5 for it.
- [x] Help text states that `continue` resets revisions and `continue --once` does not.
- [x] Tests: `start --once` and `continue --once` match the old `stage` tests case by case.

### 0.2 Merge `agent start` and `agent continue`
- [x] Single `agent` command: `--role`, optional `--session`, existing prompt, provider and `--option` flags.
- [x] Keep the rule that `--task` cannot be combined with `--session`.
- [x] `agent` with no flags still prints help and exits 2 (current behaviour of the group).

### 0.3 Merge `watch` into `sessions`
- [x] `sessions` lists. `sessions S` prints the snapshot and exits 0, like `watch S --once` (also exits 0 for blocked sessions, as today).
- [x] `sessions S --follow` keeps the current `watch` behaviour: print the snapshot, then follow, unless `--cursor` is given.
- [x] `--cursor` is only valid with `--follow`. `--until` requires `--follow` and `--execution`. Error messages name the missing flag.
- [x] `--json` meaning per mode, documented in help: list is an array, snapshot is one object, follow is one snapshot object followed by JSON lines (only JSON lines when `--cursor` is given).
- [x] Keep the current `watch` validation messages for the old names through the aliases (`--once cannot be combined with --until`, `--once cannot be combined with --cursor`, `--until requires --execution.`). The new `sessions` command may word them for its own flags, but the alias path must not change them.
- [x] Keep `--execution`.

### 0.4 Bare `config` prints the config
- [x] Bare `config` prints `.migent/config.yaml` and exits 0 (it currently prints help and exits 2). `config show` stays as a normal subcommand.

### 0.5 Deprecated aliases (hidden)
Each alias needs its own argument remap, so write one small adapter per alias, not one generic helper.
- [x] `stage S [--prior P]` to `continue S --once [--prior P]` (`--prior` is valid on the session form today; `bindPriorSessionId` checks it); `stage --workflow W --task T [--prior P]` to `start W --task T --once [--prior P]`.
- [x] Implement hidden `stage` by calling `executeWorkflow` with `action: "stage"` and hidden `watch` by calling `watchSession`, so old validation and exit codes are kept. Do not use Commander `.alias()`.
- [x] `executeWorkflow` has no separate `once` field. `start --once` and `continue --once` must pass `action: "stage"` (or change that condition in `commands/execute.ts`).
- [x] `agent start` and `agent continue S` to `agent` (positional `S` becomes `--session S`).
- [x] `watch S` to `sessions S --follow`; `watch S --once` to `sessions S`. Preserve `--execution`, `--until`, `--cursor`, `--json`.
- [x] Each prints `'<old>' is deprecated; use '<new>'.` on stderr.
- [x] Tests assert that old invocations keep their old exit codes and output.
- [x] Record the removal release in the changelog (one minor release after this one).

---

## Phase 1: Correctness and small fixes

### 1.1 Registry reports a hardcoded tool version
`workspace-registry.ts` sends `version: "0.1.0"`.
- [x] Export the package version from a small module that does not import `program.ts` (`program.ts` imports `runRegister`, so importing back would cycle). Use it in `program.ts` and `runRegister`.
- [x] Test that the register body carries the package version.

### 1.2 `init` exit code reflects `doctor`
`runInit` returns `runDoctor(...)`, so a missing provider CLI makes a successful `init` exit 1. This is a deliberate exit-code change (Decision 5).
- [x] Return 0 once files are written. Print doctor problems as an advisory on stderr.
- [x] Update the init tests that expect doctor's exit code.

### 1.3 `init` ignores flags when already initialized
- [x] When state is `ready`, warn if `--provider`, `--model` or `--option` was passed: `Already initialized; ignoring --provider/--model/--option.`
- [x] Detect `--preset` with `command.getOptionValueSource("preset") === "cli"`. `--preset` has a default, so a value check would warn every time.
- [x] `--skill` is not ignored on this path (it still installs). Do not warn about it.

### 1.4 `parsePort` message and range
- [x] Reject 0 and values above 65535 with `--port must be an integer from 1 to 65535.`
- [x] Unit tests: `0`, `65536`, `abc`, `-1`.

### 1.5 `service status` exit code
- [x] Exit 1 when stopped (running stays 0). `--json` output unchanged. Decision 5 applies: update `service.test.ts`.
- [x] `service stop` on an absent service stays 0. Say in the help text why (stop is idempotent, status is a query).

### 1.6 Prompt cancel
Today cancel throws a plain `Error` ("Choose a value.", "Provider is required.", "Unknown model: …", "Enter a value.") that the callers print with exit 2.
- [x] Add `PromptCancelled`. In `init.ts` and `config.ts`, `isCancel(result)` is OR'd with a validity check in the same `if` (`Provider is required.`, `Unknown model:`, `Unknown ${name} value:`, `Answer yes or no.`, `Choose a value.`, `Enter a value.`). Split them: throw `PromptCancelled` only when `isCancel` is true, keep the existing error for a bad value (otherwise a bad selection becomes a silent 130).
- [x] Non-cancel errors such as `No providers are available.` and `Model is required.` stay exit 2.
- [x] The inner `catch (error instanceof Error)` blocks in `runInit` and `runConfigModel/Role` must rethrow it.
- [x] Handle it once in `index.ts`: print nothing, exit 130.
- [x] `migrate.ts` is **not** changed: it treats cancel as "decline" (`Left unchanged.`, exit 0). Add a test that locks this in.

### 1.7 Not bugs (dropped after review)
- `init --skill` with an existing skill directory writes nothing and exits 1, as `docs/cli.md` says. Nothing to fix. Optional: make the message say `Nothing was written.`
- `config show` with no project already exits 2 through `findWorkspace`. No `ENOENT` handler is needed.

---

## Phase 2: Feedback

`start`/`continue` already log `session_id: …`, `stage <id> · provider/model` and provider progress to stderr (`packages/kernel/src/execute.ts`). Do not add a second printer.

### 2.1 `agent` prints the session id too late
`agent.ts` prints `session_id` only after `runner.run` returns.
- [x] Print it right after `createAgentSession` (same stderr style as `start`). Keep the `--json` result unchanged.

### 2.2 Next-step hint when a run stops
- [x] On stderr, after the result, print `Resume with: migent continue <session>` for `retry_exhausted`, `revisions_exhausted` (exit 4) and `dispatch_limit`. Do this in `packages/cli/src/commands/execute.ts` right after `printResult` (the kernel does not print the result object).
- [x] stdout stays a single JSON line. Add a test.

### 2.3 Confirmation lines for silent commands
Human lines go to stderr so stdout contracts stay intact.
- [x] `service stop`: `Stopped.` or `Not running.`
- [x] `workspace register` / `remove`: one summary line on stderr (`register` already writes `Registering <path>`).
- [x] `service start --foreground` blocks until shutdown. Leave as is: `serveForeground` (`packages/registry/src/service.ts`) already writes `host:port` to stderr before serving, and an adopted service returns without a line.

---

## Phase 3: Consistency

### 3.1 Output rule (documentation only)
- [x] Write the rule in `docs/cli.md`: stdout is the result, stderr is progress and notices, `--json` selects machine output where a command has a human form.

### 3.2 Remove index-based session JSON
`sessions.ts` maps `row[1]`…`row[7]`. Row 0 is `updated_at` and is intentionally left out.
- [x] Name the indices once in the CLI (a typed helper or constants) and use it for both JSON and the table. Do not change the kernel export `listSessionRows`.

### 3.3 Input prompts can be turned off
`init` is interactive when `provider === null && stdin.isTTY`. `config model/role` are interactive when they have no mutating flags and stdin is a TTY. Non-interactive `config model/role` with no flags already lists and exits 0.
- [x] Add `--no-input` (and `MIGENT_NO_INPUT=1`) to `init`, `config model` and `config role` only. It forces the non-interactive path.
- [x] With `init --no-input` and missing flags, keep the current message: `Pass --provider and --model when init is not interactive.`
- [x] `config` keeps listing on `--no-input`. Do not turn it into an error.
- [x] `migrate` keeps its own TTY check and `--yes`. Do not add it to this flag.

### 3.4 Help text and wording
- [x] Clarify that `config role --model-name` is the `models:` name and `--model` is a provider model id. No rename and no new alias.
- [x] Keep the accurate `--prior` text: the session must be completed, have the workflow id and decision named in the `requires` block (`resolvePriorSessionId` in `packages/kernel/src/session-records.ts`). Add that it is checked before outputs are injected.
- [x] `agent --task`: "Label for the new session. Cannot be used with `--session`."

### 3.5 Exit codes in one place
- [x] Define the exit constants once (OK, BLOCKED, CONFIG, ATTEMPTS, REVISIONS, DISPATCHES, CANCELLED).
- [x] Keep **two** lists: the loop (`start`/`continue`, shared by both) and `--once` (`STAGE_EXITS`). Build the first once instead of duplicating it.
- [x] Add exit-code help text to `doctor`, `sessions S`, `agent` and `service status`.
- [x] `untilTerminalExitCode`: remove the unreachable last `return 1` only. A finished `cancelled` execution keeps exit 1; 130 stays reserved for SIGINT.

### 3.6 Typed errors
- [x] Plain `Error` thrown from `init`, the prompters and `resolvePrompt` become `ConfigurationError`, mapped to exit 2 in `index.ts`.
- [x] `PromptCancelled` (1.6) is exempt, and `migrate` is untouched.

---

## Phase 4: Discoverability

### 4.1 Follow stops by itself
- [x] Add opt-in `--exit-when-done` to `sessions S --follow`. Default follow keeps today's behaviour (until a signal), so the hidden `watch S` alias keeps its exits.
- [x] With the flag and no `--execution`, exit when the session status is `completed` (0), `blocked` (1) or `cancelled` (130, from `EXECUTE_EXIT_CODES` in `packages/kernel/src/execute.ts`). `TERMINAL_SESSION_STATUSES` is not exported; copy the three names or export it.
- [x] 3.5's "130 stays reserved" applies only to `untilTerminalExitCode` (a finished execution with status `cancelled` returns 1). This flag is about session status and is a different case.
- [x] Describe `--cursor` as an option for tools.

### 4.2 Examples in help
- [x] `sessions --help` shows list, snapshot and follow examples.
- [x] `continue --help` shows `--once`.

---

## Phase 5: Docs and shared helpers (end)

### 5.1 Docs, once
- [x] Update every place that names commands: `docs/cli.md`, `docs/sessions.md`, `docs/workflows.md`, `packages/cli/README.md`, root `README.md`, `.agents/skills/migent/SKILL.md` (installed copy), and the template `packages/cli/src/templates/migent/SKILL.md` (source of truth, not a top-level `templates/`).
- [x] Also update hints printed by `init` and `display.ts`.
- [x] Changelog: renamed commands (0.x), changed exit codes (1.2, 1.5, 0.4, 1.6), follow auto-exit (4.1), alias removal release.

### 5.2 Shared helpers (verified locations)
- [x] `isFile` is duplicated in `init.ts`, `skill.ts`, `watch.ts`, `workspace.ts` and `migrate.ts`. `isDirectory` is in `init.ts`, `skill.ts` and `migrate.ts`. `exists` is only in `init.ts`. Move them into one `fs-utils.ts`.
- [x] `text()` duplicated in `program.ts` and `execute.ts`. `optionalText` only in `program.ts`.
- [x] SIGINT/SIGTERM wiring in `agent.ts` and `watch.ts` (the kernel `execute.ts` has its own and stays).

### Dropped from the first draft
- Global `preAction` workspace hook: `init`, `service` and `workspace register --path` do not use `findWorkspace` the same way.
- Splitting `program.ts` option tables and `config.ts` (pure refactor, no user effect). Do it only if a later change needs it, and do it first then.
- Human summary and TTY-based output for `start`/`continue`; a kernel `onSessionCreated` hook; extra progress lines; `--json` on `config show`, `workspace register/remove`; renaming `--model-name`; positional prompt for `agent`.
- Merges of `skill install/update`, and bare `service` as status.

---

## Verification checklist (every phase)
- [x] `npm test` passes for `packages/cli` (and `packages/kernel` if touched).
- [x] Old invocations still work through aliases with their old exit codes and stdout.
- [x] stdout of `start`, `continue`, `service start`, `workspace register|remove`, `sessions --json` is byte-compatible with the current tests.
- [x] Manual smoke test: `init` (TTY, non-TTY, `--no-input`), `start` with and without `--once`, `continue --once`, `sessions S --follow`, `agent`, `service`, each deprecated alias.
