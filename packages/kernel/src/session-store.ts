import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import type { Provider } from "./provider-contract.js";
import { writeFileAtomic, writeJsonAtomic } from "./atomic-file.js";
import { ConfigurationError, OutputsMissing } from "./errors.js";
import { sealSessionMetrics } from "./metrics.js";
import { appendLifecycleEvent, appendRecordedEvent, reservedExecutionOrders, reservedStageAttempts, skipsStatusWrite } from "./session-events.js";
import { commitFoldedStatus, readSessionManifest } from "./session-fold.js";
import { loadFrozenWorkflow } from "./session-freeze.js";
import { assertSessionLockHeld } from "./session-lock.js";
import { corruptStatusMessage, readStatusFileState } from "./query.js";
import { STATUS_PROVIDER_EVENTS } from "./event-kinds.js";
import {
  missingCompletionOutputNames,
  nonemptyArtifact,
  runnableViolation,
  shouldPublishOutputs,
  type ExecutionSnapshot,
} from "./outputs.js";
import { blockedExecutions, planExecutionSave, statusExecutionsFromSnapshots } from "./session-ledger.js";
import {
  REAP_ALREADY_EXITED,
  REAP_STILL_RUNNING,
  REAP_UNVERIFIED,
  SystemProcessInspector,
  classifyOrphanedExecution,
  processMetadataPayload,
  raiseReapDecision,
  type ProcessInspector,
  type ProcessStartInfo,
} from "./process-ownership.js";
import { isRecord } from "./record.js";
import {
  MIGENT_DIRNAME,
  CONVERSATION_FILENAME,
  EXECUTION_SCHEMA_VERSION,
  EXECUTIONS_DIRNAME,
  LEGACY_CONVERSATION_FILENAME,
  SESSIONS_DIRNAME,
  safeComponent,
  utcNow,
} from "./runtime.js";
import { withFileLockSync } from "./file-lock.js";
import type { StageOutcome } from "./stage-outcome.js";
import {
  VERIFY_ARTIFACT,
  loadNamedWorkflow,
  loadWorkflowDocument,
  type WorkflowDocument,
} from "./workflow.js";

export function stringOptions(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const options: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") options[key] = item;
  }
  return options;
}

export class AgentSessionRecord {
  provider: string;
  model: string;
  workspace: string;
  agentId: string | null;
  options: Record<string, string>;
  status: string;
  history: Array<Record<string, string>>;

  constructor(
    provider: string,
    model: string,
    workspace: string,
    agentId: string | null = null,
    options: Record<string, string> = {},
    status = "new",
    history: Array<Record<string, string>> = [],
  ) {
    this.provider = provider;
    this.model = model;
    this.workspace = workspace;
    this.agentId = agentId;
    this.options = { ...options };
    this.status = status;
    this.history = history;
  }

  static fromJson(
    raw: unknown,
    provider: string,
    model: string,
    workspace: string,
  ): AgentSessionRecord {
    if (Array.isArray(raw)) {
      return new AgentSessionRecord(
        provider,
        model,
        workspace,
        null,
        {},
        "new",
        raw as Array<Record<string, string>>,
      );
    }
    if (!isRecord(raw)) return new AgentSessionRecord(provider, model, workspace);
    const history = Array.isArray(raw.history) ? (raw.history as Array<Record<string, string>>) : [];
    return new AgentSessionRecord(
      nonempty(raw.provider) ?? provider,
      nonempty(raw.model) ?? model,
      nonempty(raw.workspace) ?? workspace,
      nonempty(raw.agent_id) ?? nonempty(raw.native_session_id),
      stringOptions(raw.options),
      nonempty(raw.status) ?? "unknown",
      history,
    );
  }

  toJson(): Record<string, unknown> {
    return {
      provider: this.provider,
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
    return path.join(this.directory, "artifacts");
  }
}

// loadOrCreate builds its own SessionStore, so the execute loop's instance cannot see this set.
const inFlightBySession = new Map<string, Set<string>>();

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

export class SessionStore {
  readonly workspace: string;
  readonly sessionsDirectory: string;
  readonly processInspector: ProcessInspector;
  readonly metricsProviders: Record<string, Provider> | null;

  constructor(
    workspace: string,
    processInspector?: ProcessInspector,
    metricsProviders?: Record<string, Provider>,
  ) {
    this.workspace = workspace;
    this.sessionsDirectory = path.join(workspace, MIGENT_DIRNAME, SESSIONS_DIRNAME);
    this.processInspector = processInspector ?? new SystemProcessInspector();
    this.metricsProviders = metricsProviders ?? null;
  }

  loadOrCreate(
    provider: string,
    model: string,
    options: Record<string, string> | null,
    workspace: string,
    sessionId: string | null,
    stageId: string,
    stageAttempt: number | null,
    executionOrder: number | null,
    prompt: string,
    resumeExecutionId: string | null = null,
  ): [AgentSessionRecord, boolean, ExecutionContext] {
    if (resumeExecutionId !== null && sessionId === null) {
      throw new Error("Resuming an execution requires a session.");
    }
    if (sessionId !== null) this.reapOrphanedExecutions(sessionId, "raise");
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
        provider,
        model,
        options,
        sessionId,
        stageId,
        stageAttempt,
        executionOrder,
        prompt,
      );
      return [
        new AgentSessionRecord(provider, model, workspace, null, { ...(options ?? {}) }),
        true,
        context,
      ];
    }
    const raw = JSON.parse(readFileSync(previous.conversationReadPath, "utf8")) as unknown;
    const context = this.createExecution(
      provider,
      model,
      options,
      sessionId,
      stageId,
      stageAttempt,
      executionOrder,
      prompt,
      previous.executionId,
    );
    return [AgentSessionRecord.fromJson(raw, provider, model, workspace), false, context];
  }

  /** Start a verify-only execution. It has no prompt and no provider conversation. */
  openVerifyExecution(sessionId: string, stageId: string): ExecutionContext {
    this.ensureSessionIsRunnable(sessionId);
    return this.createExecution("", "", {}, sessionId, stageId, null, null, "", null, "verify");
  }

  clearVerifyTurn(context: ExecutionContext): void {
    rmSync(this.turnDirectory(context, 1), { recursive: true, force: true });
  }

  save(record: AgentSessionRecord, context: ExecutionContext): void {
    writeJsonAtomic(context.conversationPath, record.toJson());
  }

  saveExecution(
    context: ExecutionContext,
    record: AgentSessionRecord,
    status: string,
    error: string | null = null,
    outcome: StageOutcome | null = null,
    locked = false,
    extra: Record<string, unknown> | null = null,
  ): void {
    const filePath = path.join(context.directory, "execution.json");
    if (locked) {
      this.saveExecutionUnlocked(context, record, status, error, outcome, extra);
      return;
    }
    this.withExecutionLock(filePath, () => {
      this.saveExecutionUnlocked(context, record, status, error, outcome, extra);
    });
  }

  /** Merge fields into a running execution without touching status.json or events. */
  saveExecutionProgress(
    context: ExecutionContext,
    record: AgentSessionRecord,
    fields: Record<string, unknown>,
  ): void {
    const filePath = path.join(context.directory, "execution.json");
    this.withExecutionLock(filePath, () => {
      const metadata = readJsonObject(filePath);
      if (metadata.status !== "running") {
        throw new Error(`Execution ${context.executionId} is not running.`);
      }
      Object.assign(metadata, fields);
      metadata.agent_id = record.agentId;
      writeJsonAtomic(filePath, metadata);
    });
  }

  clearProcessEndpoint(context: ExecutionContext): void {
    const filePath = path.join(context.directory, "execution.json");
    this.withExecutionLock(filePath, () => {
      const metadata = readJsonObject(filePath);
      metadata.provider_endpoint = null;
      metadata.provider_pid = null;
      writeJsonAtomic(filePath, metadata);
    });
  }

  turnDirectory(context: ExecutionContext, turn: number): string {
    return path.join(context.directory, "turns", String(turn).padStart(2, "0"));
  }

  saveTurnResponse(context: ExecutionContext, turn: number, text: string): void {
    this.writeTurnFile(context, turn, "response.md", text);
  }

  saveTurnOutcome(context: ExecutionContext, turn: number, outcome: StageOutcome): void {
    this.writeTurnFile(context, turn, "outcome.json", `${JSON.stringify(outcome.toJson(), null, 2)}\n`);
  }

  saveTurnVerify(context: ExecutionContext, turn: number, report: string): string {
    this.writeTurnFile(context, turn, "verify.md", report);
    return path.posix.join("turns", String(turn).padStart(2, "0"), "verify.md");
  }

  private writeTurnFile(context: ExecutionContext, turn: number, name: string, text: string): void {
    const directory = this.turnDirectory(context, turn);
    mkdirSync(directory, { recursive: true });
    writeFileAtomic(path.join(directory, name), text);
  }

  /** Copy the passing turn's report next to the stage artifact. */
  publishVerifyReport(context: ExecutionContext, turn: number): void {
    mkdirSync(context.artifactDirectory, { recursive: true });
    copyFileSync(
      path.join(this.turnDirectory(context, turn), "verify.md"),
      path.join(context.artifactDirectory, VERIFY_ARTIFACT),
    );
  }

  /**
   * Carry the stage artifact of a verify-exhausted execution into a new one, so a repair
   * turn that only fixes code still finds it.
   */
  carryVerifyArtifact(previousArtifactDirectory: string, context: ExecutionContext, name: string): void {
    const source = path.join(previousArtifactDirectory, name);
    if (name === VERIFY_ARTIFACT || !nonemptyArtifact(source)) return;
    mkdirSync(context.artifactDirectory, { recursive: true });
    copyFileSync(source, path.join(context.artifactDirectory, name));
  }

  saveProcessMetadata(context: ExecutionContext, info: ProcessStartInfo): void {
    const filePath = path.join(context.directory, "execution.json");
    this.withExecutionLock(filePath, () => {
      const metadata = readJsonObject(filePath);
      Object.assign(metadata, processMetadataPayload(info));
      writeJsonAtomic(filePath, metadata);
    });
  }

  reapOrphanedExecutions(sessionId: string, onLiveOwner: string, inFlight?: ReadonlySet<string>): void {
    const skip = inFlight ?? inFlightBySession.get(sessionId);
    for (const context of this.executionContexts(sessionId)) {
      if (skip?.has(context.executionId)) continue;
      this.reapExecution(context, onLiveOwner);
    }
  }

  recordProviderEvent(context: ExecutionContext, event: Record<string, unknown>): void {
    const sessionDirectory = path.dirname(path.dirname(context.directory));
    appendRecordedEvent(sessionDirectory, event);
    const name = String(event.event);
    if (!STATUS_PROVIDER_EVENTS.has(name) || skipsStatusWrite(name)) return;
    commitFoldedStatus(this.workspace, sessionDirectory);
  }

  executionContext(sessionId: string, executionId: string): ExecutionContext | null {
    const directory = path.join(this.sessionsDirectory, sessionId, EXECUTIONS_DIRNAME, executionId);
    try {
      if (!statSync(directory).isDirectory()) return null;
    } catch {
      return null;
    }
    return new ExecutionContext(sessionId, executionId, directory);
  }

  latestExecution(sessionId: string): ExecutionContext | null {
    const contexts = this.executionContexts(sessionId);
    if (contexts.length === 0) return null;
    return contexts.reduce((best, context) =>
      compareSortKey(this.executionSortKey(context), this.executionSortKey(best)) > 0 ? context : best,
    );
  }

  stageId(context: ExecutionContext): string {
    const metadata = readJsonObject(path.join(context.directory, "execution.json"));
    const stageId = metadata.stage_id;
    if (typeof stageId !== "string") throw new Error(`Execution ${context.executionId} has no stage_id.`);
    return stageId;
  }

  readSessionStatus(sessionId: string): Record<string, unknown> {
    return this.readSessionStatusAt(path.join(this.sessionsDirectory, sessionId));
  }

  /** Latest blocked execution of each stage, in resume order. */
  blockedStages(sessionId: string): { executionId: string; stageId: string }[] {
    return this.blockedStageRows(sessionId).map((row) => ({
      executionId: row.executionId,
      stageId: row.stageId,
    }));
  }

  /**
   * Record that continue is running blocked stages again. The caller holds the session lock.
   * `stageId` resumes that stage only. Other blocked stages stay blocked.
   */
  resumeBlockedSession(sessionId: string, stageId: string | null = null): { executionId: string; stageId: string }[] {
    const sessionDirectory = path.join(this.sessionsDirectory, sessionId);
    assertSessionLockHeld(sessionDirectory);
    const status = this.readSessionStatus(sessionId);
    if (status.status !== "blocked") {
      throw new ConfigurationError(`Session ${sessionId} is ${String(status.status)}, not blocked.`);
    }
    const blocked = this.blockedStageRows(sessionId);
    if (blocked.length === 0) {
      throw new ConfigurationError(`Session ${sessionId} is blocked without an execution.`);
    }
    const targets =
      stageId === null ? blocked : blocked.filter((row) => row.stageId === stageId);
    if (stageId !== null && targets.length === 0) {
      const names = blocked.map((row) => row.stageId).join(", ");
      throw new ConfigurationError(`Stage ${stageId} is not blocked. Blocked stages: ${names}.`);
    }
    const timestamp = utcNow();
    for (const target of targets) {
      const data: Record<string, unknown> = { from: "blocked" };
      const blocker = target.blocker ?? (targets.length === 1 ? textField(status.blocker) : null);
      if (blocker) data.blocker = blocker;
      appendLifecycleEvent(sessionDirectory, {
        event: "session.active",
        timestamp,
        executionId: target.executionId,
        stageId: target.stageId || null,
        data,
      });
    }
    this.rewriteManifestStatus(sessionDirectory, "running");
    const folded = commitFoldedStatus(this.workspace, sessionDirectory);
    if (folded.status !== "active") {
      throw new ConfigurationError(`Session ${sessionId} stayed ${String(folded.status)} after resume.`);
    }
    return targets.map((target) => ({ executionId: target.executionId, stageId: target.stageId }));
  }

  /**
   * Append `session.active` with `data.from: failed` for each failed non-verify stage.
   * Does not rewrite the manifest or commit the fold. The session need not be active.
   */
  markFailedResumes(sessionId: string, stageId: string | null = null): void {
    const sessionDirectory = path.join(this.sessionsDirectory, sessionId);
    assertSessionLockHeld(sessionDirectory);
    const latest = new Map<string, ExecutionSnapshot>();
    for (const snapshot of this.executionSnapshots(sessionId)) {
      const current = latest.get(snapshot.stageId);
      if (current === undefined || snapshot.executionOrder > current.executionOrder) {
        latest.set(snapshot.stageId, snapshot);
      }
    }
    const timestamp = utcNow();
    for (const snapshot of latest.values()) {
      if (stageId !== null && snapshot.stageId !== stageId) continue;
      if (snapshot.status !== "failed") continue;
      if (snapshot.failureReason === "verify_exhausted" || snapshot.failureReason === "verify_failed") continue;
      appendLifecycleEvent(sessionDirectory, {
        event: "session.active",
        timestamp,
        executionId: snapshot.executionId,
        stageId: snapshot.stageId || null,
        data: { from: "failed" },
      });
    }
  }

  private blockedStageRows(
    sessionId: string,
  ): { executionId: string; stageId: string; blocker: string | null }[] {
    const status = this.readSessionStatus(sessionId);
    const workflow = this.loadWorkflow(status);
    return blockedExecutions(
      statusExecutionsFromSnapshots(this.snapshotList(sessionId)),
      status,
      workflow,
    ).map((row) => ({
      executionId: row.executionId,
      stageId: row.stageId,
      blocker: this.executionBlocker(sessionId, row.executionId),
    }));
  }

  /**
   * Reopen every cancelled execution in place. The caller holds the session lock.
   * Execution ids and stage attempts stay the same.
   */
  reopenCancelledExecutions(
    sessionId: string,
    latestPerStage = false,
  ): { executionId: string; stageId: string }[] {
    const sessionDirectory = path.join(this.sessionsDirectory, sessionId);
    assertSessionLockHeld(sessionDirectory);
    const status = this.readSessionStatus(sessionId);
    // A blocked session is not cancelled. Continue still reopens each stage's latest cancelled execution.
    if (!latestPerStage && status.status !== "cancelled") {
      throw new ConfigurationError(`Session ${sessionId} is ${String(status.status)}, not cancelled.`);
    }
    const rows = this.executionContexts(sessionId).map((context) => {
      const metadata = readJsonObject(path.join(context.directory, "execution.json"));
      return { context, metadata, order: asInt(metadata.execution_order) };
    });
    const selected = latestPerStage ? latestExecutionPerStage(rows) : rows;
    const cancelled = selected
      .filter((item) => item.metadata.status === "cancelled")
      .sort((left, right) =>
        compareSortKey([left.order, left.context.executionId], [right.order, right.context.executionId]),
      );
    if (cancelled.length === 0) {
      if (latestPerStage) return [];
      throw new ConfigurationError(`Session ${sessionId} is cancelled without an execution.`);
    }
    for (const item of cancelled) {
      if (item.metadata.kind === "verify") continue;
      if (!existsSync(item.context.conversationReadPath)) {
        throw new ConfigurationError(`Execution ${item.context.executionId} has no conversation to resume.`);
      }
    }
    const reopened: { executionId: string; stageId: string }[] = [];
    const timestamp = utcNow();
    for (const item of cancelled) {
      const metadata = item.metadata;
      const context = item.context;
      metadata.status = "running";
      metadata.completed_at = null;
      writeJsonAtomic(path.join(context.directory, "execution.json"), metadata);
      if (metadata.kind !== "verify") {
        const provider = typeof metadata.provider === "string" ? metadata.provider : "";
        const model = typeof metadata.model === "string" ? metadata.model : "";
        const raw = JSON.parse(readFileSync(context.conversationReadPath, "utf8")) as unknown;
        const record = AgentSessionRecord.fromJson(raw, provider, model, this.workspace);
        record.status = "running";
        this.save(record, context);
      }
      const stageId = typeof metadata.stage_id === "string" ? metadata.stage_id : "";
      appendLifecycleEvent(sessionDirectory, {
        event: "execution.running",
        timestamp,
        executionId: context.executionId,
        stageId: stageId || null,
        data: {
          outcome: null,
          failure_reason: null,
          error: null,
          session_status: "active",
        },
      });
      appendLifecycleEvent(sessionDirectory, {
        event: "session.active",
        timestamp,
        executionId: context.executionId,
        stageId: stageId || null,
        data: { from: "cancelled" },
      });
      reopened.push({ executionId: context.executionId, stageId });
    }
    this.rewriteManifestStatus(sessionDirectory, "running");
    const folded = commitFoldedStatus(this.workspace, sessionDirectory);
    if (folded.status !== "active") {
      throw new ConfigurationError(`Session ${sessionId} stayed ${String(folded.status)} after resume.`);
    }
    return reopened;
  }

  resetRevisionCounts(sessionId: string, snapshots: readonly ExecutionSnapshot[]): void {
    const sessionDirectory = path.join(this.sessionsDirectory, sessionId);
    assertSessionLockHeld(sessionDirectory);
    const counts: Record<string, number> = {};
    for (const snapshot of snapshots) {
      if (snapshot.status === "completed" && snapshot.outcomeStatus === "complete") {
        counts[snapshot.stageId] = (counts[snapshot.stageId] ?? 0) + 1;
      }
    }
    appendLifecycleEvent(sessionDirectory, {
      event: "revisions.reset",
      timestamp: utcNow(),
      data: { baselines: counts },
    });
    commitFoldedStatus(this.workspace, sessionDirectory);
  }

  executionSnapshots(sessionId: string): ExecutionSnapshot[] {
    return this.snapshotList(sessionId);
  }

  missingCompletionOutputs(context: ExecutionContext, outcome: StageOutcome | null): string[] {
    const sessionDirectory = path.dirname(path.dirname(context.directory));
    const previousStatus = this.readSessionStatusAt(sessionDirectory);
    const workflow = this.loadWorkflow(previousStatus);
    if (workflow === null) return [];
    const workflowId = previousStatus.workflow_id;
    if (
      !shouldPublishOutputs({
        workflowId: typeof workflowId === "string" ? workflowId : null,
        executionStatus: "completed",
        outcome,
        workflow,
        stageId: this.stageId(context),
      })
    ) {
      return [];
    }
    const metadata = readJsonObject(path.join(context.directory, "execution.json"));
    return missingCompletionOutputNames({
      workflow,
      snapshots: this.snapshotList(context.sessionId),
      beforeOrder: asInt(metadata.execution_order),
    });
  }

  savePrompt(context: ExecutionContext, prompt: string): void {
    writeFileAtomic(path.join(context.directory, "prompt.md"), prompt);
  }

  saveResponse(context: ExecutionContext, responseText: string): void {
    writeFileAtomic(path.join(context.directory, "response.md"), responseText);
  }

  private saveExecutionUnlocked(
    context: ExecutionContext,
    record: AgentSessionRecord,
    status: string,
    error: string | null,
    outcome: StageOutcome | null,
    extra: Record<string, unknown> | null = null,
  ): void {
    const filePath = path.join(context.directory, "execution.json");
    const metadata = readJsonObject(filePath);
    const existingStatus = metadata.status;
    if (existingStatus === "completed" || existingStatus === "failed" || existingStatus === "cancelled") {
      throw new Error(`Execution ${context.executionId} is immutable after it ended.`);
    }
    const sessionDirectory = path.dirname(path.dirname(context.directory));
    assertSessionLockHeld(sessionDirectory);
    const previousStatus = this.readSessionStatusAt(sessionDirectory);
    const workflow = this.loadWorkflow(previousStatus);
    const manifest = readSessionManifest(sessionDirectory);
    const stageId = typeof metadata.stage_id === "string" ? metadata.stage_id : "";
    const executionOrder = asInt(metadata.execution_order);
    const timestamp = utcNow();
    metadata.status = status;
    metadata.agent_id = record.agentId;
    metadata.completed_at = status === "running" ? null : timestamp;
    if (error !== null) metadata.error = error;
    if (outcome !== null) metadata.outcome = outcome.toJson();
    if (extra !== null) Object.assign(metadata, extra);
    const storedError = typeof metadata.error === "string" ? metadata.error : null;
    const failureReason = typeof metadata.failure_reason === "string" ? metadata.failure_reason : null;
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
        event: "outputs.published",
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
      plan.sessionStatus === "completed" &&
      previousStatus.workflow_id !== "agent" &&
      this.metricsProviders !== null
    ) {
      sealSessionMetrics(this.workspace, context.sessionId, this.metricsProviders);
    }
    if (plan.outputsMissing.length > 0) throw new OutputsMissing(plan.outputsMissing);
  }

  private reapExecution(context: ExecutionContext, onLiveOwner: string): void {
    const filePath = path.join(context.directory, "execution.json");
    this.withExecutionLock(filePath, () => {
      const metadata = readJsonObject(filePath);
      const decision = classifyOrphanedExecution(metadata, context.directory, this.processInspector);
      if (decision.action === REAP_ALREADY_EXITED) {
        this.failOrphanedExecution(context, metadata, decision.error || "", true);
        return;
      }
      if (decision.action === REAP_STILL_RUNNING || decision.action === REAP_UNVERIFIED) {
        if (onLiveOwner === "raise") raiseReapDecision(decision);
      }
    });
  }

  private failOrphanedExecution(
    context: ExecutionContext,
    metadata: Record<string, unknown>,
    error: string,
    locked: boolean,
  ): void {
    let record = new AgentSessionRecord(
      typeof metadata.provider === "string" ? metadata.provider : "unknown",
      typeof metadata.model === "string" ? metadata.model : "unknown",
      this.workspace,
      typeof metadata.agent_id === "string" ? metadata.agent_id : null,
      stringOptions(metadata.options),
      "failed",
    );
    const conversationPath = context.conversationReadPath;
    if (existsSync(conversationPath)) {
      const raw = JSON.parse(readFileSync(conversationPath, "utf8")) as unknown;
      record = AgentSessionRecord.fromJson(raw, record.provider, record.model, record.workspace);
      record.status = "failed";
      this.save(record, context);
    }
    const extra = metadata.kind === "verify" ? { failure_reason: "verify_failed" } : null;
    this.saveExecution(context, record, "failed", error, null, locked, extra);
  }

  private withExecutionLock<T>(filePath: string, fn: () => T): T {
    if (!existsSync(filePath)) return fn();
    return withFileLockSync(filePath, fn);
  }

  private ensureSessionIsRunnable(sessionId: string | null): void {
    if (sessionId === null) return;
    const statusPath = path.join(this.sessionsDirectory, sessionId, "status.json");
    const read = readStatusFileState(statusPath);
    if (read.state === "corrupt") throw new ConfigurationError(corruptStatusMessage(statusPath));
    if (read.state === "missing") return;
    const status = read.status;
    const message = runnableViolation(sessionId, status);
    if (message) throw new Error(message);
  }

  private rewriteManifestStatus(sessionDirectory: string, status: string): void {
    if (readSessionManifest(sessionDirectory).schemaVersion >= 2) return;
    const manifestPath = path.join(sessionDirectory, "manifest.yaml");
    try {
      if (!statSync(manifestPath).isFile()) return;
    } catch {
      return;
    }
    const text = readFileSync(manifestPath, "utf8");
    const pattern = /^status: \S+\s*$/m;
    if (!pattern.test(text)) return;
    writeFileAtomic(manifestPath, text.replace(pattern, `status: ${status}`));
  }

  private loadWorkflow(previousStatus: Record<string, unknown>): WorkflowDocument | null {
    if (previousStatus.workflow_id === "agent") return null;
    const sessionId = previousStatus.session_id;
    if (typeof sessionId === "string" && sessionId !== "") {
      const frozen = loadFrozenWorkflow(path.join(this.sessionsDirectory, sessionId));
      if (frozen) return frozen;
    }
    const workflowPath = previousStatus.workflow_path;
    if (typeof workflowPath === "string" && workflowPath) {
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
    if (typeof workflowId !== "string" || workflowId === "") return null;
    try {
      return loadNamedWorkflow(this.workspace, workflowId);
    } catch (error) {
      if (error instanceof ConfigurationError) return null;
      throw error;
    }
  }

  private readSessionStatusAt(sessionDirectory: string): Record<string, unknown> {
    const statusPath = path.join(sessionDirectory, "status.json");
    const read = readStatusFileState(statusPath);
    if (read.state === "corrupt") throw new ConfigurationError(corruptStatusMessage(statusPath));
    return read.status;
  }

  private createExecution(
    provider: string,
    model: string,
    options: Record<string, string> | null,
    sessionId: string | null,
    stageId: string,
    stageAttempt: number | null,
    executionOrder: number | null,
    prompt: string,
    resumesExecutionId: string | null = null,
    kind: "verify" | null = null,
  ): ExecutionContext {
    const resolvedSession = sessionId ?? `session_${randomUUID().replaceAll("-", "")}`;
    const order = executionOrder ? executionOrder : this.nextExecutionOrder(resolvedSession);
    const attempt = stageAttempt ? stageAttempt : this.nextStageAttempt(resolvedSession, stageId);
    const executionId = `${String(order).padStart(4, "0")}-${safeComponent(stageId)}--attempt-${String(attempt).padStart(2, "0")}`;
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
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Execution already exists: ${directory}`);
      }
      throw error;
    }
    const taskSource = path.join(this.sessionsDirectory, resolvedSession, "task.md");
    if (existsSync(taskSource)) copyFileSync(taskSource, path.join(directory, "task.md"));
    const context = new ExecutionContext(resolvedSession, executionId, directory);
    mkdirSync(context.artifactDirectory);
    this.createSessionFiles(context);
    const verifyOnly = kind === "verify";
    if (!verifyOnly) writeFileAtomic(path.join(directory, "prompt.md"), prompt);
    const createdAt = utcNow();
    const sessionDirectory = path.dirname(path.dirname(directory));
    writeJsonAtomic(path.join(directory, "execution.json"), {
      session_id: resolvedSession,
      execution_id: executionId,
      execution_order: order,
      stage_id: stageId,
      stage_attempt: attempt,
      ...(verifyOnly ? { kind: "verify" } : {}),
      provider: verifyOnly ? null : provider,
      model: verifyOnly ? null : model,
      options: { ...(options ?? {}) },
      agent_id: null,
      resumes_execution_id: resumesExecutionId,
      status: "running",
      schema_version: EXECUTION_SCHEMA_VERSION,
      created_at: createdAt,
      artifact_directory: "artifacts",
    });
    appendLifecycleEvent(sessionDirectory, {
      event: "execution.started",
      timestamp: createdAt,
      executionId,
      stageId,
      data: {
        execution_order: order,
        stage_attempt: attempt,
        provider,
        model,
        resumes_execution_id: resumesExecutionId,
      },
    });
    commitFoldedStatus(this.workspace, sessionDirectory);
    return context;
  }

  private createSessionFiles(context: ExecutionContext): void {
    const sessionDirectory = path.dirname(path.dirname(context.directory));
    const manifestPath = path.join(sessionDirectory, "manifest.yaml");
    if (existsSync(manifestPath)) return;
    const createdAt = utcNow();
    writeFileAtomic(
      manifestPath,
      `${[`session_id: ${context.sessionId}`, `created_at: ${createdAt}`, "status: running"].join("\n")}\n`);
    appendLifecycleEvent(sessionDirectory, {
      event: "session.created",
      timestamp: createdAt,
      data: {},
    });
  }

  private nextExecutionOrder(sessionId: string): number {
    const sessionDirectory = path.join(this.sessionsDirectory, sessionId);
    const orders = [
      ...this.executionContexts(sessionId).map((context) => this.executionSortKey(context)[0]),
      ...reservedExecutionOrders(sessionDirectory),
    ];
    return Math.max(0, ...orders) + 1;
  }

  private nextStageAttempt(sessionId: string, stageId: string): number {
    const attempts: number[] = [];
    for (const context of this.executionContexts(sessionId)) {
      const metadata = readJsonObject(path.join(context.directory, "execution.json"));
      if (metadata.stage_id === stageId) attempts.push(asInt(metadata.stage_attempt));
    }
    let safe = stageId;
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

  private executionBlocker(sessionId: string, executionId: string): string | null {
    const context = this.executionContext(sessionId, executionId);
    if (context === null) return null;
    const outcome = readJsonObject(path.join(context.directory, "execution.json")).outcome;
    if (!isRecord(outcome)) return null;
    return textField(outcome.blocker);
  }

  private executionContexts(sessionId: string): ExecutionContext[] {
    const directory = path.join(this.sessionsDirectory, sessionId, EXECUTIONS_DIRNAME);
    if (!existsSync(directory)) return [];
    const contexts: ExecutionContext[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const executionDirectory = path.join(directory, entry.name);
      if (!existsSync(path.join(executionDirectory, "execution.json"))) continue;
      contexts.push(new ExecutionContext(sessionId, entry.name, executionDirectory));
    }
    return contexts;
  }

  private executionSortKey(context: ExecutionContext): [number, string] {
    const metadata = readJsonObject(path.join(context.directory, "execution.json"));
    return [asInt(metadata.execution_order), context.executionId];
  }

  private snapshotList(sessionId: string): ExecutionSnapshot[] {
    const snapshots: ExecutionSnapshot[] = [];
    for (const context of this.executionContexts(sessionId)) {
      const metadata = readJsonObject(path.join(context.directory, "execution.json"));
      const outcome = metadata.outcome;
      let outcomeStatus: string | null = null;
      let outcomeDecision: string | null = null;
      if (isRecord(outcome)) {
        if (typeof outcome.status === "string") outcomeStatus = outcome.status;
        if (typeof outcome.decision === "string" && outcome.decision) outcomeDecision = outcome.decision;
      }
      snapshots.push({
        executionId: context.executionId,
        stageId: typeof metadata.stage_id === "string" ? metadata.stage_id : "",
        executionOrder: asInt(metadata.execution_order),
        status: typeof metadata.status === "string" ? metadata.status : "",
        outcomeStatus,
        artifactDirectory: context.artifactDirectory,
        outcomeDecision,
        failureReason: typeof metadata.failure_reason === "string" ? metadata.failure_reason : null,
        verifyReport: verifyReportPath(context.directory, metadata.verify),
      });
    }
    return snapshots;
  }
}

function latestExecutionPerStage<
  T extends { context: { executionId: string }; metadata: Record<string, unknown>; order: number },
>(rows: readonly T[]): T[] {
  const byStage = new Map<string, T>();
  for (const row of rows) {
    const stageId = typeof row.metadata.stage_id === "string" ? row.metadata.stage_id : "";
    const current = byStage.get(stageId);
    if (
      current === undefined ||
      compareSortKey([row.order, row.context.executionId], [current.order, current.context.executionId]) > 0
    ) {
      byStage.set(stageId, row);
    }
  }
  return [...byStage.values()];
}

function snapshotsIncludingSave(
  snapshots: readonly ExecutionSnapshot[],
  saved: ExecutionSnapshot,
): ExecutionSnapshot[] {
  const included = snapshots.filter((snapshot) => snapshot.executionId !== saved.executionId);
  included.push(saved);
  return included;
}

function textField(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function verifyReportPath(directory: string, verify: unknown): string | null {
  if (!isRecord(verify) || typeof verify.last_report !== "string" || verify.last_report === "") {
    return null;
  }
  return path.join(directory, verify.last_report);
}

function nonempty(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return 0;
}

function readJsonObject(filePath: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (!isRecord(value)) throw new Error(`Expected a JSON object: ${filePath}`);
  return value;
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function compareSortKey(left: [number, string], right: [number, string]): number {
  if (left[0] !== right[0]) return left[0] - right[0];
  if (left[1] < right[1]) return -1;
  if (left[1] > right[1]) return 1;
  return 0;
}
