# @nodeint/migent-contracts

> For installation and usage, see [the Migent CLI on npm](https://www.npmjs.com/package/@nodeint/migent).

Public data contracts for Migent as [TypeBox](https://github.com/sinclairzx81/typebox) schemas with
derived TypeScript types: every `--json` / `-o json` payload, config and workflow file structure,
exit codes, and environment variables.

## Rules

- This is the only stable API. Additive changes ship in minor releases; a breaking wire change needs a
  major release.
- Leaf package: the only runtime dependency is `typebox`. Import no other Migent package.
- Output objects stay open; consumers ignore unknown fields. Workflow input objects are closed; config is
  closed only where the schema says so. Structure only; semantic rules stay in the kernel.
- `session metrics` and `session follow --json` records are passthrough ("any JSON object"); `KNOWN_SHAPES`
  is opt-in description, never a guarantee.
- Every Migent environment variable is listed in `ENV_CATALOG`.
- After changing a schema, `ENV_CATALOG`, `EXIT_CATALOG`, or `SESSION_STATUS_CATALOG`, run `pnpm generate` and commit `schemas/` and
  `docs/reference/`. Do not edit either by hand; a test fails when they are stale. Each `$id` is the raw
  GitHub URL on `main`, so a new schema resolves there only after a release.

## Key symbols

| Symbol | File | Purpose |
|---|---|---|
| `CLI_CONTRACTS` | `src/cli-output.ts` | Schema per CLI JSON payload |
| `ConfigLayer`, `EffectiveConfig` | `src/config.ts` | One config file; merged config |
| `WorkflowDocumentInput` | `src/workflow.ts` | Authored workflow at current `schema_version` |
| `EXIT_CATALOG` | `src/exits.ts` | Exit codes per command family; CLI help is built from it |
| `SESSION_STATUS_CATALOG`, `SessionStatusEntry` | `src/session-status.ts` | One row per session status: kind, precedence, exit, flags, resolution |
| `ENV_CATALOG` | `src/env.ts` | `MIGENT_DEBUG`, `MIGENT_NO_INPUT`, `MIGENT_HOME`, `DISABLE_TELEMETRY` |
| `KNOWN_SHAPES` | `src/known-shapes.ts` | Opt-in shapes for passthrough files |
| `isValid`, `validationIssues` | `src/validate.ts` | Validate a value against a schema |
| `pnpm generate` | `src/generate/` | Writes `schemas/` and `docs/reference/` |
