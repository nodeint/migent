import path from 'node:path';

import { isRecord } from '@nodeint/migent-workflow';

import type { SessionManifest } from './session-fold-types.js';
import { cloneRecord } from './session-fold-util.js';
import { terminalFields, type TerminalSource } from './session-ledger.js';

/**
 * The status record while the fold builds it. The fold writes `status.json`, so the order in which
 * keys are first written is part of the file. The draft is the only owner of that record: every
 * change goes through an intent method, so the write order stays in one place.
 */
export class StatusDraft {
  private readonly fields: Record<string, unknown>;

  constructor(initial: Record<string, unknown> = {}) {
    this.fields = initial;
  }

  /** Read-only access for ledger functions that take the status as context. */
  public get view(): Readonly<Record<string, unknown>> {
    return this.fields;
  }

  public get(key: string): unknown {
    return this.fields[key];
  }

  public set(key: string, value: unknown): void {
    this.fields[key] = value;
  }

  public clear(key: string): void {
    delete this.fields[key];
  }

  /** The finished record. The draft keeps no copy, so call this once the fold is done. */
  public toRecord(): Record<string, unknown> {
    return this.fields;
  }

  /** Replace the five terminal keys with those `sessionStatus` calls for. */
  public applyTerminalFields(
    sessionStatus: string,
    source: TerminalSource | null,
    reason: string | null,
    blocked: readonly TerminalSource[] = [],
  ): void {
    for (const key of TERMINAL_KEYS) this.clear(key);
    for (const [key, value] of Object.entries(terminalFields(sessionStatus, source, reason, blocked))) {
      this.set(key, value);
    }
  }

  public noteLatestExecution(executionId: string, executionStatus: string, stageId: string): void {
    this.set('latest_execution_id', executionId);
    this.set('latest_execution_status', executionStatus);
    this.set('latest_stage_id', stageId);
  }

  public recordLatestDecision(decision: string | null): void {
    if (decision) this.set('latest_decision', decision);
  }

  /** Session identity from the manifest. Absent manifest fields leave the draft untouched. */
  public applyManifestIdentity(manifest: SessionManifest): void {
    this.set('session_id', manifest.sessionId || this.get('session_id'));
    if (manifest.title) this.set('title', manifest.title);
    if (manifest.workflowId) this.set('workflow_id', manifest.workflowId);
    if (manifest.workflowPath) this.set('workflow_path', manifest.workflowPath);
    if (manifest.role) this.set('role', manifest.role);
    if (manifest.task !== null) this.set('task', manifest.task);
    if (manifest.createdAt) this.set('created_at', manifest.createdAt);
    if (manifest.priorSessionId) this.set('prior_session_id', manifest.priorSessionId);
  }

  /** Set the title, or remove it when there is none. */
  public applyTitle(title: string | null): void {
    if (title !== null) this.set('title', title);
    else this.clear('title');
  }

  /** Fold `outputs.published` entries into `outputs`. */
  public mergePublished(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    const outputs = this.outputsCopy();
    for (const entry of raw) {
      if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name === '') continue;
      const row: Record<string, unknown> = {};
      if (typeof entry.path === 'string') row.path = entry.path;
      if (typeof entry.source_execution_id === 'string') row.source_execution_id = entry.source_execution_id;
      if (typeof entry.published_by_execution_id === 'string') {
        row.published_by_execution_id = entry.published_by_execution_id;
      }
      outputs[entry.name] = row;
    }
    if (Object.keys(outputs).length > 0) this.set('outputs', outputs);
  }

  /** Outputs that exist on disk but were never published get a path-only entry. */
  public addPathOnlyOutputs(outputFiles: readonly string[]): void {
    if (outputFiles.length === 0) return;
    const outputs = this.outputsCopy();
    const recorded = new Set<string>();
    for (const value of Object.values(outputs)) {
      if (isRecord(value) && typeof value.path === 'string' && value.path !== '') recorded.add(path.basename(value.path));
    }
    for (const name of outputFiles) {
      if (Object.hasOwn(outputs, name) || recorded.has(name)) continue;
      outputs[name] = { path: `outputs/${name}` };
    }
    if (Object.keys(outputs).length > 0) this.set('outputs', outputs);
  }

  private outputsCopy(): Record<string, unknown> {
    const current = this.get('outputs');
    return isRecord(current) ? cloneRecord(current) : {};
  }
}

const TERMINAL_KEYS = [
  'terminal_execution_id',
  'blocked_by_execution_id',
  'blocked_by_execution_ids',
  'blocked_by_stage_id',
  'blocker',
] as const;
