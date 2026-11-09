# @nodeint/migent-contracts

Public data contracts for Migent, as [TypeBox](https://github.com/sinclairzx81/typebox) schemas
(plain JSON Schema) with derived TypeScript types.

This release covers every `migent … --json` / `-o json` stdout payload (`CLI_CONTRACTS`) and the
structure of `.migent/config.yaml` / `config.local.yaml`: `ConfigLayer` describes one file (named
agents may be partial, because layers merge) and `EffectiveConfig` describes the merged result
(`roles` required, named agents complete or an empty placeholder). The config schemas are input
contracts and are not part of `CLI_CONTRACTS`. They validate structure only; error codes, semantic
rules (client registry, effort, model availability) stay in `@nodeint/migent-kernel`.
Workflow and environment contracts follow in later releases.

- **Leaf package.** Its only runtime dependency is `typebox`. It imports no other Migent package.
- **Open objects.** Consumers must ignore unknown fields. Adding a field is not a breaking change.
- **Produced vs. passthrough.** Most contracts describe what the CLI builds. `session metrics`
  and the record lines of `session follow --json` re-emit files written by any past Migent version,
  so their contract is exactly "any JSON object". `KNOWN_SHAPES` holds opt-in descriptions of what
  those files may contain; they are never the command's guarantee.
- **Validation.** `isValid(schema, value)` and `validationIssues(schema, value)`.

The stability promise for this package is documented in [CONTRIBUTING.md](../../CONTRIBUTING.md).
