import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ConfigurationError } from "./errors.js";
import { STATUS_PROVIDER_EVENTS } from "./event-kinds.js";
import {
  missingCompletionOutputNames,
  nonemptyArtifact,
  publishOutputFiles,
  runnableViolation,
  selectSourceExecution,
  sessionStatusAfterExecution,
  shouldPublishOutputs,
  type ExecutionSnapshot,
  type PublishedOutput,
} from "./outputs.js";
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

const RUNNING_STATUS_KEYS = [
  "workflow_id",
  "workflow_path",
  "role",
  "task",
  "created_at",
  "prior_session_id",
  "latest_provider_event",
  "latest_decision",
  "latest_stage_id",
  "current_stage",
  "outputs",
  "workspace_id",
  "revision_baselines",
  "task_sha256",
] as const;

const SETTLED_STATUS_KEYS = [
  "workflow_id",
  "workflow_path",
  "role",
  "task",
  "created_at",
  "prior_session_id",
  "latest_provider_event",
  "latest_decision",
  "latest_stage_id",
  "outputs",
  "workspace_id",
  "revision_baselines",
  "task_sha256",
] as const;

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

export class SessionStore {
  readonly workspace: string;
  readonly sessionsDirectory: string;
  readonly processInspector: ProcessInspector;

  constructor(workspace: string, processInspector?: ProcessInspector) {
    this.workspace = workspace;
    this.sessionsDirectory = path.join(workspace, MIGENT_DIRNAME, SESSIONS_DIRNAME);
    this.processInspector = processInspector ?? new SystemProcessInspector();
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

  save(record: AgentSessionRecord, context: ExecutionContext): void {
    writeJson(context.conversationPath, record.toJson());
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
      writeJson(filePath, metadata);
    });
  }

  clearProcessEndpoint(context: ExecutionContext): void {
    const filePath = path.join(context.directory, "execution.json");
    this.withExecutionLock(filePath, () => {
      const metadata = readJsonObject(filePath);
      metadata.provider_endpoint = null;
      metadata.provider_pid = null;
      writeJson(filePath, metadata);
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
    writeFileSync(path.join(directory, name), text, "utf8");
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
      writeJson(filePath, metadata);
    });
  }

  reapOrphanedExecutions(sessionId: string, onLiveOwner: string): void {
    for (const context of this.executionContexts(sessionId)) {
      this.reapExecution(context, onLiveOwner);
    }
  }

  recordProviderEvent(context: ExecutionContext, event: Record<string, unknown>): void {
    const sessionDirectory = path.dirname(path.dirname(context.directory));
    this.appendEvent(sessionDirectory, event);
    if (!STATUS_PROVIDER_EVENTS.has(String(event.event))) return;
    const status = this.readSessionStatusAt(sessionDirectory);
    const timestamp = typeof event.timestamp === "string" ? event.timestamp : utcNow();
    status.latest_provider_event = event;
    status.current_stage = {
      execution_id: context.executionId,
      stage_id: event.stage_id,
      provider: event.provider,
      event: event.event,
      summary: event.summary ?? null,
      updated_at: timestamp,
    };
    status.updated_at = timestamp;
    writeJson(path.join(sessionDirectory, "status.json"), status);
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

  resetRevisionCounts(sessionId: string, snapshots: readonly ExecutionSnapshot[]): void {
    const sessionDirectory = path.join(this.sessionsDirectory, sessionId);
    const status = this.readSessionStatusAt(sessionDirectory);
    const counts: Record<string, number> = {};
    for (const snapshot of snapshots) {
      if (snapshot.status === "completed" && snapshot.outcomeStatus === "complete") {
        counts[snapshot.stageId] = (counts[snapshot.stageId] ?? 0) + 1;
      }
    }
    status.revision_baselines = counts;
    status.updated_at = utcNow();
    writeJson(path.join(sessionDirectory, "status.json"), status);
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
    writeFileSync(path.join(context.directory, "prompt.md"), prompt, "utf8");
  }

  saveResponse(context: ExecutionContext, responseText: string): void {
    writeFileSync(path.join(context.directory, "response.md"), responseText, "utf8");
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
    const previousStatus = this.readSessionStatusAt(sessionDirectory);
    const workflow = this.loadWorkflow(previousStatus);
    if (status === "running" && previousStatus.status === "completed") {
      this.rewriteManifestStatus(sessionDirectory, "running");
    }
    const published =
      status === "running"
        ? {}
        : this.publishedOutputs(context, status, outcome, previousStatus, workflow, metadata);
    metadata.status = status;
    metadata.agent_id = record.agentId;
    metadata.completed_at = status === "running" ? null : utcNow();
    if (error !== null) metadata.error = error;
    if (outcome !== null) metadata.outcome = outcome.toJson();
    if (extra !== null) Object.assign(metadata, extra);
    writeJson(filePath, metadata);
    const stageId = typeof metadata.stage_id === "string" ? metadata.stage_id : "";
    const sessionStatus = sessionStatusAfterExecution(
      status,
      outcome,
      previousStatus,
      workflow,
      stageId,
    );
    const outputs: Record<string, unknown> = {};
    if (isRecord(previousStatus.outputs)) Object.assign(outputs, previousStatus.outputs);
    Object.assign(outputs, published);
    const payload: Record<string, unknown> = {
      ...this.providerStatusFields(previousStatus, context, status),
      session_id: context.sessionId,
      status: sessionStatus,
      latest_execution_id: context.executionId,
      latest_execution_status: status,
      latest_stage_id: stageId,
      updated_at: utcNow(),
      ...this.terminalSessionDetails(context, outcome, sessionStatus),
    };
    let decision: string | null = null;
    if (outcome?.decision) decision = outcome.decision;
    else if (typeof previousStatus.latest_decision === "string" && previousStatus.latest_decision) {
      decision = previousStatus.latest_decision;
    }
    if (decision) payload.latest_decision = decision;
    if (Object.keys(outputs).length > 0) payload.outputs = outputs;
    writeJson(path.join(sessionDirectory, "status.json"), payload);
    this.appendEvent(sessionDirectory, {
      event: `execution.${status}`,
      execution_id: context.executionId,
      stage_id: metadata.stage_id,
      timestamp: utcNow(),
    });
    if (outcome !== null) {
      this.appendEvent(sessionDirectory, {
        event: `stage.${outcome.status}`,
        execution_id: context.executionId,
        stage_id: metadata.stage_id,
        timestamp: utcNow(),
        ...outcome.toJson(),
      });
    }
    if (sessionStatus !== "active") this.markSessionTerminal(context, sessionStatus, outcome);
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
    this.saveExecution(context, record, "failed", error, null, locked);
  }

  private withExecutionLock<T>(filePath: string, fn: () => T): T {
    if (!existsSync(filePath)) return fn();
    return withFileLockSync(filePath, fn);
  }

  private ensureSessionIsRunnable(sessionId: string | null): void {
    if (sessionId === null) return;
    const statusPath = path.join(this.sessionsDirectory, sessionId, "status.json");
    if (!existsSync(statusPath)) return;
    const status = JSON.parse(readFileSync(statusPath, "utf8")) as unknown;
    if (!isRecord(status)) return;
    const message = runnableViolation(sessionId, status);
    if (message) throw new Error(message);
  }

  private terminalSessionDetails(
    context: ExecutionContext,
    outcome: StageOutcome | null,
    sessionStatus: string,
  ): Record<string, string> {
    if (sessionStatus === "blocked") {
      const details: Record<string, string> = {
        terminal_execution_id: context.executionId,
        blocked_by_execution_id: context.executionId,
        blocked_by_stage_id: this.stageId(context),
      };
      if (outcome?.blocker) details.blocker = outcome.blocker;
      return details;
    }
    if (sessionStatus === "cancelled" || sessionStatus === "completed") {
      return { terminal_execution_id: context.executionId };
    }
    return {};
  }

  private rewriteManifestStatus(sessionDirectory: string, status: string): void {
    const manifestPath = path.join(sessionDirectory, "manifest.yaml");
    try {
      if (!statSync(manifestPath).isFile()) return;
    } catch {
      return;
    }
    const text = readFileSync(manifestPath, "utf8");
    const pattern = /^status: \S+\s*$/m;
    if (!pattern.test(text)) return;
    writeFileSync(manifestPath, text.replace(pattern, `status: ${status}`), "utf8");
  }

  private loadWorkflow(previousStatus: Record<string, unknown>): WorkflowDocument | null {
    if (previousStatus.workflow_id === "agent") return null;
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

  private markSessionTerminal(
    context: ExecutionContext,
    status: string,
    outcome: StageOutcome | null,
  ): void {
    const sessionDirectory = path.dirname(path.dirname(context.directory));
    this.rewriteManifestStatus(sessionDirectory, status);
    this.appendEvent(sessionDirectory, {
      event: `session.${status}`,
      execution_id: context.executionId,
      stage_id: this.stageId(context),
      timestamp: utcNow(),
      ...(outcome ? outcome.toJson() : {}),
    });
  }

  private readSessionStatusAt(sessionDirectory: string): Record<string, unknown> {
    const statusPath = path.join(sessionDirectory, "status.json");
    if (!existsSync(statusPath)) return {};
    return readJsonObject(statusPath);
  }

  private providerStatusFields(
    previousStatus: Record<string, unknown>,
    context: ExecutionContext,
    status: string,
  ): Record<string, unknown> {
    if (status === "running") return pick(previousStatus, RUNNING_STATUS_KEYS);
    const currentStage = previousStatus.current_stage;
    if (isRecord(currentStage) && currentStage.execution_id !== context.executionId) {
      const preserved: Record<string, unknown> = { current_stage: currentStage };
      if (isRecord(previousStatus.outputs)) preserved.outputs = previousStatus.outputs;
      if (Object.hasOwn(previousStatus, "workspace_id")) preserved.workspace_id = previousStatus.workspace_id;
      if (Object.hasOwn(previousStatus, "revision_baselines")) {
        preserved.revision_baselines = previousStatus.revision_baselines;
      }
      if (Object.hasOwn(previousStatus, "task_sha256")) preserved.task_sha256 = previousStatus.task_sha256;
      return preserved;
    }
    return pick(previousStatus, SETTLED_STATUS_KEYS);
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
    if (existsSync(directory)) throw new Error(`Execution already exists: ${directory}`);
    mkdirSync(directory, { recursive: true });
    const taskSource = path.join(this.sessionsDirectory, resolvedSession, "task.md");
    if (existsSync(taskSource)) copyFileSync(taskSource, path.join(directory, "task.md"));
    const context = new ExecutionContext(resolvedSession, executionId, directory);
    mkdirSync(context.artifactDirectory);
    this.createSessionFiles(context);
    writeFileSync(path.join(directory, "prompt.md"), prompt, "utf8");
    writeJson(path.join(directory, "execution.json"), {
      session_id: resolvedSession,
      execution_id: executionId,
      execution_order: order,
      stage_id: stageId,
      stage_attempt: attempt,
      provider,
      model,
      options: { ...(options ?? {}) },
      agent_id: null,
      resumes_execution_id: resumesExecutionId,
      status: "running",
      schema_version: EXECUTION_SCHEMA_VERSION,
      created_at: utcNow(),
      artifact_directory: "artifacts",
    });
    this.appendEvent(path.dirname(path.dirname(directory)), {
      event: "execution.started",
      execution_id: executionId,
      stage_id: stageId,
      timestamp: utcNow(),
    });
    return context;
  }

  private createSessionFiles(context: ExecutionContext): void {
    const sessionDirectory = path.dirname(path.dirname(context.directory));
    const manifestPath = path.join(sessionDirectory, "manifest.yaml");
    if (existsSync(manifestPath)) return;
    writeFileSync(
      manifestPath,
      `${[`session_id: ${context.sessionId}`, `created_at: ${utcNow()}`, "status: running"].join("\n")}\n`,
      "utf8",
    );
    writeJson(path.join(sessionDirectory, "status.json"), {
      session_id: context.sessionId,
      status: "active",
      latest_execution_id: context.executionId,
      latest_execution_status: "running",
      updated_at: utcNow(),
    });
  }

  private nextExecutionOrder(sessionId: string): number {
    const orders = this.executionContexts(sessionId).map((context) => this.executionSortKey(context)[0]);
    return Math.max(0, ...orders) + 1;
  }

  private nextStageAttempt(sessionId: string, stageId: string): number {
    const attempts: number[] = [];
    for (const context of this.executionContexts(sessionId)) {
      const metadata = readJsonObject(path.join(context.directory, "execution.json"));
      if (metadata.stage_id === stageId) attempts.push(asInt(metadata.stage_attempt));
    }
    return Math.max(0, ...attempts) + 1;
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

  private publishedOutputs(
    context: ExecutionContext,
    status: string,
    outcome: StageOutcome | null,
    previousStatus: Record<string, unknown>,
    workflow: WorkflowDocument | null,
    metadata: Record<string, unknown>,
  ): Record<string, Record<string, string>> {
    if (workflow === null) return {};
    const sessionDirectory = path.dirname(path.dirname(context.directory));
    const stageId = typeof metadata.stage_id === "string" ? metadata.stage_id : "";
    const workflowId = previousStatus.workflow_id;
    if (
      !shouldPublishOutputs({
        workflowId: typeof workflowId === "string" ? workflowId : null,
        executionStatus: status,
        outcome,
        workflow,
        stageId,
      })
    ) {
      return {};
    }
    const completion = workflow.completion;
    if (completion === null) return {};
    const beforeOrder = asInt(metadata.execution_order);
    const snapshots = this.snapshotList(context.sessionId);
    const sources: Record<string, readonly [string, string]> = {};
    for (const output of completion.outputs) {
      const source = selectSourceExecution(snapshots, output.fromStage, beforeOrder);
      if (source === null) continue;
      sources[output.name] = [path.join(source.artifactDirectory, output.artifact), source.executionId];
    }
    return publishedJson(publishOutputFiles(sessionDirectory, sources, context.executionId));
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

  private appendEvent(sessionDirectory: string, event: Record<string, unknown>): void {
    appendFileSync(path.join(sessionDirectory, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
  }
}

function verifyReportPath(directory: string, verify: unknown): string | null {
  if (!isRecord(verify) || typeof verify.last_report !== "string" || verify.last_report === "") {
    return null;
  }
  return path.join(directory, verify.last_report);
}

function publishedJson(
  recorded: Record<string, PublishedOutput>,
): Record<string, Record<string, string>> {
  const outputs: Record<string, Record<string, string>> = {};
  for (const [name, output] of Object.entries(recorded)) {
    outputs[name] = {
      path: output.path,
      source_execution_id: output.sourceExecutionId,
      published_by_execution_id: output.publishedByExecutionId,
    };
  }
  return outputs;
}

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key)) picked[key] = source[key];
  }
  return picked;
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

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
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
