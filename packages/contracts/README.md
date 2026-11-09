# @nodeint/migent-contracts

Public data contracts for Migent, as [TypeBox](https://github.com/sinclairzx81/typebox) schemas
(plain JSON Schema) with derived TypeScript types.

This release covers every `migent … --json` / `-o json` stdout payload (`CLI_CONTRACTS`) and the
structure of `.migent/config.yaml` / `config.local.yaml`: `ConfigLayer` describes one file (named
agents may be partial, because layers merge) and `EffectiveConfig` describes the merged result
(`roles` required, named agents complete or an empty placeholder). The config schemas are input
contracts and are not part of `CLI_CONTRACTS`. They validate structure only; error codes, semantic
rules (client registry, effort, model availability) stay in `@nodeint/migent-kernel`.
The environment catalog (`ENV_CATALOG`) describes `MIGENT_DEBUG`, `MIGENT_NO_INPUT`, `MIGENT_HOME`, and
`DISABLE_TELEMETRY`; only those four are a contract. `WorkflowDocumentInput` describes an authored
workflow file at the current `schema_version`. `EXIT_CATALOG` describes every exit code per command family.

- **Input vs. output contracts.** Config and workflow contracts are input contracts. Workflow objects are
  closed: an unknown key is an error. Config is closed only where the schema says so (`ClientSelection`,
  `AgentPlaceholder`); `ConfigLayer`, `InlineAgent`, and the other config objects accept unknown keys, and
  the kernel rejects the ones it does not know. Output contracts stay open.
- **Schema files.** `pnpm generate` writes one JSON Schema file per `$id` to `schemas/<id path>.json`
  (shipped in this package, importable as `@nodeint/migent-contracts/schemas/…`). `$id` is the raw GitHub URL
  of that file on `main`. Nested identified schemas are `$ref`s to their own files, so the files are not
  self-contained: load the directory, or resolve `$ref` by `$id`. A schema added on `next` is not served at
  its URL until a release moves `main`; the npm copy has no such gap.
- **Reference tables.** The same command writes [`docs/reference/`](../../docs/reference/).

- **Leaf package.** Its only runtime dependency is `typebox`. It imports no other Migent package.
- **Open objects.** Consumers must ignore unknown fields. Adding a field is not a breaking change.
- **Produced vs. passthrough.** Most contracts describe what the CLI builds. `session metrics`
  and the record lines of `session follow --json` re-emit files written by any past Migent version,
  so their contract is exactly "any JSON object". `KNOWN_SHAPES` holds opt-in descriptions of what
  those files may contain; they are never the command's guarantee.
- **Validation.** `isValid(schema, value)` and `validationIssues(schema, value)`.

The stability promise for this package is documented in [CONTRIBUTING.md](../../CONTRIBUTING.md).
