import type { TSchema } from 'typebox';

import * as O from './cli-output.js';
import { LegacyLifecycleEvent, LifecycleEventV2, ProviderStreamRecord, SealedMetricsCurrent, SealedMetricsHistorical } from './known-shapes.js';

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

const e = (key: string, schema: TSchema, cls: ContractClass, framing: Framing, commands: string[]): ContractEntry =>
  ({ key, schema, class: cls, framing, commands });

export const CLI_CONTRACTS: readonly ContractEntry[] = [
  e('config', O.ConfigSummary, 'produced', 'document', ['config --json']),
  e('authoring', O.AuthoringEnvelope, 'produced', 'document', ['config|workflow validate|render|save --json']),
  e('doctor', O.DoctorReport, 'produced', 'document', ['doctor --json', 'doctor --session --json']),
  e('get-workflow-summary-list', O.GetWorkflowSummaryList, 'produced', 'document', ['get workflows -o json']),
  e('get-workflow', O.GetWorkflow, 'produced', 'document', ['get workflow <name> -o json']),
  e('get-role-list', O.GetRoleList, 'produced', 'document', ['get roles -o json']),
  e('get-role', O.GetRole, 'produced', 'document', ['get role <name> -o json']),
  e('get-agent-list', O.GetAgentList, 'produced', 'document', ['get agents -o json']),
  e('get-agent', O.GetAgent, 'produced', 'document', ['get agent <name> -o json']),
  e('get-config', O.GetConfig, 'produced', 'document', ['get config -o json']),
  e('get-client-list', O.GetClientList, 'produced', 'document', ['get clients -o json']),
  e('get-client', O.GetClient, 'produced', 'document', ['get client <name> -o json']),
  e('get-model-list', O.GetModelList, 'produced', 'document', ['get models -o json']),
  e('get-model', O.GetModel, 'produced', 'document', ['get model <name> -o json']),
  e('get-option-list', O.GetOptionList, 'produced', 'document', ['get options -o json']),
  e('get-option', O.GetOption, 'produced', 'document', ['get option <name> -o json']),
  e('get-native-option-list', O.GetNativeOptionList, 'produced', 'document', ['get options --native -o json']),
  e('get-native-option', O.GetNativeOption, 'produced', 'document', ['get option <name> --native -o json']),
  e('get-effort-list', O.GetEffortList, 'produced', 'document', ['get efforts -o json']),
  e('get-effort', O.GetEffort, 'produced', 'document', ['get effort <name> -o json']),
  e('session-rows', O.SessionRows, 'produced', 'document', ['session list --json']),
  e('session-latest-row', O.SessionRow, 'produced', 'document', ['session list --latest --json']),
  e('session-latest-none', O.SessionNone, 'produced', 'document', ['session list --latest --json']),
  e('session-snapshot', O.SessionSnapshot, 'produced', 'document', ['session show --json']),
  e('session-snapshot-line', O.SessionSnapshotLine, 'produced', 'json-lines', ['session follow --json']),
  e('session-follow-record', O.SessionFollowRecord, 'passthrough', 'json-lines', ['session follow --json']),
  e('session-metrics', O.SealedMetrics, 'passthrough', 'document', ['session metrics <id> --json']),
  e('session-metrics-line', O.SealedMetricsLine, 'passthrough', 'json-lines', ['session metrics --json']),
  e('cancel', O.CancelResult, 'produced', 'document', ['session cancel --json']),
  e('complete', O.CompleteResult, 'produced', 'document', ['session complete --json']),
  e('rename', O.RenameResult, 'produced', 'document', ['session rename --json']),
  e('role-run', O.RoleRunResult, 'produced', 'document', ['session run --role --json']),
  e('role-run-many', O.RoleRunResults, 'produced', 'document', ['session run --role --json (resumed cancelled executions)']),
  e('prepare', O.PrepareResult, 'produced', 'document', ['session prepare']),
  e('repair', O.RepairResult, 'produced', 'document', ['session repair']),
  e('service-running', O.ServiceRunning, 'produced', 'document', ['service status --json']),
  e('service-stopped', O.ServiceStopped, 'produced', 'document', ['service status --json']),
  e('workspace-list', O.WorkspaceList, 'produced', 'document', ['workspace list --json']),
  e('workspace-mutation', O.WorkspaceMutation, 'produced', 'document', ['workspace register', 'workspace remove']),
  e('update', O.UpdateCheck, 'produced', 'document', ['update --json']),
];

/** Opt-in descriptions of persisted files; never referenced by a command contract. */
export const KNOWN_SHAPES: readonly TSchema[] = [
  LifecycleEventV2,
  LegacyLifecycleEvent,
  ProviderStreamRecord,
  SealedMetricsHistorical,
  SealedMetricsCurrent,
];
