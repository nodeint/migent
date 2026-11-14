import type { TSchema } from 'typebox';

import * as O from './cli-output.js';
import { LegacyLifecycleEvent, LifecycleEventV2, ProviderStreamRecord, ResumeDecidedData, ResumeExpiredData, SealedMetricsCurrent, SealedMetricsHistorical } from './known-shapes.js';
import { SESSION_EVENT_SCHEMAS, SessionEvent } from './session-events.js';
import { ExecutionQuestions, SessionDiagnostics, SessionExecution, SessionLockFile, SessionManifest, SessionNext, SessionQuestions, SessionStatusFile } from './session-files.js';

export type Framing = 'document' | 'json-lines';
export type ContractClass = 'produced' | 'passthrough';

export interface ContractEntry {
  /** Stable key, used by the coverage guard. */
  key: string;
  schema: TSchema;
  class: ContractClass;
  framing: Framing;
  /** Commands that emit it. */
  commands: readonly string[];
}

interface EntryShape {
  class: ContractClass;
  framing: Framing;
  commands: string[];
}

const e = (key: string, schema: TSchema, shape: EntryShape): ContractEntry =>
  ({ key, schema, class: shape.class, framing: shape.framing, commands: shape.commands });

export const CLI_CONTRACTS: readonly ContractEntry[] = [
  e('config', O.ConfigSummary, { class: 'produced', framing: 'document', commands: ['config --json'] }),
  e('authoring', O.AuthoringEnvelope, { class: 'produced', framing: 'document', commands: ['config|workflow validate|render|save --json'] }),
  e('doctor', O.DoctorReport, { class: 'produced', framing: 'document', commands: ['doctor --json', 'doctor --session --json'] }),
  e('get-workflow-summary-list', O.GetWorkflowSummaryList, { class: 'produced', framing: 'document', commands: ['get workflows -o json'] }),
  e('get-workflow', O.GetWorkflow, { class: 'produced', framing: 'document', commands: ['get workflow <name> -o json'] }),
  e('get-role-list', O.GetRoleList, { class: 'produced', framing: 'document', commands: ['get roles -o json'] }),
  e('get-role', O.GetRole, { class: 'produced', framing: 'document', commands: ['get role <name> -o json'] }),
  e('get-agent-list', O.GetAgentList, { class: 'produced', framing: 'document', commands: ['get agents -o json'] }),
  e('get-agent', O.GetAgent, { class: 'produced', framing: 'document', commands: ['get agent <name> -o json'] }),
  e('get-config', O.GetConfig, { class: 'produced', framing: 'document', commands: ['get config -o json'] }),
  e('get-client-list', O.GetClientList, { class: 'produced', framing: 'document', commands: ['get clients -o json'] }),
  e('get-client', O.GetClient, { class: 'produced', framing: 'document', commands: ['get client <name> -o json'] }),
  e('get-model-list', O.GetModelList, { class: 'produced', framing: 'document', commands: ['get models -o json'] }),
  e('get-model', O.GetModel, { class: 'produced', framing: 'document', commands: ['get model <name> -o json'] }),
  e('get-option-list', O.GetOptionList, { class: 'produced', framing: 'document', commands: ['get options -o json'] }),
  e('get-option', O.GetOption, { class: 'produced', framing: 'document', commands: ['get option <name> -o json'] }),
  e('get-native-option-list', O.GetNativeOptionList, { class: 'produced', framing: 'document', commands: ['get options --native -o json'] }),
  e('get-native-option', O.GetNativeOption, { class: 'produced', framing: 'document', commands: ['get option <name> --native -o json'] }),
  e('get-effort-list', O.GetEffortList, { class: 'produced', framing: 'document', commands: ['get efforts -o json'] }),
  e('get-effort', O.GetEffort, { class: 'produced', framing: 'document', commands: ['get effort <name> -o json'] }),
  e('session-rows', O.SessionRows, { class: 'produced', framing: 'document', commands: ['session list --json'] }),
  e('session-latest-row', O.SessionRow, { class: 'produced', framing: 'document', commands: ['session list --latest --json'] }),
  e('session-latest-none', O.SessionNone, { class: 'produced', framing: 'document', commands: ['session list --latest --json'] }),
  e('session-snapshot', O.SessionSnapshot, { class: 'produced', framing: 'document', commands: ['session show --json'] }),
  e('session-snapshot-line', O.SessionSnapshotLine, { class: 'produced', framing: 'json-lines', commands: ['session follow --json'] }),
  e('session-follow-record', O.SessionFollowRecord, { class: 'passthrough', framing: 'json-lines', commands: ['session follow --json'] }),
  e('session-metrics', O.SealedMetrics, { class: 'passthrough', framing: 'document', commands: ['session metrics <id> --json'] }),
  e('session-metrics-line', O.SealedMetricsLine, { class: 'passthrough', framing: 'json-lines', commands: ['session metrics --json'] }),
  e('cancel', O.CancelResult, { class: 'produced', framing: 'document', commands: ['session cancel --json'] }),
  e('delete', O.DeleteResult, { class: 'produced', framing: 'document', commands: ['session delete --json'] }),
  e('complete', O.CompleteResult, { class: 'produced', framing: 'document', commands: ['session complete --json'] }),
  e('session-resume', O.SessionResumeOutput, { class: 'produced', framing: 'document', commands: ['session resume --json'] }),
  e('rename', O.RenameResult, { class: 'produced', framing: 'document', commands: ['session rename --json'] }),
  e('role-run', O.RoleRunResult, { class: 'produced', framing: 'document', commands: ['session run --role --json'] }),
  e('role-run-many', O.RoleRunResults, { class: 'produced', framing: 'document', commands: ['session run --role --json (resumed cancelled executions)'] }),
  e('prepare', O.PrepareResult, { class: 'produced', framing: 'document', commands: ['session prepare'] }),
  e('repair', O.RepairResult, { class: 'produced', framing: 'document', commands: ['session repair'] }),
  e('service-running', O.ServiceRunning, { class: 'produced', framing: 'document', commands: ['service status --json'] }),
  e('service-stopped', O.ServiceStopped, { class: 'produced', framing: 'document', commands: ['service status --json'] }),
  e('workspace-list', O.WorkspaceList, { class: 'produced', framing: 'document', commands: ['workspace list --json'] }),
  e('workspace-mutation', O.WorkspaceMutation, { class: 'produced', framing: 'document', commands: ['workspace register', 'workspace remove'] }),
  e('update', O.UpdateCheck, { class: 'produced', framing: 'document', commands: ['update --json'] }),
];

/** Opt-in descriptions of persisted files; never referenced by a command contract. */
export const KNOWN_SHAPES: readonly TSchema[] = [
  LifecycleEventV2,
  LegacyLifecycleEvent,
  ProviderStreamRecord,
  ResumeExpiredData,
  ResumeDecidedData,
  SealedMetricsHistorical,
  SealedMetricsCurrent,
];

// ---- persisted session files ------------------------------------------------------------------

/** `guaranteed`: a breaking change needs a major release. `known`: opt-in description, never a guarantee. */
export type StabilityClass = 'guaranteed' | 'known';
export type SessionFileFraming = 'yaml' | 'document' | 'json-lines';

export interface SessionFileEntry {
  /** Stable key, used by the coverage guard. */
  key: string;
  /** Pattern relative to the session directory. */
  path: string;
  schema: TSchema;
  class: StabilityClass;
  framing: SessionFileFraming;
}

interface FileShape {
  schema: TSchema;
  class: StabilityClass;
  framing: SessionFileFraming;
}

const f = (key: string, path: string, shape: FileShape): SessionFileEntry => ({ key, path, ...shape });

export const SESSION_FILES: readonly SessionFileEntry[] = [
  f('manifest', 'manifest.yaml', { schema: SessionManifest, class: 'guaranteed', framing: 'yaml' }),
  f('status', 'status.json', { schema: SessionStatusFile, class: 'known', framing: 'document' }),
  f('lock', 'session.lock', { schema: SessionLockFile, class: 'guaranteed', framing: 'document' }),
  f('execution', 'executions/<id>/execution.json', { schema: SessionExecution, class: 'known', framing: 'document' }),
  f('questions', 'questions.json', { schema: SessionQuestions, class: 'guaranteed', framing: 'document' }),
  f('execution-questions', 'executions/<id>/questions.json', { schema: ExecutionQuestions, class: 'guaranteed', framing: 'document' }),
  f('next', 'next.json', { schema: SessionNext, class: 'guaranteed', framing: 'document' }),
  f('diagnostics', 'executions/<id>/diagnostics.json', { schema: SessionDiagnostics, class: 'known', framing: 'document' }),
  f('events', 'events.jsonl', { schema: SessionEvent, class: 'guaranteed', framing: 'json-lines' }),
];

export interface SessionEventEntry {
  event: string;
  schema: TSchema;
  class: 'known';
}

/** Every event name written to `events.jsonl`, in documentation order. */
export const SESSION_EVENTS: readonly SessionEventEntry[] = SESSION_EVENT_SCHEMAS.map((entry) => ({ ...entry, class: 'known' as const }));

export interface SessionEventTemplate {
  /** Producer source file, relative to the repository root. */
  file: string;
  /** Template head, including the dot. */
  head: string;
  /** The suffix type that the type checker proves is a union of registered names. */
  suffixType: 'SessionStatusName' | 'ExecutionStatus' | 'StageOutcomeStatus';
}

/** Event names built from a template. Each `<head><suffix>` is registered in `SESSION_EVENTS`. */
export const SESSION_EVENT_TEMPLATES: readonly SessionEventTemplate[] = [
  { file: 'packages/session/src/session-store-execution.ts', head: 'execution.', suffixType: 'ExecutionStatus' },
  { file: 'packages/session/src/session-store-execution.ts', head: 'stage.', suffixType: 'StageOutcomeStatus' },
  { file: 'packages/session/src/session-store-execution.ts', head: 'session.', suffixType: 'SessionStatusName' },
  { file: 'packages/session/src/session-repair.ts', head: 'execution.', suffixType: 'ExecutionStatus' },
  { file: 'packages/session/src/session-repair.ts', head: 'session.', suffixType: 'SessionStatusName' },
];

/** Persisted file names that producers write and this change does not describe. */
export const SESSION_FILE_EXCLUSIONS: readonly { name: string; reason: string }[] = [
  { name: 'config.yaml', reason: 'Project config; described by the config contracts.' },
  { name: 'config.local.yaml', reason: 'Local config; described by the config contracts.' },
  { name: 'workflow.yaml', reason: 'Authored workflow; described by the workflow contract.' },
  { name: 'workflow.frozen.yaml', reason: 'Frozen copy of the workflow; not a session contract.' },
  { name: 'title.json', reason: 'Non-goal: session title cache.' },
  { name: 'conversation.json', reason: 'Non-goal: provider conversation history.' },
  { name: 'outcome.json', reason: 'Non-goal: per-turn outcome copy.' },
  { name: 'question-request.json', reason: 'Non-goal: question request inside an execution.' },
  { name: 'session.json', reason: 'Non-goal: not a session file.' },
  { name: 'metrics.json', reason: 'Described by KNOWN_SHAPES (sealed metrics).' },
  { name: 'handoff.json', reason: 'Described by `handoff/document`.' },
  { name: 'stream.jsonl', reason: 'Non-goal: opaque provider stream.' },
  { name: '.last-id.lock', reason: 'Non-goal: internal id allocation lock.' },
  { name: 'cancel.requested', reason: 'Non-goal: cancel marker.' },
];
