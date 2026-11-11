import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import type { } from '@nodeint/migent-kernel';
import type { StageOutcome } from '@nodeint/migent-kernel';
import { legacyClientOf } from '@nodeint/migent-kernel';
import { writeFileAtomic, writeJsonAtomic } from '@nodeint/migent-kernel';
import { ConfigurationError, OutputsMissing } from '@nodeint/migent-kernel';
import { STATUS_PROVIDER_EVENTS } from '@nodeint/migent-kernel';
import { missingCompletionOutputNames, nonemptyArtifact, shouldPublishOutputs } from '@nodeint/migent-kernel';
import { classifyOrphanedExecution, ownerMetadataPayload, processMetadataPayload, type ProcessStartInfo,raiseReapDecision, REAP_ALREADY_EXITED, REAP_STILL_RUNNING, REAP_UNVERIFIED } from '@nodeint/migent-kernel';
import { EXECUTION_SCHEMA_VERSION, EXECUTIONS_DIRNAME, safeComponent, utcNow } from '@nodeint/migent-kernel';
import { VERIFY_ARTIFACT } from '@nodeint/migent-workflow';

import { completeManuallyLocked } from './manual-completion.js';
import { sealSessionMetrics } from './metrics.js';
import { publishNextSuggestions } from './next-handoff.js';
import { appendLifecycleEvent, appendRecordedEvent, skipsStatusWrite } from './session-events.js';
import { writeFailureReport } from './session-failure-report.js';
import { commitFoldedStatus } from './session-fold.js';
import { readSessionManifest } from './session-fold-read.js';
import { createNumericSessionDirectory, quotedSessionId } from './session-id.js';
import { planExecutionSave, type PlannedExecutionSave } from './session-ledger.js';
import { assertSessionLockHeld, SessionLock, SessionLockHeldError } from './session-lock.js';
import { assertSessionId } from './session-selection.js';
import { SessionStoreResume } from './session-store-resume.js';
import type { ExecutionSaveInput, ExecutionStartInput, LoadOrCreateInput, ManualCompletionResult, SkipDetails } from './session-store-types.js';
import { AgentSessionRecord, DEBUG_LOG_FILENAME, DIAGNOSTICS_FILENAME, ExecutionContext, inFlightExecutions, stringOptions } from './session-store-types.js';
import { asInt, isDirectory, snapshotsIncludingSave } from './session-store-util.js';
import { readJsonObject, textField } from './session-store-util.js';
import { normalizeRenameTitle, writeTitleRecord } from './session-title.js';

export class SessionStore extends SessionStoreResume {
  public loadOrCreate(input: LoadOrCreateInput): [AgentSessionRecord, boolean, ExecutionContext] {
    const {
      client,
      model,
      options,
      workspace,
      sessionId,
      stageId,
      stageAttempt,
      executionOrder,
      prompt,
      validateResume,
    } = input;
    const resumeExecutionId = input.resumeExecutionId ?? null;
    if (resumeExecutionId !== null && sessionId === null) {
      throw new Error('Resuming an execution requires a session.');
    }
    if (sessionId !== null) this.reapOrphanedExecutions(sessionId, 'raise');
    this.ensureSessionIsRunnable(sessionId);
    let previous: ExecutionContext | null = null;
    if (resumeExecutionId !== null) {
      previous = this.executionContext(sessionId as string, resumeExecutionId);
      if (previous === null) {
        throw new Error(`Execution ${resumeExecutionId} was not found in session ${sessionId}.`);
      }
    }
    if (previous === null) {
      const context = this.createExecution(
        { client, model, options, sessionId, stageId, stageAttempt, executionOrder, prompt },
      );
      return [
        new AgentSessionRecord({ client, model, workspace, options: { ...(options ?? {}) } }),
        true,
        context,
      ];
    }
    const raw = JSON.parse(readFileSync(previous.conversationReadPath, 'utf8')) as unknown;
    const record = AgentSessionRecord.fromJson(raw, { client, model, workspace });
    record.client = this.executionClient(sessionId as string, previous.executionId);
    validateResume?.(record);
    const context = this.createExecution(
      {
        client,
        model,
        options,
        sessionId,
        stageId,
        stageAttempt,
        executionOrder,
        prompt,
        resumesExecutionId: previous.executionId,
      },
    );
    return [record, false, context];
  }

  /** Start a verify-only execution. It has no prompt and no provider conversation. */
  public openVerifyExecution(sessionId: string, stageId: string): ExecutionContext {
    this.ensureSessionIsRunnable(sessionId);
    return this.createExecution({ client: '', model: '', options: {}, sessionId, stageId, stageAttempt: null, executionOrder: null, prompt: '', kind: 'verify' });
  }

  public clearVerifyTurn(context: ExecutionContext): void {
    rmSync(this.turnDirectory(context, 1), { recursive: true, force: true });
  }

  public saveExecution(context: ExecutionContext, record: AgentSessionRecord, result: ExecutionSaveInput): void {
    const filePath = path.join(context.directory, 'execution.json');
    if (result.locked === true) {
      this.saveExecutionUnlocked(context, record, result);
      return;
    }
    this.withExecutionLock(filePath, () => {
      this.saveExecutionUnlocked(context, record, result);
    });
  }

  /** Merge fields into a running execution without touching status.json or events. */
  public saveExecutionProgress(
    context: ExecutionContext,
    record: AgentSessionRecord,
    fields: Record<string, unknown>,
  ): void {
    const filePath = path.join(context.directory, 'execution.json');
    this.withExecutionLock(filePath, () => {
      const metadata = readJsonObject(filePath);
      if (metadata.status !== 'running') {
        throw new Error(`Execution ${context.executionId} is not running.`);
      }
      Object.assign(metadata, fields);
      metadata.agent_id = record.agentId;
      writeJsonAtomic(filePath, metadata);
    });
  }

  public clearProcessEndpoint(context: ExecutionContext): void {
    const filePath = path.join(context.directory, 'execution.json');
    this.withExecutionLock(filePath, () => {
      const metadata = readJsonObject(filePath);
      metadata.provider_endpoint = null;
      metadata.provider_pid = null;
      writeJsonAtomic(filePath, metadata);
    });
  }

  public saveTurnResponse(context: ExecutionContext, turn: number, text: string): void {
    this.writeTurnFile(context, { turn, name: 'response.md', text });
  }

  public saveTurnOutcome(context: ExecutionContext, turn: number, outcome: StageOutcome): void {
    this.writeTurnFile(context, { turn, name: 'outcome.json', text: `${JSON.stringify(outcome.toJson(), null, 2)}\n` });
  }

  public saveTurnVerify(context: ExecutionContext, turn: number, report: string): string {
    this.writeTurnFile(context, { turn, name: 'verify.md', text: report });
    return path.posix.join('turns', String(turn).padStart(2, '0'), 'verify.md');
  }

  private writeTurnFile(context: ExecutionContext, file: { turn: number; name: string; text: string }): void {
    const { turn, name, text } = file;
    const directory = this.turnDirectory(context, turn);
    mkdirSync(directory, { recursive: true });
    writeFileAtomic(path.join(directory, name), text);
  }

  /** Copy the passing turn's report next to the stage artifact. */
  public publishVerifyReport(context: ExecutionContext, turn: number): void {
    mkdirSync(context.artifactDirectory, { recursive: true });
    copyFileSync(
      path.join(this.turnDirectory(context, turn), 'verify.md'),
      path.join(context.artifactDirectory, VERIFY_ARTIFACT),
    );
  }

  /**
   * Carry a working artifact across verification retries or question replies.
   */
  public carryVerifyArtifact(previousArtifactDirectory: string, context: ExecutionContext, name: string): void {
    const source = path.join(previousArtifactDirectory, name);
    if (name === VERIFY_ARTIFACT || !nonemptyArtifact(source)) return;
    mkdirSync(context.artifactDirectory, { recursive: true });
    copyFileSync(source, path.join(context.artifactDirectory, name));
  }

  public saveProcessMetadata(context: ExecutionContext, info: ProcessStartInfo): void {
    const filePath = path.join(context.directory, 'execution.json');
    this.withExecutionLock(filePath, () => {
      const metadata = readJsonObject(filePath);
      Object.assign(metadata, processMetadataPayload(info));
      writeJsonAtomic(filePath, metadata);
    });
  }

  /** The latest abnormal provider turn of this execution (a start failure, a non-zero exit, a provider-reported error). Separate from `execution.json`, which is frozen once the execution ends. */
  public saveDiagnostics(context: ExecutionContext, payload: Record<string, unknown>): void {
    mkdirSync(context.directory, { recursive: true });
    writeJsonAtomic(path.join(context.directory, DIAGNOSTICS_FILENAME), payload);
  }

  public appendDebugLog(context: ExecutionContext, line: string): void {
    try {
      mkdirSync(context.directory, { recursive: true });
      appendFileSync(path.join(context.directory, DEBUG_LOG_FILENAME), `${line}\n`, 'utf8');
    } catch {
      // tracing must never fail a run
    }
  }

  public reapOrphanedExecutions(sessionId: string, onLiveOwner: string, inFlight?: ReadonlySet<string>): void {
    const skip = inFlight ?? inFlightExecutions(sessionId);
    for (const context of this.executionContexts(sessionId)) {
      if (skip?.has(context.executionId)) continue;
      this.reapExecution(context, onLiveOwner);
    }
  }

  public recordProviderEvent(context: ExecutionContext, event: Record<string, unknown>): void {
    const sessionDirectory = path.dirname(path.dirname(context.directory));
    appendRecordedEvent(sessionDirectory, event);
    const name = String(event.event);
    if (!STATUS_PROVIDER_EVENTS.has(name) || skipsStatusWrite(name)) return;
    commitFoldedStatus(this.workspace, sessionDirectory);
  }

  public missingCompletionOutputs(context: ExecutionContext, outcome: StageOutcome | null): string[] {
    const sessionDirectory = path.dirname(path.dirname(context.directory));
    const previousStatus = this.readSessionStatusAt(sessionDirectory);
    const workflow = this.loadWorkflow(previousStatus);
    if (workflow === null) return [];
    const workflowId = previousStatus.workflow_id;
    if (
      !shouldPublishOutputs({
        workflowId: typeof workflowId === 'string' ? workflowId : null,
        executionStatus: 'completed',
        outcome,
        workflow,
        stageId: this.stageId(context),
      })
    ) {
      return [];
    }
    const metadata = readJsonObject(path.join(context.directory, 'execution.json'));
    return missingCompletionOutputNames({
      workflow,
      snapshots: this.snapshotList(context.sessionId),
      beforeOrder: asInt(metadata.execution_order),
    });
  }

  /** A run_when skip. The row is terminal from the start: no prompt, no provider, no verify. */
  public recordSkippedExecution(sessionId: string, stageId: string, skip: SkipDetails): ExecutionContext {
    const sessionDirectory = path.join(this.sessionsDirectory, sessionId);
    assertSessionLockHeld(sessionDirectory);
    const order = this.nextExecutionOrder(sessionId);
    const attempt = this.nextStageAttempt(sessionId, stageId);
    const executionId = `${String(order).padStart(4, '0')}-${safeComponent(stageId)}--attempt-${String(attempt).padStart(2, '0')}`;
    const directory = path.join(sessionDirectory, EXECUTIONS_DIRNAME, executionId);
    mkdirSync(path.dirname(directory), { recursive: true });
    try {
      mkdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Execution already exists: ${directory}`, { cause: error });
      }
      throw error;
    }
    const taskSource = path.join(sessionDirectory, 'task.md');
    if (existsSync(taskSource)) copyFileSync(taskSource, path.join(directory, 'task.md'));
    const context = new ExecutionContext(sessionId, executionId, directory);
    mkdirSync(context.artifactDirectory);
    const previousStatus = this.readSessionStatusAt(sessionDirectory);
    const workflow = this.loadWorkflow(previousStatus);
    const manifest = readSessionManifest(sessionDirectory);
    const timestamp = utcNow();
    const skipRecord = {
      reason: skip.reason,
      baseline: skip.baseline,
      patterns: [...skip.patterns],
      changed_paths: skip.changedPaths,
    };
    writeJsonAtomic(path.join(directory, 'execution.json'), {
      session_id: sessionId,
      execution_id: executionId,
      execution_order: order,
      stage_id: stageId,
      stage_attempt: attempt,
      kind: 'skip',
      client: null,
      model: null,
      options: {},
      agent_id: null,
      resumes_execution_id: null,
      status: 'skipped',
      schema_version: EXECUTION_SCHEMA_VERSION,
      created_at: timestamp,
      completed_at: timestamp,
      artifact_directory: 'artifacts',
      skip: skipRecord,
    });
    const plan = planExecutionSave({
      executionStatus: 'skipped',
      outcome: null,
      storedError: null,
      stageId,
      executionOrder: order,
      executionId,
      sessionDirectory,
      previousStatus,
      workflow,
      schemaVersion: manifest.schemaVersion,
      manifestStatus: manifest.manifestStatus,
      snapshots: this.snapshotList(sessionId),
    });
    appendLifecycleEvent(sessionDirectory, {
      event: 'execution.started',
      timestamp,
      executionId,
      stageId,
      data: {
        execution_order: order,
        stage_attempt: attempt,
        client: '',
        model: '',
        resumes_execution_id: null,
        kind: 'skip',
      },
    });
    this.finishExecutionSave({
      context,
      sessionDirectory,
      status: 'skipped',
      outcome: null,
      plan,
      previousStatus,
      timestamp,
      stageId,
      failureReason: null,
      storedError: null,
      extraData: { skip: skipRecord },
    });
    return context;
  }

  public savePrompt(context: ExecutionContext, prompt: string): void {
    writeFileAtomic(path.join(context.directory, 'prompt.md'), prompt);
  }

  /** Save text returned by the model. Never pass Migent error text; a failed turn writes failure.md instead. */
  public saveResponse(context: ExecutionContext, responseText: string): void {
    writeFileAtomic(path.join(context.directory, 'response.md'), responseText);
  }

  private saveExecutionUnlocked(
    context: ExecutionContext,
    record: AgentSessionRecord,
    result: ExecutionSaveInput,
  ): void {
    const { status, error = null, outcome = null, extra = null } = result;
    const filePath = path.join(context.directory, 'execution.json');
    const metadata = readJsonObject(filePath);
    const existingStatus = metadata.status;
    if (
      existingStatus === 'completed' ||
      existingStatus === 'failed' ||
      existingStatus === 'cancelled' ||
      existingStatus === 'skipped'
    ) {
      throw new Error(`Execution ${context.executionId} is immutable after it ended.`);
    }
    const sessionDirectory = path.dirname(path.dirname(context.directory));
    assertSessionLockHeld(sessionDirectory);
    const previousStatus = this.readSessionStatusAt(sessionDirectory);
    const workflow = this.loadWorkflow(previousStatus);
    const manifest = readSessionManifest(sessionDirectory);
    const stageId = typeof metadata.stage_id === 'string' ? metadata.stage_id : '';
    const executionOrder = asInt(metadata.execution_order);
    const timestamp = utcNow();
    metadata.status = status;
    metadata.agent_id = record.agentId;
    metadata.completed_at = status === 'running' ? null : timestamp;
    if (error !== null) metadata.error = error;
    if (outcome !== null) {
      metadata.outcome = outcome.toJson();
      if (outcome.status === 'question') {
        writeJsonAtomic(path.join(context.directory, 'questions.json'), {
          schema_version: 1, stage_id: metadata.stage_id, execution_id: context.executionId,
          recipient: workflow?.stages[stageId]?.ask ?? 'human',
          questions: outcome.questions,
        });
      }
    }
    if (extra !== null) Object.assign(metadata, extra);
    const storedError = typeof metadata.error === 'string' ? metadata.error : null;
    const failureReason = typeof metadata.failure_reason === 'string' ? metadata.failure_reason : null;
    const plan = planExecutionSave({
      executionStatus: status,
      outcome,
      storedError,
      stageId,
      executionOrder,
      executionId: context.executionId,
      sessionDirectory,
      previousStatus,
      workflow,
      schemaVersion: manifest.schemaVersion,
      manifestStatus: manifest.manifestStatus,
      snapshots: snapshotsIncludingSave(this.snapshotList(context.sessionId), {
        executionId: context.executionId,
        stageId,
        executionOrder,
        status,
        outcomeStatus: outcome?.status ?? null,
        artifactDirectory: context.artifactDirectory,
        outcomeDecision: outcome?.decision || null,
        failureReason,
      }),
    });
    writeJsonAtomic(filePath, metadata);
    if (status === 'failed') {
      writeFailureReport(context, metadata, error ?? (typeof metadata.error === 'string' ? metadata.error : null));
    }
    this.finishExecutionSave({
      context,
      sessionDirectory,
      status,
      outcome,
      plan,
      previousStatus,
      timestamp,
      stageId,
      failureReason,
      storedError,
      extraData: null,
    });
  }

  /** Events, fold, and sealing after the execution file is final. Shared by saves and skip records. */
  private finishExecutionSave(input: {
    context: ExecutionContext;
    sessionDirectory: string;
    status: string;
    outcome: StageOutcome | null;
    plan: PlannedExecutionSave;
    previousStatus: Record<string, unknown>;
    timestamp: string;
    stageId: string;
    failureReason: string | null;
    storedError: string | null;
    extraData: Record<string, unknown> | null;
  }): void {
    const { context, sessionDirectory, status, outcome, plan, previousStatus, timestamp, stageId } = input;
    const { failureReason, storedError } = input;
    appendLifecycleEvent(sessionDirectory, {
      event: `execution.${status}`,
      timestamp,
      executionId: context.executionId,
      stageId,
      data: {
        outcome: outcome ? outcome.toJson() : null,
        failure_reason: failureReason,
        error: storedError,
        session_status: plan.sessionStatus,
        ...(input.extraData ?? {}),
      },
    });
    if (outcome !== null) {
      const outcomeJson = outcome.toJson();
      appendLifecycleEvent(sessionDirectory, {
        event: `stage.${outcome.status}`,
        timestamp,
        executionId: context.executionId,
        stageId,
        outcomeTopLevel: outcomeJson,
        data: { outcome: outcomeJson },
      });
    }
    if (plan.outputs.length > 0) {
      appendLifecycleEvent(sessionDirectory, {
        event: 'outputs.published',
        timestamp,
        executionId: context.executionId,
        stageId,
        data: { outputs: plan.outputs },
      });
    }
    if (plan.sessionEvent !== null) {
      appendLifecycleEvent(sessionDirectory, {
        event: `session.${plan.sessionStatus}`,
        timestamp,
        executionId: context.executionId,
        stageId,
        outcomeTopLevel: plan.sessionEvent.outcomeTopLevel,
        data: plan.sessionEvent.data,
      });
    }
    if (plan.manifestStatus !== null) this.rewriteManifestStatus(sessionDirectory, plan.manifestStatus);
    commitFoldedStatus(this.workspace, sessionDirectory);
    if (
      plan.sessionStatus === 'completed' &&
      previousStatus.workflow_id !== 'agent' &&
      this.metricsClients !== null
    ) {
      sealSessionMetrics(this.workspace, context.sessionId, this.metricsClients);
    }
    if (plan.sessionStatus === 'completed') publishNextSuggestions(this.workspace, context.sessionId);
    if (plan.outputsMissing.length > 0) throw new OutputsMissing(plan.outputsMissing);
  }

  /**
   * Change a session's display title. Takes no session lock, so it works during a live run. Only
   * title.json is written; readers overlay it and the next lifecycle commit folds it into status.json.
   */
  public rename(sessionId: string, rawTitle: string): { sessionId: string; title: string; previousTitle: string | null } {
    const title = normalizeRenameTitle(rawTitle);
    assertSessionId(sessionId);
    const sessionDirectory = path.join(this.sessionsDirectory, sessionId);
    if (!isDirectory(sessionDirectory)) throw new ConfigurationError(`Session ${sessionId} does not exist.`);
    const { previousTitle } = writeTitleRecord(sessionDirectory, title, utcNow());
    return { sessionId, title, previousTitle };
  }

  /**
   * A human marks a stopped workflow session completed. Takes the session lock, so a live run is refused.
   * Publishes what a normal completion would, seals metrics, and writes next.json. Terminal and idempotent.
   */
  public completeManually(sessionId: string): ManualCompletionResult {
    assertSessionId(sessionId);
    const sessionDirectory = path.join(this.sessionsDirectory, sessionId);
    if (!isDirectory(sessionDirectory)) throw new ConfigurationError(`Session ${sessionId} does not exist.`);
    const lock = SessionLock.tryAcquire(sessionDirectory);
    if (lock === null) {
      throw new SessionLockHeldError(
        `Session ${sessionId} is being run by another process. Stop it first with: migent session cancel ${sessionId}`,
      );
    }
    try {
      return this.completeManuallyLocked(sessionId, sessionDirectory);
    } finally {
      lock.release();
    }
  }

  private completeManuallyLocked(sessionId: string, sessionDirectory: string): ManualCompletionResult {
    return completeManuallyLocked(
      {
        workspace: this.workspace,
        metricsClients: this.metricsClients,
        loadWorkflow: (status) => this.loadWorkflow(status),
        snapshotList: (id) => this.snapshotList(id),
        rewriteManifestStatus: (directory, status) => this.rewriteManifestStatus(directory, status),
      },
      sessionId,
      sessionDirectory,
    );
  }

  private reapExecution(context: ExecutionContext, onLiveOwner: string): void {
    const filePath = path.join(context.directory, 'execution.json');
    this.withExecutionLock(filePath, () => {
      const metadata = readJsonObject(filePath);
      const decision = classifyOrphanedExecution(metadata, context.directory, this.processInspector);
      if (decision.action === REAP_ALREADY_EXITED) {
        this.failOrphanedExecution(context, metadata, { error: decision.error || '', locked: true });
        return;
      }
      if (decision.action === REAP_STILL_RUNNING || decision.action === REAP_UNVERIFIED) {
        if (onLiveOwner === 'raise') raiseReapDecision(decision);
      }
    });
  }

  private failOrphanedExecution(
    context: ExecutionContext,
    metadata: Record<string, unknown>,
    failure: { error: string; locked: boolean },
  ): void {
    const { error, locked } = failure;
    let record = new AgentSessionRecord(
      { client: textField(metadata.client) ?? legacyClientOf(textField(metadata.provider)) ?? 'unknown', model: typeof metadata.model === 'string' ? metadata.model : 'unknown', workspace: this.workspace, agentId: typeof metadata.agent_id === 'string' ? metadata.agent_id : null, options: stringOptions(metadata.options), status: 'failed' },
    );
    const conversationPath = context.conversationReadPath;
    if (existsSync(conversationPath)) {
      const raw = JSON.parse(readFileSync(conversationPath, 'utf8')) as unknown;
      record = AgentSessionRecord.fromJson(
        raw,
        { client: record.client, model: record.model, workspace: record.workspace },
      );
      record.status = 'failed';
      this.save(record, context);
    }
    const extra = metadata.kind === 'verify' ? { failure_reason: 'verify_failed' } : null;
    this.saveExecution(context, record, { status: 'failed', error, locked, extra });
  }

  private createExecution(input: ExecutionStartInput): ExecutionContext {
    const { client, model, options, sessionId, stageId, stageAttempt, executionOrder, prompt } = input;
    const { resumesExecutionId = null, kind = null } = input;
    const resolvedSession = sessionId ?? path.basename(createNumericSessionDirectory(this.sessionsDirectory)[1]);
    const order = executionOrder ? executionOrder : this.nextExecutionOrder(resolvedSession);
    const attempt = stageAttempt ? stageAttempt : this.nextStageAttempt(resolvedSession, stageId);
    const executionId = `${String(order).padStart(4, '0')}-${safeComponent(stageId)}--attempt-${String(attempt).padStart(2, '0')}`;
    const directory = path.join(
      this.sessionsDirectory,
      resolvedSession,
      EXECUTIONS_DIRNAME,
      executionId,
    );
    assertSessionLockHeld(path.join(this.sessionsDirectory, resolvedSession));
    mkdirSync(path.dirname(directory), { recursive: true });
    try {
      mkdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Execution already exists: ${directory}`, { cause: error });
      }
      throw error;
    }
    const taskSource = path.join(this.sessionsDirectory, resolvedSession, 'task.md');
    if (existsSync(taskSource)) copyFileSync(taskSource, path.join(directory, 'task.md'));
    const context = new ExecutionContext(resolvedSession, executionId, directory);
    mkdirSync(context.artifactDirectory);
    this.createSessionFiles(context);
    const verifyOnly = kind === 'verify';
    if (!verifyOnly) writeFileAtomic(path.join(directory, 'prompt.md'), prompt);
    const createdAt = utcNow();
    const sessionDirectory = path.dirname(path.dirname(directory));
    writeJsonAtomic(path.join(directory, 'execution.json'), {
      session_id: resolvedSession,
      execution_id: executionId,
      execution_order: order,
      stage_id: stageId,
      stage_attempt: attempt,
      ...(verifyOnly ? { kind: 'verify' } : {}),
      client: verifyOnly ? null : client,
      model: verifyOnly ? null : model,
      options: { ...(options ?? {}) },
      agent_id: null,
      resumes_execution_id: resumesExecutionId,
      status: 'running',
      ...ownerMetadataPayload(),
      schema_version: EXECUTION_SCHEMA_VERSION,
      created_at: createdAt,
      artifact_directory: 'artifacts',
    });
    appendLifecycleEvent(sessionDirectory, {
      event: 'execution.started',
      timestamp: createdAt,
      executionId,
      stageId,
      data: {
        execution_order: order,
        stage_attempt: attempt,
        client,
        model,
        resumes_execution_id: resumesExecutionId,
      },
    });
    commitFoldedStatus(this.workspace, sessionDirectory);
    return context;
  }

  private createSessionFiles(context: ExecutionContext): void {
    const sessionDirectory = path.dirname(path.dirname(context.directory));
    const manifestPath = path.join(sessionDirectory, 'manifest.yaml');
    if (existsSync(manifestPath)) return;
    const createdAt = utcNow();
    writeFileAtomic(
      manifestPath,
      `${[`session_id: ${quotedSessionId(context.sessionId)}`, `created_at: ${createdAt}`, 'status: running'].join('\n')}\n`);
    appendLifecycleEvent(sessionDirectory, {
      event: 'session.created',
      timestamp: createdAt,
      data: {},
    });
  }

}

export type { ExecutionSaveInput, ExecutionStartInput, LoadOrCreateInput, ManualCompletionResult, SessionRecordFallback, SessionRecordInit, SkipDetails } from './session-store-types.js';
export {
  AgentSessionRecord,
  clearInFlightExecution,
  clearInFlightExecutions,
  DEBUG_LOG_FILENAME,
  DIAGNOSTICS_FILENAME,
  ExecutionContext,
  FAILURE_FILENAME,
  noteInFlightExecution,
  stringOptions,
} from './session-store-types.js';
