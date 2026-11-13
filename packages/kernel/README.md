# @nodeint/migent-kernel

> For installation and usage, see [the Migent CLI on npm](https://www.npmjs.com/package/@nodeint/migent).

Configuration, authoring, migration, outputs, selection, and process execution for Migent. Sessions are in
`@nodeint/migent-session`, execution in `@nodeint/migent-engine`. Internal; no stable public API.

## Rules

- Read `process.env` only in `src/env.ts` (a test enforces this); add each new variable to `ENV_CATALOG`
  in contracts.
- Process and lock code uses Node built-ins and `proper-lockfile` only: no native dependencies or libc calls.
- Liveness comes from connecting to a local endpoint (Unix socket / named pipe), never from pids. Keep socket
  paths under 100 bytes.
- Children that must not outlive the parent get an `ipc` stdio slot and act on `disconnect`.
- Stop process trees with `killProcessTree`: POSIX spawns with `detached: true`; Windows keeps
  `detached: false`.
- The process wrapper re-executes its own module (`import.meta.url`); do not bundle packages.
- Write persisted files through `src/atomic-file.ts`; lock with `withFileLockSync` (`<path>.lock` dirs).

## Key symbols

| Symbol | File | Purpose |
|---|---|---|
| `CliClient`, `CommandSpec` types | `src/cli-client.ts` | Client adapter contract |
| `loadAgentTarget`, `configPath`, `LOCAL_CONFIG_FILE` | `src/config.ts` | Config resolution |
| `migrateConfig`, `migrateWorkflow` | `src/migration.ts` | Schema migration |
| authoring exports, `buildDraftSourceMap` | `src/authoring.ts`, `src/draft-source.ts` | Draft validate/render/save |
| `schedulableStageIds`, `NextStageResult` | `src/selection.ts` | Next-stage selection |
| `parseStageOutcome`, `resolveStageOutcome` | `src/stage-outcome.ts`, `src/outcome-resolver.ts` | Stage outcome |
| `selectResumePolicy`, `validateResumePolicies`, `evaluateResume`, `effectiveOnExpired` | `src/resume-policy.ts` | Resume policies: select, validate, and decide whether a resume is expired |
| `pendingResumeStops`, `stageStopFacts` | `src/resume-stops.ts` | Pending `expired` stops projected from events |
| `endsScheduling`, `stageStopStatus`, `stopResolved`, `exitFor`, `acceptsBlockedResume` | `src/session-status-policy.ts` | Session-status rules derived from `SESSION_STATUS_CATALOG` |
| `decideCorrection`, `CORRECTION_POLICY` | `src/correction-policy.ts` | Correction turns |
| `VerifyRunner` | `src/verify-runner.ts` | Verification commands |
| `killProcessTree`, `wrapperEndpoint` | `src/process-wrapper.ts` | Process wrapper |
| `interruptSession` | `src/provider-interrupt.ts` | Interrupt a provider |
| `writeFileAtomic`, `withFileLockSync` | `src/atomic-file.ts`, `src/file-lock.ts` | Durable writes, locks |
| `debugEnabled`, `migentHomeOverride`, `inheritedEnv` | `src/env.ts` | Environment access |
