# @nodeint/migent-engine

> For installation and usage, see [the Migent CLI on npm](https://www.npmjs.com/package/@nodeint/migent).

Workflow execution for Migent: stage dispatch, agent runs, verification, and views. Depends on the kernel
and session. Internal; no stable public API.

## Rules

- Session file formats belong to `@nodeint/migent-session`; use its store, event, and fold functions, and
  write any session file with the kernel's atomic writers.
- Core-only: `runExecuteLoop`, `AgentToolRunner`, the operation runtime, and the execution layer stay internal.
  The runtime never imports `src/execution/`; only `ExecutionApplier` writes execution state.
  See [docs/architecture.md](../../docs/architecture.md).
- Exit codes come from `EXECUTE_EXIT_CODES` / contracts `EXIT_CATALOG`.

## Execution boundary

- Handlers propose changes; `ExecutionApplier` alone commits them, synchronously and in list order.
  `agent.turn` gates a fresh reply itself; `reply.gate` gates a saved reply on resume.
- The session lock and the global cancellation request belong to the session layer
  (persisted lifecycle: [Sessions](../../docs/sessions.md)). A handler observes cancellation only in the provider or
  the verify runner, commits the cancelled writes through the applier, and rethrows.
- A process death in the middle of a commit is not recovered. That limit is unchanged from before the runtime, and
  its recovery is deferred.
- With `MIGENT_DEBUG` set, each runtime decision goes to the execution's `debug.log` and stderr.

## Key symbols

| Symbol | File | Purpose |
| --- | --- | --- |
| `executeNamedWorkflow`, `DEFAULT_MAX_DISPATCHES` | `src/execute.ts` | Run a workflow |
| `dispatchNamedStage`, `resolveResumeExecution` | `src/dispatch.ts` | Dispatch one stage |
| `AgentToolRunner` | `src/agent-runner.ts` | Run an agent turn |
| `OperationRuntime` | `src/runtime/operation-runtime.ts` | Generic operation cycle |
| `runRoleExecution`, `roleDefinition`, `verifyOnlyDefinition`, `ExecutionApplier` | `src/execution/` | Role and verify-only executions on the runtime; the applier is the single writer |
| `targetFromAgent`, `bindTarget`, `invokeOnce` | `src/agent-invocation.ts` | Resolve a live agent, bind a target to its client, run one provider turn with no stage (no production caller yet) |
| `HostInterceptorChain` | `src/plugin-host/interception.ts` | Adapt registered interceptors into the runtime's `InterceptorChain`, in frozen chain order; failures follow `on_error` |
| `PluginHost` | `src/plugin-host/dispatch.ts` | Run plugin hooks for one run: triggers, deadline, activation, proposal application, failure policy |
| `classifyProviderError`, `ProviderEventReporter` | `src/provider-events.ts` | Provider events |
| `getWorkflowView`, `getConfigView` | `src/views.ts` | Read-only views |
| `evaluateRunWhen`, `runVerifyOnlyStage` | `src/run-when.ts`, `src/verify-only.ts` | `run_when` conditions, verify-only stages |
