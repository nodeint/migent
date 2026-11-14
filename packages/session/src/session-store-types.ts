import { existsSync } from 'node:fs';
import path from 'node:path';

import type { ExecutionStatus } from '@nodeint/migent-contracts';
import type { StageOutcome } from '@nodeint/migent-kernel';
import { CONVERSATION_FILENAME, LEGACY_CONVERSATION_FILENAME, legacyClientOf } from '@nodeint/migent-kernel';
import { isRecord } from '@nodeint/migent-workflow';

import type { NextSuggestion } from './next-handoff.js';
import { nonempty } from './session-store-util.js';

export function stringOptions(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const options: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') options[key] = item;
  }
  return options;
}

export interface SessionRecordInit {
  client: string;
  model: string;
  workspace: string;
  agentId?: string | null;
  options?: Record<string, string>;
  status?: string;
  history?: Record<string, string>[];
}

/** The identity a stored conversation falls back to for fields it does not record. */
export type SessionRecordFallback = Pick<SessionRecordInit, 'client' | 'model' | 'workspace'>;

/** The human input an attempt opens with. It is recorded in `input.json`; synthetic text is never one. */
export interface HumanInput {
  kind: 'reply' | 'answers';
  /** The text the agent received. */
  sent: string;
  /** The raw text the human typed. */
  input: string;
  /** Structured answers, for `answers` only. */
  answers?: Record<string, unknown>[];
  respondsToExecutionId: string;
}

/** The facts that start an execution. */
export interface ExecutionStartInput {
  client: string;
  model: string;
  options: Record<string, string> | null;
  sessionId: string | null;
  stageId: string;
  stageAttempt: number | null;
  executionOrder: number | null;
  prompt: string;
  resumesExecutionId?: string | null;
  kind?: 'verify' | null;
  humanInput?: HumanInput | null;
}

/** An execution to load or create, with the conversation it may resume. */
export interface LoadOrCreateInput extends Omit<ExecutionStartInput, 'resumesExecutionId' | 'kind'> {
  workspace: string;
  resumeExecutionId?: string | null;
  /** `session resume`: start this execution although another stage's cancel holds the session at `cancelled`. */
  allowCancelledSibling?: boolean;
  validateResume?: (record: AgentSessionRecord) => void;
}

/** How an execution ended, or its progress. */
export interface ExecutionSaveInput {
  status: ExecutionStatus;
  error?: string | null;
  outcome?: StageOutcome | null;
  /** True when the caller already holds the execution lock. */
  locked?: boolean;
  extra?: Record<string, unknown> | null;
}

export class AgentSessionRecord {
  public client: string;
  public model: string;
  public workspace: string;
  public agentId: string | null;
  public options: Record<string, string>;
  public status: string;
  public history: Record<string, string>[];

  constructor(init: SessionRecordInit) {
    this.client = init.client;
    this.model = init.model;
    this.workspace = init.workspace;
    this.agentId = init.agentId ?? null;
    this.options = { ...(init.options ?? {}) };
    this.status = init.status ?? 'new';
    this.history = init.history ?? [];
  }

  public static fromJson(raw: unknown, fallback: SessionRecordFallback): AgentSessionRecord {
    const { client, model, workspace } = fallback;
    if (Array.isArray(raw)) {
      return new AgentSessionRecord({ client, model, workspace, status: 'new', history: raw as Record<string, string>[] });
    }
    if (!isRecord(raw)) return new AgentSessionRecord({ client, model, workspace });
    const history = Array.isArray(raw.history) ? (raw.history as Record<string, string>[]) : [];
    return new AgentSessionRecord({
      client: nonempty(raw.client) ?? legacyClientOf(nonempty(raw.provider)) ?? client,
      model: nonempty(raw.model) ?? model,
      workspace: nonempty(raw.workspace) ?? workspace,
      agentId: nonempty(raw.agent_id) ?? nonempty(raw.native_session_id),
      options: stringOptions(raw.options),
      status: nonempty(raw.status) ?? 'unknown',
      history,
    });
  }

  public toJson(): Record<string, unknown> {
    return {
      client: this.client,
      model: this.model,
      workspace: this.workspace,
      agent_id: this.agentId,
      options: { ...this.options },
      status: this.status,
      history: this.history,
    };
  }
}

export class ExecutionContext {
  constructor(
    public readonly sessionId: string,
    public readonly executionId: string,
    public readonly directory: string,
  ) {}

  public get conversationPath(): string {
    return path.join(this.directory, CONVERSATION_FILENAME);
  }

  public get conversationReadPath(): string {
    if (existsSync(this.conversationPath)) return this.conversationPath;
    return path.join(this.directory, LEGACY_CONVERSATION_FILENAME);
  }

  public get artifactDirectory(): string {
    return path.join(this.directory, 'artifacts');
  }
}

// loadOrCreate builds its own SessionStore, so the execute loop's instance cannot see this set.
const inFlightBySession = new Map<string, Set<string>>();

export function inFlightExecutions(sessionId: string): ReadonlySet<string> | undefined {
  return inFlightBySession.get(sessionId);
}

export function noteInFlightExecution(sessionId: string, executionId: string): void {
  let ids = inFlightBySession.get(sessionId);
  if (ids === undefined) {
    ids = new Set();
    inFlightBySession.set(sessionId, ids);
  }
  ids.add(executionId);
}

export function clearInFlightExecution(sessionId: string, executionId: string): void {
  const ids = inFlightBySession.get(sessionId);
  if (ids === undefined) return;
  ids.delete(executionId);
  if (ids.size === 0) inFlightBySession.delete(sessionId);
}

export function clearInFlightExecutions(sessionId: string): void {
  inFlightBySession.delete(sessionId);
}

export const DIAGNOSTICS_FILENAME = 'diagnostics.json';
export const FAILURE_FILENAME = 'failure.md';
export const DEBUG_LOG_FILENAME = 'debug.log';

export interface ManualCompletionResult {
  alreadyCompleted: boolean;
  /** Status before the completion. */
  from: string;
  /** `status.outputs` after the completion. */
  outputs: Record<string, unknown>;
  missingOutputs: string[];
  next: { path: string | null; next: NextSuggestion[] };
}

/** The stored shape of a skipped-stage record. */
export interface SkipDetails {
  reason: string;
  baseline: string;
  patterns: string[];
  changedPaths: number;
}
