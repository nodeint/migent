# @nodeint/migent-doctor

> For installation and usage, see [the Migent CLI on npm](https://www.npmjs.com/package/@nodeint/migent).

Health checks and diagnostics for Migent: config, workflows, clients, sessions, and model availability.
Internal; no stable public API.

## Rules

- Checks report diagnostics; they never modify config, workflows, or sessions.
- Never call a real client CLI from tests; inject `which` and `runCommand`.

## Key symbols

| Symbol | File | Purpose |
|---|---|---|
| `diagnose` | `src/diagnose.ts` | `migent doctor` entry |
| `Diagnostic`, `DiagnosticList` | `src/check.ts` | Diagnostic model |
| `validateConfigDraft`, `validateWorkflowDraft` | `src/authoring.ts` | Draft validation |
| `analyzeConfig`, `validateConfigLayers` | `src/config-check.ts` | Config checks |
| `diagnoseSession` | `src/session.ts` | Session checks |
| `checkModels`, `checkModelEfforts` | `src/model-check.ts`, `src/effort-check.ts` | Model and effort availability |
