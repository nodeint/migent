# @nodeint/migent-engine

> For installation and usage, see [the Migent CLI on npm](https://www.npmjs.com/package/@nodeint/migent).

Workflow execution for Migent: stage dispatch, agent runs, verification, and views. Depends on the kernel
and session. Internal; no stable public API.

## Rules

- Session file formats belong to `@nodeint/migent-session`; use its store, event, and fold functions, and
  write any session file with the kernel's atomic writers.
- Exit codes come from `EXECUTE_EXIT_CODES` / contracts `EXIT_CATALOG`.

## Key symbols

| Symbol | File | Purpose |
|---|---|---|
| `executeNamedWorkflow`, `DEFAULT_MAX_DISPATCHES` | `src/execute.ts` | Run a workflow |
| `dispatchNamedStage`, `resolveResumeExecution` | `src/dispatch.ts` | Dispatch one stage |
| `AgentToolRunner` | `src/agent-runner.ts` | Run an agent turn |
| `classifyProviderError`, `ProviderEventReporter` | `src/provider-events.ts` | Provider events |
| `getWorkflowView`, `getConfigView` | `src/views.ts` | Read-only views |
| `evaluateRunWhen`, `runVerifyOnlyStage` | `src/run-when.ts`, `src/verify-only.ts` | `run_when` conditions, verify-only stages |
