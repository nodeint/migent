import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type { ClientRegistry } from '@nodeint/migent-kernel';
import type { } from '@nodeint/migent-kernel';
import { writeFileAtomic, writeJsonAtomic } from '@nodeint/migent-kernel';
import { ConfigurationError } from '@nodeint/migent-kernel';
import { type ExecutionSnapshot,runnableViolation } from '@nodeint/migent-kernel';
import { type ProcessInspector,SystemProcessInspector } from '@nodeint/migent-kernel';
import { EXECUTIONS_DIRNAME, MIGENT_DIRNAME, safeComponent,SESSIONS_DIRNAME } from '@nodeint/migent-kernel';
import { withFileLockSync } from '@nodeint/migent-kernel';
import { isRecord } from '@nodeint/migent-workflow';
import { loadNamedWorkflow, loadWorkflowDocument, type WorkflowDocument } from '@nodeint/migent-workflow';

import { readExecutionClient } from './legacy-execution-client.js';
import { corruptStatusMessage, readStatusFileState } from './query.js';
import { reservedExecutionOrders, reservedStageAttempts } from './session-events.js';
import { readSessionManifest } from './session-fold-read.js';
import { loadFrozenWorkflow, readWorkflowFreeze } from './session-freeze.js';
import { AgentSessionRecord, ExecutionContext } from './session-store-types.js';
import { asInt, compareSortKey, isFile, verifyReportPath } from './session-store-util.js';
import { readJsonObject, textField } from './session-store-util.js';

export class SessionStoreCore {
  public readonly workspace: string;
  public readonly sessionsDirectory: string;
  public readonly processInspector: ProcessInspector;
  public readonly metricsClients: ClientRegistry | null;

  constructor(
    workspace: string,
    processInspector?: ProcessInspector,
    metricsClients?: ClientRegistry,
  ) {
    this.workspace = workspace;
    this.sessionsDirectory = path.join(workspace, MIGENT_DIRNAME, SESSIONS_DIRNAME);
    this.processInspector = processInspector ?? new SystemProcessInspector();
    this.metricsClients = metricsClients ?? null;
  }

  public executionContext(sessionId: string, executionId: string): ExecutionContext | null {
    const directory = path.join(this.sessionsDirectory, sessionId, EXECUTIONS_DIRNAME, executionId);
    try {
      if (!statSync(directory).isDirectory()) return null;
    } catch {
      return null;
    }
    return new ExecutionContext(sessionId, executionId, directory);
  }

  protected executionContexts(sessionId: string): ExecutionContext[] {
    const directory = path.join(this.sessionsDirectory, sessionId, EXECUTIONS_DIRNAME);
    if (!existsSync(directory)) return [];
    const contexts: ExecutionContext[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const executionDirectory = path.join(directory, entry.name);
      if (!existsSync(path.join(executionDirectory, 'execution.json'))) continue;
      contexts.push(new ExecutionContext(sessionId, entry.name, executionDirectory));
    }
    return contexts;
  }

  protected executionSortKey(context: ExecutionContext): [number, string] {
    const metadata = readJsonObject(path.join(context.directory, 'execution.json'));
    return [asInt(metadata.execution_order), context.executionId];
  }

  protected snapshotList(sessionId: string): ExecutionSnapshot[] {
    const snapshots: ExecutionSnapshot[] = [];
    for (const context of this.executionContexts(sessionId)) {
      const metadata = readJsonObject(path.join(context.directory, 'execution.json'));
      const {outcome} = metadata;
      let outcomeStatus: string | null = null;
      let outcomeDecision: string | null = null;
      if (isRecord(outcome)) {
        if (typeof outcome.status === 'string') outcomeStatus = outcome.status;
        if (typeof outcome.decision === 'string' && outcome.decision) outcomeDecision = outcome.decision;
      }
      snapshots.push({
        executionId: context.executionId,
        stageId: typeof metadata.stage_id === 'string' ? metadata.stage_id : '',
        executionOrder: asInt(metadata.execution_order),
        status: typeof metadata.status === 'string' ? metadata.status : '',
        outcomeStatus,
        artifactDirectory: context.artifactDirectory,
        outcomeDecision,
        failureReason: typeof metadata.failure_reason === 'string' ? metadata.failure_reason : null,
        verifyReport: verifyReportPath(context.directory, metadata.verify),
      });
    }
    return snapshots;
  }

  public executionSnapshots(sessionId: string): ExecutionSnapshot[] {
    return this.snapshotList(sessionId);
  }

  public readSessionStatus(sessionId: string): Record<string, unknown> {
    return this.readSessionStatusAt(path.join(this.sessionsDirectory, sessionId));
  }

  protected readSessionStatusAt(sessionDirectory: string): Record<string, unknown> {
    const statusPath = path.join(sessionDirectory, 'status.json');
    const read = readStatusFileState(statusPath);
    if (read.state === 'corrupt') throw new ConfigurationError(corruptStatusMessage(statusPath));
    return read.status;
  }

  protected withExecutionLock<T>(filePath: string, fn: () => T): T {
    if (!existsSync(filePath)) return fn();
    return withFileLockSync(filePath, fn);
  }

  protected rewriteManifestStatus(sessionDirectory: string, status: string): void {
    if (readSessionManifest(sessionDirectory).schemaVersion >= 2) return;
    const manifestPath = path.join(sessionDirectory, 'manifest.yaml');
    try {
      if (!statSync(manifestPath).isFile()) return;
    } catch {
      return;
    }
    const text = readFileSync(manifestPath, 'utf8');
    const pattern = /^status: \S+\s*$/m;
    if (!pattern.test(text)) return;
    writeFileAtomic(manifestPath, text.replace(pattern, `status: ${status}`));
  }

  protected loadWorkflow(previousStatus: Record<string, unknown>): WorkflowDocument | null {
    if (previousStatus.workflow_id === 'agent') return null;
    const sessionId = previousStatus.session_id;
    if (typeof sessionId === 'string' && sessionId !== '') {
      const frozen = loadFrozenWorkflow(path.join(this.sessionsDirectory, sessionId));
      if (frozen) return frozen;
    }
    const workflowPath = previousStatus.workflow_path;
    if (typeof workflowPath === 'string' && workflowPath) {
      const filePath = path.isAbsolute(workflowPath) ? workflowPath : path.join(this.workspace, workflowPath);
      if (isFile(filePath)) {
        try {
          return loadWorkflowDocument(filePath);
        } catch (error) {
          if (!(error instanceof ConfigurationError)) throw error;
        }
      }
    }
    const workflowId = previousStatus.workflow_id;
    if (typeof workflowId !== 'string' || workflowId === '') return null;
    try {
      return loadNamedWorkflow(this.workspace, workflowId);
    } catch (error) {
      if (error instanceof ConfigurationError) return null;
      throw error;
    }
  }

  protected ensureSessionIsRunnable(sessionId: string | null): void {
    if (sessionId === null) return;
    const statusPath = path.join(this.sessionsDirectory, sessionId, 'status.json');
    const read = readStatusFileState(statusPath);
    if (read.state === 'corrupt') throw new ConfigurationError(corruptStatusMessage(statusPath));
    if (read.state === 'missing') return;
    const {status} = read;
    const message = runnableViolation(sessionId, status);
    if (message) throw new Error(message);
  }

  protected nextExecutionOrder(sessionId: string): number {
    const sessionDirectory = path.join(this.sessionsDirectory, sessionId);
    const orders = [
      ...this.executionContexts(sessionId).map((context) => this.executionSortKey(context)[0]),
      ...reservedExecutionOrders(sessionDirectory),
    ];
    return Math.max(0, ...orders) + 1;
  }

  protected nextStageAttempt(sessionId: string, stageId: string): number {
    const attempts: number[] = [];
    for (const context of this.executionContexts(sessionId)) {
      const metadata = readJsonObject(path.join(context.directory, 'execution.json'));
      if (metadata.stage_id === stageId) attempts.push(asInt(metadata.stage_attempt));
    }
    let safe: string;
    try {
      safe = safeComponent(stageId);
    } catch {
      safe = stageId;
    }
    const sessionDirectory = path.join(this.sessionsDirectory, sessionId);
    for (const slot of reservedStageAttempts(sessionDirectory)) {
      if (slot.stageId === stageId || slot.stageId === safe) attempts.push(slot.attempt);
    }
    return Math.max(0, ...attempts) + 1;
  }

  protected executionBlocker(sessionId: string, executionId: string): string | null {
    const context = this.executionContext(sessionId, executionId);
    if (context === null) return null;
    const {outcome} = readJsonObject(path.join(context.directory, 'execution.json'));
    if (!isRecord(outcome)) return null;
    return textField(outcome.blocker);
  }

  public stageId(context: ExecutionContext): string {
    const metadata = readJsonObject(path.join(context.directory, 'execution.json'));
    const stageId = metadata.stage_id;
    if (typeof stageId !== 'string') throw new Error(`Execution ${context.executionId} has no stage_id.`);
    return stageId;
  }

  public latestExecution(sessionId: string): ExecutionContext | null {
    const contexts = this.executionContexts(sessionId);
    if (contexts.length === 0) return null;
    return contexts.reduce((best, context) =>
      compareSortKey(this.executionSortKey(context), this.executionSortKey(best)) > 0 ? context : best,
    );
  }

  public turnDirectory(context: ExecutionContext, turn: number): string {
    return path.join(context.directory, 'turns', String(turn).padStart(2, '0'));
  }

  /** Resolve and validate provenance before any resume changes persisted state. */
  public executionClient(sessionId: string, executionId: string): string {
    const context = this.executionContext(sessionId, executionId);
    if (context === null) throw new ConfigurationError(`Execution ${executionId} was not found in session ${sessionId}.`);
    const metadata = readJsonObject(path.join(context.directory, 'execution.json'));
    const sessionDirectory = path.join(this.sessionsDirectory, sessionId);
    const freeze = readWorkflowFreeze(sessionDirectory);
    const stageId = typeof metadata.stage_id === 'string' ? metadata.stage_id : '';
    const frozen = freeze?.targets[stageId]?.client;
    const decided = readExecutionClient(sessionDirectory, executionId, metadata, frozen);
    if (decided.client === null) {
      throw new ConfigurationError(`Cannot resume execution ${executionId}: ${decided.reason}. Start a new attempt.`);
    }
    return decided.client;
  }

  public save(record: AgentSessionRecord, context: ExecutionContext): void {
    writeJsonAtomic(context.conversationPath, record.toJson());
  }
}
