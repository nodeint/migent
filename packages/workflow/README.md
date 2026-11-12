# @nodeint/migent-workflow

> For installation and usage, see [the Migent CLI on npm](https://www.npmjs.com/package/@nodeint/migent).

Workflow definition for Migent: document model, strict parser, draft collector, catalog checks, and
loading of `.migent/workflows`. It does not run workflows; that is `@nodeint/migent-engine`.
Behavior: [docs/workflows.md](../../docs/workflows.md).

## Rules

- Depend only on `@nodeint/migent-contracts`, `yaml`, and `zod`.
- Other packages import workflow definitions from here, never from the kernel.
- Draft validation reports every independent problem in one run; a failed field must not hide others.
- `ConfigurationError`, `isRecord`, `documentVersion`, `pyRepr`, and `parseYamlDocument` are shared
  utilities, not workflow API.

## Key symbols

| Symbol | File | Purpose |
|---|---|---|
| `parseWorkflowMapping` | `src/parse.ts` | Strict parse to `WorkflowDocument` |
| `collectWorkflowDraft` | `src/draft/` | Collect all draft problems |
| `loadNamedWorkflow`, `loadWorkflowCatalog`, `loadWorkflowDocument` | `src/load.ts` | Load from `.migent/workflows` |
| `checkWorkflowCatalog` | `src/catalog.ts` | Cross-workflow checks (ids, downstream) |
| `WorkflowDocument`, `StageSpec`, `stageArtifactsFor` | `src/model.ts` | Document model |
| `dependencyClosure`, `routeTargets`, `conditionalReach` | `src/graph.ts` | Stage graph |
| `matchesChangedPaths` | `src/changed-paths.ts` | `changed_paths` conditions |
| `ConfigurationError` | `src/errors.ts` | Error with source position |
