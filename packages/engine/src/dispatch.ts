import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { ClientRegistry, ExecutionSnapshot, ScheduleState } from '@nodeint/migent-kernel';
import { loadRoleResponsibilities, loadWorkspaceConfig, resolveStageTarget, type StageTarget } from '@nodeint/migent-kernel';
import { ConfigurationError } from '@nodeint/migent-kernel';
import { buildStagePrompt, buildStageReplyPrompt, buildStageResumePrompt, buildVerifyRepairPrompt } from '@nodeint/migent-kernel';
import { formatClock, formatDuration, log } from '@nodeint/migent-kernel';
import {
  missingOutputProducers,
  NextStage,
  nextStage,
  NextStageError,
  revisionResumeExecution,
  stageAgentExecution,
  stageDispatchError,
  stagePromptAlreadyDelivered,
  Stop,
  VERIFY_FAILED,
  verifyExhaustedExecution,
} from '@nodeint/migent-kernel';
import type { TurnKind } from '@nodeint/migent-prompts';
import { frozenRoleInstructions, frozenStageTarget, readWorkflowFreeze } from '@nodeint/migent-session';
import { commitFoldedStatus, parseExecutionId, readParsedEvents } from '@nodeint/migent-session';
import { freezeSessionTask } from '@nodeint/migent-session';
import { bindPriorSessionId, createWorkflowSession } from '@nodeint/migent-session';
import { SessionStore,stringOptions } from '@nodeint/migent-session';
import { isRecord } from '@nodeint/migent-workflow';
import { isRoleStage, loadNamedWorkflow, type StageSpec, type WorkflowDocument } from '@nodeint/migent-workflow';

import { AgentToolRunner, type RunResult } from './agent-runner.js';
import { ensureSessionBaseline, evaluateRunWhen } from './run-when.js';
import { runVerifyOnlyStage } from './verify-only.js';

export interface StageDispatchRequest {
  workflowId: string;
  stageId: string;
  prompt: string;
  /** What the prompt is; it picks the closing instruction. */
  turn?: TurnKind | null;
  task?: string | null;
  sessionId?: string | null;
  priorSessionId?: string | null;
  client?: string | null;
  model?: string | null;
  options?: Record<string, string> | null;
  stageAttempt?: number | null;
  executionOrder?: number | null;
}

export interface StageDispatchInit {
  sessionId: string;
  executionId: string;
  outcomeStatus: string;
  outcomeDecision: string;
  sessionStatus: string;
  response: string;
  agentId?: string;
  options?: Record<string, string>;
  artifactDirectory?: string;
  failureReason?: string;
  failureKind?: string;
  resetAt?: string;
  client?: string;
  executionStatus?: string;
}

export class StageDispatchResult {
  public readonly sessionId: string;
  public readonly executionId: string;
  public readonly outcomeStatus: string;
  public readonly outcomeDecision: string;
  public readonly sessionStatus: string;
  public readonly response: string;
  public readonly agentId: string;
  public readonly options: Record<string, string>;
  public readonly artifactDirectory: string;
  public readonly failureReason: string;
  public readonly failureKind: string;
  public readonly resetAt: string;
  public readonly client: string;
  public readonly executionStatus: string;

  constructor(init: StageDispatchInit) {
    this.sessionId = init.sessionId;
    this.executionId = init.executionId;
    this.outcomeStatus = init.outcomeStatus;
    this.outcomeDecision = init.outcomeDecision;
    this.sessionStatus = init.sessionStatus;
    this.response = init.response;
    this.agentId = init.agentId ?? '';
    this.options = init.options ?? {};
    this.artifactDirectory = init.artifactDirectory ?? '';
    this.failureReason = init.failureReason ?? '';
    this.failureKind = init.failureKind ?? '';
    this.resetAt = init.resetAt ?? '';
    this.client = init.client ?? '';
    this.executionStatus = init.executionStatus ?? '';
  }

  public toJson(): Record<string, unknown> {
    return {
      agent_id: this.agentId,
      options: { ...this.options },
      session_id: this.sessionId,
      execution_id: this.executionId,
      artifact_directory: this.artifactDirectory,
      failure_reason: this.failureReason,
      failure_kind: this.failureKind,
      reset_at: this.resetAt,
      client: this.client,
      outcome_status: this.outcomeStatus,
      outcome_decision: this.outcomeDecision,
      session_status: this.sessionStatus,
      response: this.response,
      execution_status: this.executionStatus,
    };
  }
}

export interface NamedStageRun {
  readonly runner: AgentToolRunner;
  readonly resolved?: { workflow: WorkflowDocument; target: StageTarget } | null;
  readonly onExecution?: (executionId: string) => void;
}

export async function dispatchNamedStage(
  workspace: string,
  request: StageDispatchRequest,
  run: NamedStageRun,
): Promise<StageDispatchResult> {
  const { runner, resolved, onExecution } = run;
  const activeRunner = runner;
  const {registry} = activeRunner;
  let loaded = resolved ?? loadDispatchTarget(workspace, request, registry);
  let {workflow} = loaded;
  let {target} = loaded;
  let sessionId = request.sessionId ?? null;
  if (sessionId === null) {
    sessionId = createWorkflowSession(
      workspace,
      workflow.id,
      { task: request.task, priorSessionId: request.priorSessionId, resolveClient: registry },
    );
    if (!resolved) {
      loaded = loadDispatchTarget(workspace, { ...request, sessionId }, registry);
      workflow = loaded.workflow;
      target = loaded.target;
    }
  } else {
    bindPriorSessionId(workspace, sessionId, request.priorSessionId);
  }
  assertStageDispatchable(workspace, workflow, { sessionId, stageId: request.stageId });
  const snapshots = new SessionStore(workspace).executionSnapshots(sessionId);
  const stage = workflow.stages[request.stageId];
  const ownAgent = stageAgentExecution(snapshots, request.stageId);
  const question = snapshots.find((row) => row.executionId === ownAgent && row.outcomeStatus === 'question');
  // A reply to a stopped turn continues that turn's own conversation, even for a resume_from stage.
  const interrupted = snapshots.find((row) => row.executionId === ownAgent && row.status === 'cancelled');
  let resumeExecutionId;
  if (question) resumeExecutionId = question.executionId;
  else if (interrupted) resumeExecutionId = interrupted.executionId;
  else if (stage?.resumeFrom) {
    resumeExecutionId = verifyExhaustedExecution(snapshots, request.stageId)?.executionId ??
      revisionResumeExecution(workflow, snapshots, request.stageId) ??
      resolveResumeExecution(workspace, workflow, { sessionId, stageId: request.stageId });
  } else resumeExecutionId = ownAgent;
  const result = await activeRunner.run({
    client: target.client,
    model: target.model,
    options: { ...target.options },
    prompt: request.prompt,
    turn: request.turn ?? null,
    workspace,
    sessionId,
    resumeExecutionId,
    stageId: request.stageId,
    stageAttempt: request.stageAttempt,
    executionOrder: request.executionOrder,
    onExecution,
  });
  return resultFromRun(result, sessionId);
}

export function assertStageDispatchable(
  workspace: string,
  workflow: WorkflowDocument,
  target: { sessionId: string; stageId: string },
): void {
  const { sessionId, stageId } = target;
  const store = new SessionStore(workspace);
  const snapshots = store.executionSnapshots(sessionId);
  const status = store.readSessionStatus(sessionId);
  const sessionStatus = typeof status.status === 'string' ? status.status : 'active';
  // continue reruns a producer whose artifact is missing after the branch ended.
  if (missingOutputProducers(workflow, snapshots, sessionStatus).includes(stageId)) return;
  const error = stageDispatchError(workflow, stageId, snapshots);
  if (error) throw new ConfigurationError(error);
}

export function resolveResumeExecution(
  workspace: string,
  workflow: WorkflowDocument,
  target: { sessionId: string; stageId: string },
): string | null {
  const { sessionId, stageId } = target;
  const stage = workflow.stages[stageId];
  if (stage === undefined || !stage.resumeFrom) return null;
  const snapshots = new SessionStore(workspace).executionSnapshots(sessionId);
  let latest: (typeof snapshots)[number] | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.stageId !== stage.resumeFrom) continue;
    if (snapshot.status !== 'completed' || snapshot.outcomeStatus !== 'complete') continue;
    if (latest === null || snapshot.executionOrder > latest.executionOrder) latest = snapshot;
  }
  if (latest === null) {
    throw new ConfigurationError(
      `Stage ${stageId} resumes ${stage.resumeFrom}, which has no completed execution.`,
    );
  }
  return latest.executionId;
}

function loadDispatchTarget(
  workspace: string,
  request: StageDispatchRequest,
  registry: ClientRegistry,
): { workflow: WorkflowDocument; target: StageTarget } {
  const sessionId = request.sessionId ?? null;
  const override = { client: request.client, model: request.model, options: request.options };
  if (sessionId) {
    const freeze = readWorkflowFreeze(path.join(workspace, '.migent', 'sessions', sessionId));
    if (freeze) {
      return { workflow: freeze.workflow, target: frozenStageTarget(freeze, request.stageId, override) };
    }
  }
  const workflow = loadNamedWorkflow(workspace, request.workflowId);
  return {
    workflow,
    target: resolveStageTarget(
      workspace,
      { workflowId: workflow.id, stageId: request.stageId },
      { override, registry },
    ),
  };
}

function resultFromRun(result: RunResult, sessionId: string): StageDispatchResult {
  return new StageDispatchResult({
    sessionId: result.session_id || sessionId,
    executionId: result.execution_id || '',
    outcomeStatus: result.outcome_status || '',
    outcomeDecision: result.outcome_decision || '',
    sessionStatus: result.session_status || '',
    response: result.response || '',
    agentId: result.agent_id || '',
    options: isRecord(result.options) ? stringOptions(result.options) : {},
    artifactDirectory: result.artifact_directory || '',
    failureReason: result.failure_reason || '',
    failureKind: result.failure_kind || '',
    resetAt: result.reset_at || '',
    client: result.client || '',
    executionStatus: result.execution_status || '',
  });
}

export const EXECUTE_EXIT_CODES:Record<string, number> = {
  completed: 0,
  blocked: 1,
  question: 9,
  cancelled: 130,
  stage_failed: 3,
  revisions_exhausted: 4,
  dispatch_limit: 5,
  verify_exhausted: 6,
  verify_failed: 7,
  quota: 8,
  stage: 0,
};

export const TERMINAL_SESSION_STATUSES = new Set(['completed', 'blocked', 'question', 'cancelled']);

/**
 * A human reply waiting for its stage. The stage that receives it takes the text once; the
 * run asks `consumed` afterwards to learn whether the reply was sent.
 */
export class PendingStageReply {
  public readonly stageId: string;
  private pending: string | null;

  constructor(stageId: string, text: string) {
    this.stageId = stageId;
    this.pending = text;
  }

  public get consumed(): boolean {
    return this.pending === null;
  }

  /** The reply text when it is addressed to `stageId` and not yet taken; null otherwise. */
  public take(stageId: string): string | null {
    if (this.stageId !== stageId || this.pending === null) return null;
    const text = this.pending;
    this.pending = null;
    return text;
  }
}

export interface ExecuteResult {
  code: number;
  status: string;
  stopReason: string;
  sessionId: string;
  latestDecision: string | null;
  latestExecutionId: string | null;
  outputs: Record<string, unknown>;
  stages: Record<string, unknown>[];
}

export function selectedStage(
  workflow: WorkflowDocument,
  snapshots: readonly ExecutionSnapshot[],
  state: ScheduleState,
): NextStage | Stop {
  const selected = nextStage(workflow, snapshots, state);
  if (selected instanceof NextStageError) throw new ConfigurationError(selected.message);
  if (selected instanceof NextStage || selected instanceof Stop) return selected;
  throw new ConfigurationError('no eligible stage');
}

export function blockResumes(
  workspace: string,
  sessionId: string,
): Pick<ReturnType<typeof readParsedEvents>[number], 'event' | 'executionId' | 'data'>[] {
  return readParsedEvents(path.join(workspace, '.migent', 'sessions', sessionId, 'events.jsonl')).map((event) => ({
    event: event.event,
    executionId: event.executionId,
    data: event.data,
  }));
}

export function roleStartLine(
  stageId: string,
  target: { client: string; model: string; optionLabel: string },
  detail: { description: string | null; attempt: number | null },
): string {
  const { client, model, optionLabel } = target;
  const { description, attempt } = detail;
  const parts = [`stage ${stageId}`];
  if (attempt !== null) parts.push(`attempt ${attempt}`);
  parts.push(formatClock(), `${client}/${model} (${optionLabel})`);
  const base = parts.join(' · ');
  if (description === null) return `${base}.`;
  return `${base} — ${description}.`;
}

export function stageFinishLine(
  session: { workspace: string; sessionId: string },
  stage: { stageId: string; executionId: string },
  result: { outcome: string; decision: string },
): string {
  const { workspace, sessionId } = session;
  const { stageId, executionId } = stage;
  const { outcome, decision } = result;
  const parts = [`stage ${stageId}`];
  const attempt = parseExecutionId(executionId)?.attempt;
  if (attempt !== undefined) parts.push(`attempt ${attempt}`);
  const duration = stageDurationLabel(workspace, sessionId, executionId);
  if (duration !== null) parts.push(duration);
  const tail = decision ? `${outcome} decision=${decision}` : outcome;
  return `${parts.join(' · ')} · ${tail}.`;
}

function stageDurationLabel(workspace: string, sessionId: string, executionId: string): string | null {
  if (executionId === '') return null;
  const filePath = path.join(
    workspace,
    '.migent',
    'sessions',
    sessionId,
    'executions',
    executionId,
    'execution.json',
  );
  const elapsed = elapsedMs(readExecutionTimes(filePath));
  return elapsed === null ? null : formatDuration(elapsed);
}

function readExecutionTimes(filePath: string): { started: number | null; finished: number | null } {
  try {
    const metadata = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!isRecord(metadata)) return { started: null, finished: null };
    return {
      started: parsedTime(metadata.created_at),
      finished: parsedTime(metadata.completed_at),
    };
  } catch {
    return { started: null, finished: null };
  }
}

function elapsedMs(times: { started: number | null; finished: number | null }): number | null {
  if (times.started === null) return null;
  return (times.finished ?? Date.now()) - times.started;
}

function parsedTime(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** What every step of one execute run shares. */
export interface ExecuteRun {
  readonly workspace: string;
  readonly store: SessionStore;
  readonly workflow: WorkflowDocument;
  readonly workflowId: string;
  readonly sessionId: string;
  readonly runner: AgentToolRunner;
  readonly tasks: Map<string, Promise<unknown>>;
  readonly reply: PendingStageReply | null;
}

/** The stage to dispatch, with the session status and executions read just before it. */
export interface StageDispatchTarget {
  readonly stageId: string;
  readonly status: Record<string, unknown>;
  readonly snapshots: readonly ExecutionSnapshot[];
}

export async function dispatchExecuteStage(
  run: Pick<ExecuteRun, 'workspace' | 'workflow' | 'workflowId' | 'sessionId' | 'runner' | 'reply'>,
  dispatch: StageDispatchTarget,
  onExecution?: (executionId: string) => void,
): Promise<Record<string, unknown>> {
  const { workspace, workflow, workflowId, sessionId, runner, reply } = run;
  const { stageId, status, snapshots } = dispatch;
  const stageSpec = workflow.stages[stageId];
  if (stageSpec === undefined) throw new ConfigurationError(`Stage not found: ${stageId}`);
  // Runs before the first await so two starts in one pool turn cannot both capture the baseline.
  if (ensureSessionBaseline(workspace, sessionId, workflow)) {
    commitFoldedStatus(workspace, path.join(workspace, '.migent', 'sessions', sessionId));
  }
  const skipped = skipUnlessRunWhenMatches({ workspace, sessionId, runner }, stageSpec, snapshots);
  if (skipped !== null) return skipped;
  if (!isRoleStage(stageSpec)) {
    const result = await runVerifyOnlyStage({
      workspace,
      sessionId,
      stage: stageSpec,
      verifyRunner: runner.verifyRunner,
      clients: runner.registry,
      onExecution,
    });
    const outcome = result.failure_reason === VERIFY_FAILED ? 'verify_failed' : 'complete';
    log(stageFinishLine({ workspace, sessionId }, { stageId, executionId: result.execution_id }, { outcome, decision: '' }));
    return { ...result };
  }
  const sessionDirectory = path.join(workspace, '.migent', 'sessions', sessionId);
  const freeze = readWorkflowFreeze(sessionDirectory);
  const target = freeze
    ? frozenStageTarget(freeze, stageId)
    : resolveStageTarget(workspace, { workflowId, stageId }, { registry: runner.registry });
  const optionLabel =
    Object.entries(target.options)
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ') || 'default';
  const priorSessionId = storedPriorSessionId(status);
  const frozen = freezeSessionTask(workspace, sessionId);
  const exhausted = verifyExhaustedExecution(snapshots, stageId);
  const roleInstructions = freeze
    ? frozenRoleInstructions(freeze, stageSpec.role)
    : loadRoleResponsibilities(loadWorkspaceConfig(workspace), stageSpec.role);
  const promptInput = {
    workflow,
    stageId,
    taskFile: frozen.taskFile,
    sessionDirectory: frozen.sessionDirectory,
    snapshots,
    workspace,
    priorSessionId,
    priorOutputs: priorSessionOutputs(workspace, priorSessionId, sessionId),
    roleInstructions,
  };
  const stageReply = reply?.take(stageId) ?? null;
  const answers = stageReply !== null
    && new SessionStore(workspace).questionStages(sessionId).some((row) => row.stageId === stageId);
  const interrupted = stageReply !== null && interruptedExecutionId(snapshots, stageId) !== undefined;
  let turn: TurnKind;
  if (stageReply !== null) turn = answers && !interrupted ? 'answers' : 'reply';
  else if (exhausted?.verifyReport) turn = 'repair';
  else turn = stagePromptAlreadyDelivered(workflow, snapshots, stageId) ? 'continue' : 'start';
  let prompt;
  if (turn === 'answers' || turn === 'reply') {
    prompt = buildStageReplyPrompt(stageReply!, { answers, interrupted });
  } else if (turn === 'repair') {
    prompt = buildVerifyRepairPrompt(
      readFileSync(exhausted!.verifyReport!, 'utf8'),
      { red: stageSpec.maxVerify, maxVerify: stageSpec.maxVerify, artifactPath: null },
      { taskFile: frozen.taskFile, sessionDirectory: frozen.sessionDirectory },
    );
  } else prompt = turn === 'continue' ? buildStageResumePrompt(promptInput) : buildStagePrompt(promptInput);
  const request: StageDispatchRequest = {
    workflowId,
    stageId,
    prompt,
    turn,
    sessionId,
  };
  let loggedStart = false;
  const result: StageDispatchResult = await dispatchNamedStage(workspace, request, {
    runner,
    resolved: { workflow, target },
    onExecution: (executionId) => {
      onExecution?.(executionId);
      if (loggedStart) return;
      loggedStart = true;
      log(
        roleStartLine(
          stageId,
          { client: target.client, model: target.model, optionLabel },
          { description: stageSpec.description, attempt: parseExecutionId(executionId)?.attempt ?? null },
        ),
      );
    },
  });
  const outcome =
    result.outcomeStatus ||
    (result.failureReason || result.failureKind || result.executionStatus === 'failed' ? 'failed' : 'finished');
  log(
    stageFinishLine(
      { workspace, sessionId },
      { stageId, executionId: result.executionId },
      { outcome, decision: result.outcomeDecision },
    ),
  );
  return result.toJson();
}

/** A fresh visit of a run_when stage is evaluated. Retries and resumed blocks already passed the condition. */
export function skipUnlessRunWhenMatches(
  run: { workspace: string; sessionId: string; runner: AgentToolRunner },
  stage: StageSpec,
  snapshots: readonly ExecutionSnapshot[],
): Record<string, unknown> | null {
  const { workspace, sessionId, runner } = run;
  if ((stage.runWhen === null || stage.runWhen === undefined)) return null;
  let latest: ExecutionSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.stageId !== stage.id) continue;
    if (latest === null || snapshot.executionOrder > latest.executionOrder) latest = snapshot;
  }
  const fresh =
    latest === null ||
    latest.status === 'skipped' ||
    (latest.status === 'completed' && latest.outcomeStatus !== 'blocked' && latest.outcomeStatus !== 'question');
  if (!fresh) return null;
  const evaluation = evaluateRunWhen(workspace, sessionId, stage);
  if ('matched' in evaluation) {
    log(`stage ${stage.id} · run_when matched ${evaluation.matched}.`);
    return null;
  }
  const store = new SessionStore(workspace, undefined, runner.registry);
  const context = store.recordSkippedExecution(sessionId, stage.id, evaluation.skip);
  const attempt = parseExecutionId(context.executionId)?.attempt ?? null;
  log(`stage ${stage.id} · attempt ${attempt ?? 1} · skipped (no changed path matches run_when).`);
  return {
    agent_id: null,
    options: {},
    session_id: sessionId,
    execution_id: context.executionId,
    artifact_directory: context.artifactDirectory,
    failure_reason: '',
    failure_kind: '',
    reset_at: '',
    client: '',
    outcome_status: '',
    outcome_decision: '',
    session_status: text(store.readSessionStatus(sessionId).status),
    response: '',
    execution_status: 'skipped',
    skip: {
      reason: evaluation.skip.reason,
      baseline: evaluation.skip.baseline,
      patterns: evaluation.skip.patterns,
      changed_paths: evaluation.skip.changedPaths,
    },
  };
}

/** Execution id of the stage's latest attempt when the human stopped it before it finished. */
function interruptedExecutionId(snapshots: readonly ExecutionSnapshot[], stageId: string): string | undefined {
  let latest: ExecutionSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.stageId !== stageId || snapshot.status === 'skipped') continue;
    if (latest === null || snapshot.executionOrder > latest.executionOrder) latest = snapshot;
  }
  return latest?.status === 'cancelled' ? latest.executionId : undefined;
}

export function storedPriorSessionId(status: Record<string, unknown>): string | null {
  const prior = status.prior_session_id;
  return typeof prior === 'string' && prior ? prior : null;
}

export function priorSessionOutputs(
  workspace: string,
  priorSessionId: string | null,
  sessionId?: string,
): Record<string, unknown> | null {
  if (!priorSessionId) return null;
  if (sessionId) {
    const {handoff} = new SessionStore(workspace).readSessionStatus(sessionId);
    if (isRecord(handoff) && isRecord(handoff.artifacts)) {
      return Object.fromEntries(Object.entries(handoff.artifacts).map(([name, value]) => {
        const record = isRecord(value) ? value : {};
        return [name, { ...record, path: path.resolve(workspace, '.migent', 'sessions', sessionId, String(record.path)) }];
      }));
    }
  }
  const {outputs} = new SessionStore(workspace).readSessionStatus(priorSessionId);
  return isRecord(outputs) ? outputs : {};
}

export function executeFinal(
  status: Record<string, unknown>,
  stopReason: string,
  stages: Record<string, unknown>[],
): ExecuteResult {
  return {
    code: EXECUTE_EXIT_CODES[stopReason] ?? 2,
    status: text(status.status),
    stopReason,
    sessionId: text(status.session_id),
    latestDecision: optionalText(status.latest_decision),
    latestExecutionId: optionalText(status.latest_execution_id),
    outputs: isRecord(status.outputs) ? status.outputs : {},
    stages,
  };
}

export function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
