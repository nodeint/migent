import { existsSync } from 'node:fs';
import path from 'node:path';

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

export class AgentSessionRecord {
  client: string;
  model: string;
  workspace: string;
  agentId: string | null;
  options: Record<string, string>;
  status: string;
  history: Record<string, string>[];

  constructor(
    client: string,
    model: string,
    workspace: string,
    agentId: string | null = null,
    options: Record<string, string> = {},
    status = 'new',
    history: Record<string, string>[] = [],
  ) {
    this.client = client;
    this.model = model;
    this.workspace = workspace;
    this.agentId = agentId;
    this.options = { ...options };
    this.status = status;
    this.history = history;
  }

  static fromJson(
    raw: unknown,
    client: string,
    model: string,
    workspace: string,
  ): AgentSessionRecord {
    if (Array.isArray(raw)) {
      return new AgentSessionRecord(
        client,
        model,
        workspace,
        null,
        {},
        'new',
        raw as Record<string, string>[],
      );
    }
    if (!isRecord(raw)) return new AgentSessionRecord(client, model, workspace);
    const history = Array.isArray(raw.history) ? (raw.history as Record<string, string>[]) : [];
    return new AgentSessionRecord(
      nonempty(raw.client) ?? legacyClientOf(nonempty(raw.provider)) ?? client,
      nonempty(raw.model) ?? model,
      nonempty(raw.workspace) ?? workspace,
      nonempty(raw.agent_id) ?? nonempty(raw.native_session_id),
      stringOptions(raw.options),
      nonempty(raw.status) ?? 'unknown',
      history,
    );
  }

  toJson(): Record<string, unknown> {
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
    readonly sessionId: string,
    readonly executionId: string,
    readonly directory: string,
  ) {}

  get conversationPath(): string {
    return path.join(this.directory, CONVERSATION_FILENAME);
  }

  get conversationReadPath(): string {
    if (existsSync(this.conversationPath)) return this.conversationPath;
    return path.join(this.directory, LEGACY_CONVERSATION_FILENAME);
  }

  get artifactDirectory(): string {
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
