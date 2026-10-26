# Plan: improve `migent init` first-run experience

Status: Phases A, B, and C are implemented. The kernel config-edit helpers
(`config-edit.ts`) were kept because migration still uses them.

## Goal

Make `migent init` leave a project configured for the current machine and give
the user a clear, reliable next step. Keep shared workflow intent separate
from machine-specific provider and model choices. Keep configuration editing
simple: users or their agents edit YAML; Migent prints and validates it.

## Current state (verified against the code)

Already in place; do not redo:

- Kernel merges `.migent/config.local.yaml` over `config.yaml`
  (`packages/kernel/src/config.ts`: `LOCAL_CONFIG_FILE`, `hasLocalConfig`,
  merged load).
- `init` already writes `.migent/.gitignore` with `sessions/` and
  `config.local.yaml` (`init.ts` `writeProject`).
- `migent config` and `migent config show` already run the same
  `runConfigShow`, which prints the merged config and notes the merge on
  stderr. There is no `--json`.
- This repo's own `.migent/config.yaml` already uses empty capability aliases
  (`fast`, `general`, `deep_reasoning`, `code_generation`, `critical_review`,
  `long_context`) mapped per machine in `config.local.yaml`.

Still to change:

- `init` writes the provider/model into `config.yaml` under a single alias
  `default` (`renderConfig`) and never creates `config.local.yaml`.
- `classify` ignores `config.local.yaml`, so a stray local file is not seen as
  partial state.
- `init` prints a placeholder command (`--task "..."`), and does not report
  doctor results in a next-step form.
- `config model` and `config role` still exist (`program.ts`, `config.ts`).
- Docs and skill still describe `config model`/`config role` and the old
  generated tree.

## Decisions

- `config.yaml` holds workflow roles and stable model aliases with empty
  entries (`alias: {}`), never provider model IDs.
- `config.local.yaml` holds this machine's alias-to-provider/model mappings
  and options. `init` creates it; `.migent/.gitignore` already excludes it.
- Aliases are the existing capability names, not role names. The preset
  decides which are generated, and only those:
  - `implement`: role `developer` -> `code_generation`.
  - `plan`: role `planner` -> `deep_reasoning`, role `reviewer` ->
    `critical_review`. Both aliases map to the selected model initially so they
    can be changed independently later.
- `migent config` stays as the single read-only command. It prints the
  effective (merged) config, labels what comes from `config.local.yaml`, and
  gains `--json`. Remove `config show`, `config model`, and `config role`.
- Removed subcommands are not silent: they stay registered as hidden stubs
  that exit 2 and print the replacement ("edit .migent/config.yaml or
  .migent/config.local.yaml, then run `migent doctor`"). This is better than
  Commander's generic "unknown command".
- Users edit YAML directly or ask an agent to edit it, then run `migent doctor`.
- `init` never invokes a model. Starting a workflow is a separate, explicit
  command that init only prints.
- Existing `--provider`, `--model`, `--option`, `--preset`, `--skill`, and
  `--no-input` flags keep their meaning. `--option` values now go to
  `config.local.yaml` under the mapped alias(es).

## Flow

1. Inspect `.migent/` before prompting, including `config.local.yaml`.
   - New project: continue setup.
   - Valid project: report ready, show the next command. Unchanged.
   - Partial or conflicting (including a lone `config.local.yaml`): list the
     files and give a recovery instruction without overwriting anything.
2. Detect provider CLIs and model catalogs via the existing provider helpers
   (`detected`, `loadCatalog`). Report a missing CLI, catalog, or authentication
   prerequisite with the fix. Catalog listing may run the provider CLI's list
   command, but init makes no inference call as a health check.
3. Let the user choose `implement` or `plan`.
4. Offer to install the Migent skill for the detected client. Declining does not stop init. As before, when the user asked for the install
   (`--skill` or a yes) and `npx skills` fails, init stops before writing
   anything and reports the error; this behavior is unchanged and covered by
   an existing test.
5. Write shared config and workflow, `config.local.yaml`, and gitignore.
6. Run doctor. Explain each remaining problem and its remedy.
7. Print the selected provider/model/workflow and a complete first-run
   command, e.g. `migent session run --workflow plan --task "<describe the
   task>"` rendered with the real workflow id. The command must run as printed
   once the user replaces the task text; it contains no unexplained
   placeholder.

Out of scope for this change (possible phase 2): prompting for a task at the
end of init and offering to start the workflow. It adds TTY handling and a new
test surface without being needed for a correct first run.

The non-interactive path stays explicit:

```bash
migent init --provider codex --model gpt-5 --preset implement --no-input
```

Missing required flags produce an actionable error and another complete
example (extends the current "Pass --provider and --model" messages).

## Implementation phases

Ship as three commits or PRs; each leaves tests green.

### Phase A: split configuration in init

1. `packages/cli/src/commands/init.ts`
   - `renderConfig`: emit alias entries as `{}` using the preset's aliases;
     roles point at them via `default_model`. Update the header comment.
   - New `renderLocalConfig`: `models.<alias>.provider/model/options` for each
     generated alias, using `yamlScalar` as today.
   - `writeProject`: also write `.migent/config.local.yaml`; return it in the
     created paths.
   - `classify`: include `.migent/config.local.yaml` in `owned`. Preserve the
     no-overwrite rule for partial projects.
2. Confirm the generated pair passes `diagnose` (config + workflows checks).
3. Tests in `packages/cli/test/init.test.ts`: both files written with the
   right content per preset, shared file contains no provider/model, gitignore
   covers the local file, partial project with only a local file is a
   conflict, `--option` lands in the local file.

### Phase B: output, doctor guidance, config surface

4. `init.ts`, `display.ts`, `program.ts`: actionable provider setup errors,
   skill-offer fallback messaging, doctor summary, final concrete command.
   Update `init`'s description string in `program.ts`.
5. Doctor (kernel `diagnose` / config check): when an alias used by a role is
   an empty entry and no local mapping exists, report which alias is unmapped
   and print a YAML snippet for `.migent/config.local.yaml`. This is the
   message a fresh clone sees. Add kernel and CLI doctor tests, including
   "alias `{}` in shared config, no local file".
6. `program.ts`, `commands/config.ts`:
   - Keep `migent config` with `--json`; mark local-sourced entries in the
     text output (comment or a stderr summary of which aliases the local file
     overrides) instead of only "Merged with ...".
   - Replace `show`, `model`, `role` with hidden stubs that print the
     replacement and exit 2. Delete the interactive editors and the
     `ConfigPrompter` code they alone use.
   - Before deleting kernel editing helpers (`patchConfigText`, `upsertModel`,
     `assignRoles`, `placeRoleModel`, `setRoleOptions`, `describeChange`, ...),
     grep for other users; remove only the ones left unused, with their tests.
7. Tests: `packages/cli/test/config.test.ts` covers read-only config, `--json`,
   and the stub messages; init output test checks the printed command is
   complete; a test that init performs no provider command beyond catalog
   listing (fake `runCommand` records calls).

### Phase C: skill, docs, changelog

8. `skills/migent/SKILL.md`, `skills/migent/references/config.md`,
   `skills/migent/references/schema-config.yaml`: remove `config model` and
   `config role`; teach the agent to inspect `migent config`, edit YAML using
   capability aliases and the local mapping, then run `migent doctor`.
9. `.agents/skills/migent/`: update from the bundled source. If no check
   exists, add a test that fails when the two copies differ (or a sync script
   referenced in CONTRIBUTING.md) so drift is detected.
10. `README.md`, `docs/cli.md`, `docs/providers.md`, `docs/sessions.md`, and
    any other page mentioning init/config: fix the generated-file tree, remove
    config-editing examples, describe the local file and clone setup.
11. `CHANGELOG.md` Unreleased: split config in init, read-only `config`,
    removed subcommands with the replacement. Note the breaking change and the
    version impact (pre-1.0, so a minor bump is acceptable; state the choice).

## Acceptance criteria

Each is checkable by a test or a command:

- Fresh `init` (each preset) writes `config.yaml` with only empty aliases and
  `config.local.yaml` with the selected provider/model; `migent doctor` exits 0
  with a fake provider on PATH.
- `git check-ignore .migent/config.local.yaml` succeeds in an initialized repo.
- Copying `config.yaml` and `workflows/` without the local file makes
  `migent doctor` fail naming each unmapped alias and showing a snippet; adding
  a different provider/model mapping makes it pass.
- The final init output contains a command that parses as a valid
  `migent session run --workflow <id> --task ...` invocation for the chosen
  preset.
- `migent config` prints the effective config and `--json` returns one object;
  `config show|model|role` exit 2 with the replacement message.
- A test or script confirms `skills/migent/` and `.agents/skills/migent/` match.
- A grep test (or CI step) finds no `config model` / `config role` in README,
  `docs/`, `skills/`, `.agents/`, or CLI help text.
- Init makes no provider call other than catalog listing.

## Risks and compatibility

- Removing config editing subcommands is a CLI breaking change, including their
  `--json` output for scripts. Mitigated by stub messages and a changelog entry.
- Existing projects may keep model bindings only in `config.yaml`. They stay
  valid and printable; `init` does not rewrite or migrate them, and
  `init` on a valid project still only reports ready.
- The local config is machine-specific. A clone without it gets the doctor
  message from step 5.
- Changing the generated alias from `default` to capability names affects only
  newly initialized projects. Docs and skill examples that mention `default`
  must be updated in Phase C.
- Provider catalog listing can be slow or need auth; failures must degrade to
  the actionable error, not a stack trace.
