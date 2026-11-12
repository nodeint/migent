import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { ClientRegistry, ExecutionSnapshot } from '@nodeint/migent-kernel';
import { loadRoleResponsibilities, loadWorkspaceConfig, resolveStageTarget, type StageTarget } from '@nodeint/migent-kernel';
import { ConfigurationError } from '@nodeint/migent-kernel';
import { buildStagePrompt, buildStageReplyPrompt, buildStageResumePrompt, buildVerifyRepairPrompt } from '@nodeint/migent-kernel';
import { log } from '@nodeint/migent-kernel';
import {
  missingOutputProducers,
  revisionResumeExecution,
  stageAgentExecution,
  stageDispatchError,
  stagePromptAlreadyDelivered,
  VERIFY_FAILED,
  verifyExhaustedExecution,
} from '@nodeint/migent-kernel';
import type { TurnKind } from '@nodeint/migent-prompts';
import { frozenRoleInstructions, frozenStageTarget, readWorkflowFreeze } from '@nodeint/migent-session';
import { commitFoldedStatus, parseExecutionId } from '@nodeint/migent-session';
import { freezeSessionTask } from '@nodeint/migent-session';
import { bindPriorSessionId, createWorkflowSession } from '@nodeint/migent-session';
import { SessionStore, stringOptions } from '@nodeint/migent-session';
import { isRecord } from '@nodeint/migent-workflow';
import { isRoleStage, loadNamedWorkflow, type RoleStageSpec, type StageSpec, type WorkflowDocument } from '@nodeint/migent-workflow';

import { AgentToolRunner, type RunResult } from './agent-runner.js';
import { PendingStageReply } from './execute-state.js';
import { ensureSessionBaseline } from './run-when.js';
import { skipUnlessRunWhenMatches } from './run-when-skip.js';
import { roleStartLine, stageFinishLine } from './stage-lines.js';
import { runVerifyOnlyStage } from './verify-only.js';

export { EXECUTE_EXIT_CODES, type ExecuteResult, PendingStageReply, TERMINAL_SESSION_STATUSES } from './execute-state.js';
export { blockResumes, executeFinal, optionalText, selectedStage, text } from './execute-state.js';
export { roleStartLine, stageFinishLine } from './stage-lines.js';

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
  const { runner, onExecution } = run;
  const { sessionId, workflow, target } = resolveDispatchSession(workspace, request, run);
  assertStageDispatchable(workspace, workflow, { sessionId, stageId: request.stageId });
  const resumeExecutionId = dispatchResumeExecution(workspace, workflow, { sessionId, stageId: request.stageId });
  const result = await runner.run({
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

// Creates the session when the request names none, and loads the workflow and target it runs under.
function resolveDispatchSession(
  workspace: string,
  request: StageDispatchRequest,
  run: NamedStageRun,
): { sessionId: string; workflow: WorkflowDocument; target: StageTarget } {
  const { registry } = run.runner;
  const loaded = run.resolved ?? loadDispatchTarget(workspace, request, registry);
  if (request.sessionId !== undefined && request.sessionId !== null) {
    bindPriorSessionId(workspace, request.sessionId, request.priorSessionId);
    return { sessionId: request.sessionId, ...loaded };
  }
  const sessionId = createWorkflowSession(
    workspace,
    loaded.workflow.id,
    { task: request.task, priorSessionId: request.priorSessionId, resolveClient: registry },
  );
  const reloaded = run.resolved ? loaded : loadDispatchTarget(workspace, { ...request, sessionId }, registry);
  return { sessionId, workflow: reloaded.workflow, target: reloaded.target };
}

// The execution whose conversation a dispatched stage continues, if any.
function dispatchResumeExecution(
  workspace: string,
  workflow: WorkflowDocument,
  target: { sessionId: string; stageId: string },
): string | null | undefined {
  const { stageId } = target;
  const snapshots = new SessionStore(workspace).executionSnapshots(target.sessionId);
  const ownAgent = stageAgentExecution(snapshots, stageId);
  const question = snapshots.find((row) => row.executionId === ownAgent && row.outcomeStatus === 'question');
  if (question) return question.executionId;
  // A reply to a stopped turn continues that turn's own conversation, even for a resume_from stage.
  const interrupted = snapshots.find((row) => row.executionId === ownAgent && row.status === 'cancelled');
  if (interrupted) return interrupted.executionId;
  if (!workflow.stages[stageId]?.resumeFrom) return ownAgent;
  return verifyExhaustedExecution(snapshots, stageId)?.executionId ??
    revisionResumeExecution(workflow, snapshots, stageId) ??
    resolveResumeExecution(workspace, workflow, target);
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
    return dispatchVerifyOnly({ workspace, sessionId, runner }, { stageId, stageSpec }, onExecution);
  }
  const freeze = readWorkflowFreeze(path.join(workspace, '.migent', 'sessions', sessionId));
  const target = freeze
    ? frozenStageTarget(freeze, stageId)
    : resolveStageTarget(workspace, { workflowId, stageId }, { registry: runner.registry });
  const optionLabel =
    Object.entries(target.options)
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ') || 'default';
  const { turn, prompt } = buildRoleStageTurn(
    { workspace, workflow, sessionId, stageId, stageSpec, snapshots },
    { status, freeze, reply },
  );
  const request: StageDispatchRequest = { workflowId, stageId, prompt, turn, sessionId };
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
  logRoleStageFinish({ workspace, sessionId }, stageId, result);
  return result.toJson();
}

// Gathers the prompt inputs for a role stage and picks its turn kind and prompt.
function buildRoleStageTurn(
  stage: Parameters<typeof selectStageTurn>[0],
  inputs: {
    status: Record<string, unknown>;
    freeze: ReturnType<typeof readWorkflowFreeze>;
    reply: PendingStageReply | null;
  },
): { turn: TurnKind; prompt: string } {
  const { workspace, workflow, sessionId, stageId, stageSpec, snapshots } = stage;
  const { status, freeze, reply } = inputs;
  const priorSessionId = storedPriorSessionId(status);
  const frozen = freezeSessionTask(workspace, sessionId);
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
  return selectStageTurn(stage, {
    stageReply: reply?.take(stageId) ?? null,
    exhausted: verifyExhaustedExecution(snapshots, stageId),
    frozen,
    promptInput,
  });
}

// Logs a role stage's finish line with its outcome, or failed/finished when it has none.
function logRoleStageFinish(
  scope: { workspace: string; sessionId: string },
  stageId: string,
  result: StageDispatchResult,
): void {
  const outcome =
    result.outcomeStatus ||
    (result.failureReason || result.failureKind || result.executionStatus === 'failed' ? 'failed' : 'finished');
  log(
    stageFinishLine(
      scope,
      { stageId, executionId: result.executionId },
      { outcome, decision: result.outcomeDecision },
    ),
  );
}

// Runs a verify-only stage and logs its finish line.
async function dispatchVerifyOnly(
  run: Pick<ExecuteRun, 'workspace' | 'sessionId' | 'runner'>,
  stage: { stageId: string; stageSpec: Exclude<StageSpec, RoleStageSpec> },
  onExecution?: (executionId: string) => void,
): Promise<Record<string, unknown>> {
  const { workspace, sessionId, runner } = run;
  const { stageId, stageSpec } = stage;
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

// Picks the turn kind and prompt: a pending reply, a verify repair, a resume, or a fresh start.
function selectStageTurn(
  stage: {
    workspace: string;
    workflow: WorkflowDocument;
    sessionId: string;
    stageId: string;
    stageSpec: RoleStageSpec;
    snapshots: readonly ExecutionSnapshot[];
  },
  inputs: {
    stageReply: string | null;
    exhausted: ReturnType<typeof verifyExhaustedExecution>;
    frozen: ReturnType<typeof freezeSessionTask>;
    promptInput: Parameters<typeof buildStagePrompt>[0];
  },
): { turn: TurnKind; prompt: string } {
  const { workspace, workflow, sessionId, stageId, stageSpec, snapshots } = stage;
  const { stageReply, exhausted, frozen, promptInput } = inputs;
  const answers = stageReply !== null
    && new SessionStore(workspace).questionStages(sessionId).some((row) => row.stageId === stageId);
  const interrupted = stageReply !== null && interruptedExecutionId(snapshots, stageId) !== undefined;
  if (stageReply !== null) {
    const turn = answers && !interrupted ? 'answers' : 'reply';
    return { turn, prompt: buildStageReplyPrompt(stageReply, { answers, interrupted }) };
  }
  if (exhausted?.verifyReport) {
    const prompt = buildVerifyRepairPrompt(
      readFileSync(exhausted.verifyReport, 'utf8'),
      { red: stageSpec.maxVerify, maxVerify: stageSpec.maxVerify, artifactPath: null },
      { taskFile: frozen.taskFile, sessionDirectory: frozen.sessionDirectory },
    );
    return { turn: 'repair', prompt };
  }
  const turn = stagePromptAlreadyDelivered(workflow, snapshots, stageId) ? 'continue' : 'start';
  return { turn, prompt: turn === 'continue' ? buildStageResumePrompt(promptInput) : buildStagePrompt(promptInput) };
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
