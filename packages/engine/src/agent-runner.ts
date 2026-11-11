import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  CliClient,
  ClientRegistry,
  FailureClassification,
  NewSession,
  ResponseSource,
  UsageCapture,
} from '@nodeint/migent-kernel';
import { classifyFailure, createNewSession, sessionOptions } from '@nodeint/migent-kernel';
import { CancellationRequested, CommandExecutor, DEFAULT_TIMEOUT_SEC, type ExecutionFailure, type ProcessFacts, type StopReason } from '@nodeint/migent-kernel';
import { DEFAULT_INTERRUPT_POLICY, type InterruptPolicy, type InterruptReport, interruptSession, isSettled } from '@nodeint/migent-kernel';
import {
  buildTurnDiagnostics,
  type Gates,
  observeTurn,
  StreamSummarizer,
  truncateText,
} from '@nodeint/migent-kernel';
import { spawnProviderSync } from '@nodeint/migent-kernel';
import { buildVerifyRepairPrompt } from '@nodeint/migent-kernel';
import { VERIFY_EXHAUSTED } from '@nodeint/migent-kernel';
import { formatVerifyReport, VerifyRunner, type VerifyRunResult } from '@nodeint/migent-kernel';
import { ConfigurationError } from '@nodeint/migent-kernel';
import { nonemptyArtifact } from '@nodeint/migent-kernel';
import {
  debugEnabled,
  flattenHistory,
  log,
} from '@nodeint/migent-kernel';
import {
classifyGateError,   CORRECTION_FAILURE_REASONS, CORRECTION_POLICY,   type CorrectionFiles, type CorrectionLedger, decideCorrection, type GateFailure,
readCorrectionLedger, ruleForTurn,
} from '@nodeint/migent-kernel';
import { StageOutcome } from '@nodeint/migent-kernel';
import { platformHome } from '@nodeint/migent-kernel';
import { type OutcomeContext,resolveStageOutcome } from '@nodeint/migent-kernel';
import { HandoffFileError } from '@nodeint/migent-kernel';
import { type Question,QuestionFileError } from '@nodeint/migent-kernel';
import {
CURRENT_RESPONSE_PROTOCOL,   renderProtocolUpdate, renderProviderPrompt, type TurnKind,
} from '@nodeint/migent-prompts';
import { loadFrozenWorkflow } from '@nodeint/migent-session';
import { AgentSessionRecord, type ExecutionContext,SessionStore, stringOptions } from '@nodeint/migent-session';
import { isRecord } from '@nodeint/migent-workflow';
import { allStageArtifacts, isWorkflowV2, loadNamedWorkflow, loadStage, type StageArtifact, stageArtifactsFor, type StageSpec } from '@nodeint/migent-workflow';

import { ProviderEventReporter } from './provider-events.js';

export interface RunResult {
  questions?: Question[];
  questions_file?: string;
  agent_id: string;
  options: Record<string, string>;
  session_id: string;
  execution_id: string;
  artifact_directory: string;
  outcome_status: string;
  outcome_decision: string;
  session_status: string;
  response: string;
  failure_reason: string;
  /** Readable diagnostic for a correction-policy failure reason: the problem and how to recover. Absent otherwise. */
  failure_detail?: string;
  /** `quota`, `provider`, or empty when the turn was not a provider failure. */
  failure_kind: string;
  /** UTC ISO instant for a quota failure. Empty otherwise. */
  reset_at: string;
  client: string;
  /** Final status of this execution, e.g. `failed` when the provider exited non-zero without a classified failure. */
  execution_status?: string;
}

export interface RunRequest {
  /** CLI client id, resolved through the runner's registry. */
  client: string;
  model: string;
  prompt: string;
  /** What the prompt is; it picks the closing instruction and is kept for resume. */
  turn?: TurnKind | null;
  workspace: string;
  sessionId?: string | null;
  resumeExecutionId?: string | null;
  stageId?: string;
  stageAttempt?: number | null;
  executionOrder?: number | null;
  options?: Record<string, string> | null;
  /** Called as soon as the execution id exists, before the first await. */
  onExecution?: (executionId: string) => void;
}

/**
 * Version of the response contract baked into a saved first prompt. 2 = headers plus a question
 * request file. 3 = one handoff file. A conversation keeps the protocol it started under.
 */
const RESPONSE_PROTOCOL = CURRENT_RESPONSE_PROTOCOL;

/** The protocol a stored stamp runs under. A missing or legacy stamp is read as 1. */
function storedProtocol(metadata: Record<string, unknown> | null): number {
  const value = metadata?.response_protocol;
  return typeof value === 'number' && value >= 2 ? value : 1;
}

const TURN_KINDS: readonly TurnKind[] = [
  'start', 'continue', 'reply', 'answers', 'repair', 'correction', 'response_correction', 'output_correction', 'handoff_correction',
];

/** The kind of the execution's latest user turn, as saved in execution.json. */
function storedTurn(metadata: Record<string, unknown>): TurnKind | null {
  const value = metadata.turn_kind;
  return TURN_KINDS.find((kind) => kind === value) ?? null;
}

/** Task file and session directory of a workflow execution, for the prompt's Execution block. */
function sessionPaths(context: ExecutionContext, sessionId: string | null): { taskFile?: string; sessionDirectory?: string } {
  if (sessionId === null) return {};
  const sessionDirectory = path.dirname(path.dirname(context.directory));
  const taskFile = path.join(sessionDirectory, 'task.md');
  try {
    return statSync(taskFile).isFile() ? { taskFile, sessionDirectory } : {};
  } catch {
    return {};
  }
}
const QUESTION_FILE_NAME = 'question-request.json';
const HANDOFF_FILE_NAME = 'handoff.json';

/** Absolute, native path the agent writes its handoff to (protocol 3). It sits outside `artifacts/`. */
export function handoffPath(context: ExecutionContext): string {
  return path.resolve(context.directory, HANDOFF_FILE_NAME);
}

/** Absolute, native path the agent writes questions to. It sits outside `artifacts/`. */
export function questionRequestPath(context: ExecutionContext): string {
  return path.resolve(context.directory, QUESTION_FILE_NAME);
}

export class AgentToolRunner {
  public readonly registry: ClientRegistry;
  public readonly executor: CommandExecutor;
  public readonly verifyRunner: VerifyRunner;
  public itemProgress = false;
  /**
   * Protocol a conversation with no source execution starts under. Continued conversations always
   * inherit their source's. Tests set 2 to build authentic protocol-2 conversations.
   */
  public newConversationProtocol = RESPONSE_PROTOCOL;
  public interruptPolicy: InterruptPolicy = DEFAULT_INTERRUPT_POLICY;
  private readonly cliVersions = new Map<string, string | null>();

  constructor(
    registry: ClientRegistry,
    timeoutSec: number | null = DEFAULT_TIMEOUT_SEC,
    verifyRunner: VerifyRunner = new VerifyRunner(),
  ) {
    this.verifyRunner = verifyRunner;
    this.registry = registry;
    this.executor = new CommandExecutor(timeoutSec);
  }

  public async run(request: RunRequest): Promise<RunResult> {
    const workspacePath = resolveWorkspace(request.workspace);
    const stageAttempt = request.stageAttempt ?? null;
    const executionOrder = request.executionOrder ?? null;
    if (stageAttempt !== null && stageAttempt < 1) throw new Error('Stage attempt must be at least 1.');
    if (executionOrder !== null && executionOrder < 1) {
      throw new Error('Execution order must be at least 1.');
    }
    const clientId = request.client;
    const client = this.registry.get(clientId);
    const resolvedOptions = { ...(request.options ?? {}) };
    client.validateOptions(resolvedOptions);
    const profile = sessionOptions(client, resolvedOptions);
    const store = new SessionStore(workspacePath, undefined, this.registry);
    const sessionId = request.sessionId ?? null;
    const stageId = request.stageId ?? 'agent';
    const [record, isNew, context] = store.loadOrCreate(
      clientId,
      request.model,
      profile,
      workspacePath,
      sessionId,
      stageId,
      stageAttempt,
      executionOrder,
      request.prompt,
      request.resumeExecutionId ?? null,
      (record) => validateSessionProfile(record.client, record.model, record.options, clientId, request.model, profile),
    );
    request.onExecution?.(context.executionId);
    const newSession = isNew ? createNewSession(client) : null;
    if (newSession?.agentId) record.agentId = newSession.agentId;
    record.history.push({ role: 'user', content: request.prompt });
    record.status = 'running';
    store.save(record, context);
    store.saveExecution(context, record, 'running');
    const eventReporter = new ProviderEventReporter(
      store,
      context,
      clientId,
      request.model,
      this.itemProgress,
    );
    const agentId = isNew ? null : record.agentId;
    let turnPrompt = request.prompt;
    if (!isNew && !agentId) {
      turnPrompt = flattenHistory(record.history as { role: string; content: string }[]);
    }
    const stage = sessionId === null ? null : loadRunStage(store, context.sessionId, stageId);
    const decisionValues = stage?.decisionValues ?? [];
    const ask = stage?.ask ?? (stage === null ? 'human' : null);
    const artifactFiles = stage === null ? [] : allStageArtifacts(stage);
    const artifactName = artifactFiles[0]?.artifact.file ?? null;
    const verifyCommands = stage?.verify ?? [];
    const source = request.resumeExecutionId ? store.executionContext(context.sessionId, request.resumeExecutionId) : null;
    const sourceMetadata = source === null ? null : readExecutionJson(source.directory);
    // A new conversation takes the current protocol; a continued one keeps its source's, never past 2 from a legacy stamp.
    const protocol = isNew || source === null ? this.newConversationProtocol : Math.max(2, storedProtocol(sourceMetadata));
    const previous = request.resumeExecutionId
      ? store.executionSnapshots(context.sessionId).find((row) => row.executionId === request.resumeExecutionId && row.stageId === stageId && row.outcomeStatus === 'question')
      : undefined;
    const previousMetadata = previous
      ? JSON.parse(readFileSync(path.join(path.dirname(previous.artifactDirectory), 'execution.json'), 'utf8')) as Record<string, unknown>
      : null;
    const progress = previousMetadata ? verifyProgress(previousMetadata) : null;
    // Answering a question on the same agent: the conversation already holds the contract and stage instructions.
    const sameConversation = previous !== undefined && agentId !== null && agentId !== ''
      && storedProtocol(previousMetadata) === protocol;
    if (previous) for (const item of artifactFiles) store.carryVerifyArtifact(previous.artifactDirectory, context, item.artifact.file);
    if (request.resumeExecutionId && verifyCommands.length > 0) {
      for (const item of artifactFiles) this.carryExhaustedArtifact(store, context, request.resumeExecutionId, item.artifact.file);
    }
    turnPrompt = renderProviderPrompt(turnPrompt, { ...sessionPaths(context, sessionId),
      contract: sessionId === null ? false : sameConversation ? 'reminder' : 'full', turn: request.turn ?? null, decisionValues, decisionInstructions: stage?.decisionInstructions, ask,
      protocol, questionFile: questionRequestPath(context), handoffFile: handoffPath(context),
      artifactDirectory: context.artifactDirectory, artifactName, artifactFiles: promptArtifactFiles(artifactFiles),
      previousArtifactDirectory: previous?.artifactDirectory ?? null,
      previousVerifyReport: previous && progress?.lastReport
        ? path.resolve(path.dirname(previous.artifactDirectory), progress.lastReport) : null,
    });
    store.savePrompt(context, turnPrompt);
    store.saveExecutionProgress(context, record, { response_protocol: protocol, turn_kind: request.turn ?? null });
    const started: Record<string, unknown> = {
      cli_version: this.cachedCliVersion(client, clientId, workspacePath),
      ...readGitFacts(workspacePath),
    };
    if (Object.keys(profile).length > 0) started.options = profile;
    eventReporter.emit('provider.stage_started', `${clientId}/${request.model}`, started);

    return this.driveTurns({
      client,
      clientId,
      model: request.model,
      workspacePath,
      resolvedOptions,
      profile,
      store,
      context,
      record,
      eventReporter,
      sessionId,
      stage,
      decisionValues,
      artifactName,
      verifyCommands,
      maxVerify: stage?.maxVerify ?? 0,
      verifyTimeoutSec: stage?.verifyTimeoutSec ?? null,
      turn: 1,
      red: progress?.red ?? 0,
      verifyRuns: progress?.runs ?? 0,
      lastReport: previous && progress?.lastReport
        ? path.relative(context.directory, path.resolve(path.dirname(previous.artifactDirectory), progress.lastReport)) : null,
      lastResult: progress?.lastResult ?? null,
      currentPrompt: turnPrompt,
      currentAgentId: agentId,
      currentSession: newSession,
      pendingVerify: null,
      corrections: {},
      protocol,
    });
  }

  /** Finish a cancelled execution that has been reopened in place. Does not create an attempt. */
  public async continueCancelled(workspace: string, sessionId: string, executionId: string): Promise<RunResult> {
    const workspacePath = resolveWorkspace(workspace);
    const store = new SessionStore(workspacePath, undefined, this.registry);
    const context = store.executionContext(sessionId, executionId);
    if (context === null) throw new Error(`Execution ${executionId} was not found in session ${sessionId}.`);
    const metadata = JSON.parse(readFileSync(path.join(context.directory, 'execution.json'), 'utf8')) as unknown;
    if (!isRecord(metadata)) throw new Error(`Execution ${executionId} is unreadable.`);
    if (metadata.status !== 'running') {
      throw new Error(`Execution ${executionId} is ${String(metadata.status)}, not running.`);
    }
    const stageId = typeof metadata.stage_id === 'string' ? metadata.stage_id : 'agent';
    const clientId = store.executionClient(sessionId, executionId);
    const model = typeof metadata.model === 'string' ? metadata.model : '';
    const client = this.registry.get(clientId);
    const resolvedOptions = stringOptions(metadata.options);
    client.validateOptions(resolvedOptions);
    const profile = sessionOptions(client, resolvedOptions);
    const record = AgentSessionRecord.fromJson(
      JSON.parse(readFileSync(context.conversationReadPath, 'utf8')) as unknown,
      clientId,
      model,
      workspacePath,
    );
    record.client = clientId;
    record.status = 'running';
    store.save(record, context);
    const stage = loadRunStage(store, sessionId, stageId);
    const decisionValues = stage?.decisionValues ?? [];
    const ask = stage?.ask ?? (stage === null ? 'human' : null);
    const artifactFiles = stage === null ? [] : allStageArtifacts(stage);
    const artifactName = artifactFiles[0]?.artifact.file ?? null;
    const verifyCommands = stage?.verify ?? [];
    const eventReporter = new ProviderEventReporter(store, context, clientId, model, this.itemProgress);
    const progress = verifyProgress(metadata);
    const corrections = readCorrectionLedger(metadata);
    const questionFile = questionRequestPath(context);
    const handoffFile = handoffPath(context);
    const stamped = storedProtocol(metadata);
    const protocol = Math.max(2, stamped);
    // A legacy execution continues under protocol 2 from here on; record it so later resumes, the
    // contract selection and the execution metadata agree.
    if (stamped !== protocol) store.saveExecutionProgress(context, record, { response_protocol: protocol });
    // The file a pending correction repairs must survive the first turn's cleanup.
    let keepFile = false;
    const assistants = record.history.filter((item) => item.role === 'assistant').length;
    const last = record.history.at(-1);
    const lastRole = last && typeof last.role === 'string' ? last.role : '';
    if (last === undefined || lastRole !== 'assistant') {
      if (lastRole !== 'user' || typeof last?.content !== 'string' || last.content === '') {
        throw new ConfigurationError(`Execution ${executionId} has no prompt to resume.`);
      }
      const {agentId} = record;
      // The first turn is sent as prompt.md, contract included. A later repair turn
      // stores only the repair text, and the loop adds the contract again before sending.
      let currentPrompt: string;
      // The saved first prompt applies only while the history holds just that prompt. A correction
      // queued after an empty reply adds a user message without an assistant one.
      const userTurns = record.history.filter((item) => item.role === 'user').length;
      const pendingCorrection = ruleForTurn(storedTurn(metadata));
      if (assistants === 0 && userTurns <= 1) {
        try {
          currentPrompt = readFileSync(path.join(context.directory, 'prompt.md'), 'utf8');
        } catch {
          throw new ConfigurationError(`Execution ${executionId} has no prompt to resume.`);
        }
        // A first prompt saved under an older protocol carries the old question instructions.
        if (sessionId !== null && ask !== null && stamped < 2) {
          currentPrompt += renderProtocolUpdate({ ...sessionPaths(context, sessionId), turn: storedTurn(metadata),
            decisionValues, decisionInstructions: stage?.decisionInstructions, ask, questionFile,
          });
          // The stamp now says protocol 2, so the saved prompt must carry the update for the next resume.
          store.savePrompt(context, currentPrompt);
        }
      } else {
        currentPrompt = agentId
          ? last.content
          : flattenHistory(record.history as { role: string; content: string }[]);
        const contract = agentId && stamped >= 2
          ? (pendingCorrection?.contract ?? 'reminder') : 'full';
        keepFile = pendingCorrection?.keepFile ?? false;
        currentPrompt = renderProviderPrompt(currentPrompt, { ...sessionPaths(context, sessionId), contract, turn: storedTurn(metadata), decisionValues, decisionInstructions: stage?.decisionInstructions, ask, protocol, questionFile, handoffFile, artifactDirectory: context.artifactDirectory, artifactName, artifactFiles: promptArtifactFiles(artifactFiles) });
      }
      return this.driveTurns({
        client,
        clientId,
        model,
        workspacePath,
        resolvedOptions,
        profile,
        store,
        context,
        record,
        eventReporter,
        sessionId,
        stage,
        decisionValues,
        artifactName,
        verifyCommands,
        maxVerify: stage?.maxVerify ?? 0,
        verifyTimeoutSec: stage?.verifyTimeoutSec ?? null,
        turn: persistedTurn(metadata, Math.max(1, assistants + 1)),
        red: progress.red,
        verifyRuns: progress.runs,
        lastReport: progress.lastReport,
        lastResult: progress.lastResult,
        currentPrompt,
        currentAgentId: agentId,
        currentSession: null,
        pendingVerify: null,
        corrections,
        protocol,
        keepFile,
      });
    }
    const turn = persistedTurn(metadata, Math.max(1, assistants));
    const responseText = savedResponse(context, last);
    let outcome: StageOutcome | null = null;
    let invokeError: string | null = null;
    let gateFailure: GateFailure | null = null;
    try {
      outcome = savedOutcome(store, context, turn, responseText, { required: sessionId !== null, decisionValues, ask, protocol, questionFile, handoffFile });
    } catch (error) {
      if (error instanceof QuestionFileError || error instanceof HandoffFileError) gateFailure = classifyGateError(error);
      else if (error instanceof Error) {
        invokeError = error.message;
        gateFailure = classifyGateError(error);
      } else throw error;
    }
    return this.driveTurns({
      client,
      clientId,
      model,
      workspacePath,
      resolvedOptions,
      profile,
      store,
      context,
      record,
      eventReporter,
      sessionId,
      stage,
      decisionValues,
      artifactName,
      verifyCommands,
      maxVerify: stage?.maxVerify ?? 0,
      verifyTimeoutSec: stage?.verifyTimeoutSec ?? null,
      turn,
      red: progress.red,
      verifyRuns: progress.runs,
      lastReport: progress.lastReport,
      lastResult: progress.lastResult,
      currentPrompt: '',
      currentAgentId: record.agentId,
      currentSession: null,
      pendingVerify: { responseText, outcome, invokeError, gateFailure },
      corrections,
      protocol,
    });
  }

  private async driveTurns(state: TurnDrive): Promise<RunResult> {
    const {
      client,
      clientId,
      model,
      workspacePath,
      resolvedOptions,
      profile,
      store,
      context,
      record,
      eventReporter,
      sessionId,
      stage,
      decisionValues,
      artifactName,
      verifyCommands,
    } = state;
    const {maxVerify} = state;
    const ask = stage?.ask ?? (stage === null ? 'human' : null);
    let {turn} = state;
    let {red} = state;
    let {verifyRuns} = state;
    let {lastReport} = state;
    let {lastResult} = state;
    let {currentPrompt} = state;
    let {currentAgentId} = state;
    let {currentSession} = state;
    let {pendingVerify} = state;
    let {corrections} = state;
    const {protocol} = state;
    const questionFile = questionRequestPath(context);
    const handoffFile = handoffPath(context);
    const files: CorrectionFiles = { protocol, questionFile, handoffFile };
    // The file this protocol's outcome is read from; per-turn cleanup removes it.
    const signalFile = protocol >= 3 ? handoffFile : questionFile;
    let keepFile = state.keepFile ?? false;
    let responseText: string;
    let outcome: StageOutcome | null;
    let failureReason = '';
    let failureDetail = '';
    let classification: FailureClassification | null = null;
    const markCancelled = (error: unknown): never => {
      if (error instanceof CancellationRequested) {
        eventReporter.emit('provider.cancelled', 'cancellation requested');
        record.status = 'cancelled';
        store.save(record, context);
        store.saveExecution(context, record, 'cancelled');
        log(`Execution ${context.executionId} marked cancelled.`);
      }
      throw error;
    };
    const extraFields = (reason: string | null = null): Record<string, unknown> | null => {
      if (verifyCommands.length === 0) return null;
      const fields: Record<string, unknown> = { turns: turn };
      if (lastResult !== null && lastReport !== null) {
        fields.verify = {
          runs: verifyRuns,
          red,
          max_verify: maxVerify,
          last_result: lastResult,
          last_report: lastReport,
        };
      }
      if (reason !== null) fields.failure_reason = reason;
      return fields;
    };
    // The last provider turn this execution ran; failure.md joins diagnostics.json to it.
    const finalFields = (extra: Record<string, unknown> | null): Record<string, unknown> => ({
      ...(extra ?? {}),
      final_turn: turn,
    });
    const outcomeFields = (): Record<string, unknown> | null => {
      if (CORRECTION_FAILURE_REASONS.includes(failureReason)) {
        return { ...(extraFields() ?? {}), failure_reason: failureReason };
      }
      if (classification?.kind !== 'quota') return extraFields();
      failureReason = 'quota';
      return {
        ...(extraFields() ?? {}),
        failure_reason: 'quota',
        retry_at: classification.resetAt,
        ...(classification.window ? { quota_window: classification.window } : {}),
      };
    };
    // Queue one correction turn when the policy grants it. False when the budget for the kind is used.
    const queueCorrection = (failure: GateFailure): boolean => {
      const rule = CORRECTION_POLICY[failure.kind];
      const decision = decideCorrection(failure.kind, corrections, turn);
      if (decision === 'exhausted') return false;
      // The budget is persisted before the message joins the history, so a stop between the two
      // writes sends the correction again on resume and never grants a second.
      if (decision === 'correct') {
        corrections = { ...corrections, [failure.kind]: { turn, error_kind: failure.errorKind, error_detail: failure.detail } };
        store.saveExecutionProgress(context, record, { corrections });
        eventReporter.emit(rule.event, `${failure.errorKind}: ${failure.detail}`, {
          turn, error_kind: failure.errorKind, ...(failure.kind === 'question_file' ? { file: questionFile } : failure.kind === 'handoff' ? { file: handoffFile } : {}),
        });
      }
      const used = corrections[failure.kind]!;
      const message = rule.render(used, files);
      record.history.push({ role: 'user', content: message });
      store.save(record, context);
      store.saveExecutionProgress(context, record, { turn_kind: rule.turnKind, pending_turn: turn + 1 });
      const base = record.agentId
        ? message
        : flattenHistory(record.history as { role: string; content: string }[]);
      currentPrompt = renderProviderPrompt(base, { ...sessionPaths(context, sessionId),
        contract: record.agentId ? rule.contract : 'full', turn: rule.turnKind, decisionValues,
        decisionInstructions: stage?.decisionInstructions, ask, protocol, questionFile, handoffFile, artifactDirectory: context.artifactDirectory,
        artifactName, artifactFiles: promptArtifactFiles(stage === null ? [] : allStageArtifacts(stage)),
      });
      turn += 1;
      currentAgentId = record.agentId;
      currentSession = null;
      keepFile = rule.keepFile;
      return true;
    };
    // The budget is used: the stage fails with the original error and the kind's reason.
    const exhaust = (failure: GateFailure): void => {
      failureReason = CORRECTION_POLICY[failure.kind].failureReason;
      failureDetail = CORRECTION_POLICY[failure.kind].detail(failure, files);
    };
    // The artifact and completion-output gates. Fresh turns and resumed saved replies both run them.
    const checkOutputs = (reply: StageOutcome, gates: Gates | null): GateFailure | null => {
      if (stage !== null && artifactName && reply.status === 'complete') {
        const missing = stageArtifactsFor(stage, reply.decision ?? null)
          .filter((item) => item.required && !nonemptyArtifact(path.join(context.artifactDirectory, item.file)))
          .map((item) => item.file);
        const detail = `Stage artifact missing or empty: ${missing.join(', ')}.`;
        if (missing.length > 0) {
          if (gates) gates.artifact = { state: 'failed', reason: detail };
          return { kind: 'stage_output', errorKind: 'artifact', detail };
        }
        if (gates) gates.artifact = { state: 'passed' };
      }
      if (isWorkflowV2(frozenDocument(context))) {
        if (gates) gates.completion_outputs = { state: 'not-applicable' };
        return null;
      }
      const missing = store.missingCompletionOutputs(context, reply);
      if (missing.length > 0) {
        const detail = `Completion outputs missing or empty: ${missing.join(', ')}.`;
        if (gates) gates.completion_outputs = { state: 'failed', reason: detail };
        return { kind: 'stage_output', errorKind: 'completion_outputs', detail };
      }
      if (gates) gates.completion_outputs = { state: 'passed' };
      return null;
    };
    while (true) {
      let invokeError: string | null;
      let gateFailure: GateFailure | null = null;
      let eligible = true;
      const pendingGate = pendingVerify !== null;
      if (pendingVerify) {
        responseText = pendingVerify.responseText;
        outcome = pendingVerify.outcome;
        invokeError = pendingVerify.invokeError;
        gateFailure = pendingVerify.gateFailure;
        pendingVerify = null;
        // A saved reply passes the same output gates a fresh one does before it is accepted.
        if (invokeError === null && gateFailure === null && outcome !== null) {
          const bad = checkOutputs(outcome, null);
          if (bad !== null) {
            gateFailure = bad;
            invokeError = bad.detail;
          }
        }
      } else {
        // A request file left by an earlier turn must not be read as a new question. The
        // correction turn keeps the invalid file so the agent can repair it.
        if (!keepFile) rmSync(signalFile, { force: true });
        keepFile = false;
        let turnResult: TurnResult;
        try {
          turnResult = await this.runTurn(
            client,
            model,
            workspacePath,
            currentPrompt,
            currentAgentId,
            currentSession,
            resolvedOptions,
            eventReporter,
            store,
            context,
            turn,
          );
        } catch (error) {
          return markCancelled(error);
        }
        const { argv, usage, source: parsedSource, exitCode } = turnResult;
        responseText = turnResult.responseText;
        invokeError = turnResult.invokeError;
        classification = turnResult.classification;
        // An abnormal provider turn leaves a record whatever the gates decide: a failed start or
        // exit, or a provider-reported error at exit 0. A timeout or an unpassable argument has neither.
        const recordsTurn = turnResult.failure !== undefined || (exitCode === 0 && classification !== null);
        const gates: Gates = {
          outcome: { state: 'not-evaluated' },
          artifact: { state: 'not-evaluated' },
          completion_outputs: { state: 'not-evaluated' },
        };

        record.agentId = turnResult.sessionId || record.agentId;
        const turnDetails: Record<string, unknown> = {
          turn,
          agent_id: record.agentId,
          argv,
        };
        if (usage !== null) turnDetails.usage = usage;
        record.model = model;
        record.options = profile;
        record.workspace = workspacePath;
        outcome = null;
        // A provider that does not attest the source of its text is trusted only on a clean exit.
        const source: ResponseSource = parsedSource ?? (classification === null ? 'model' : 'none');
        const exitOnly = classification?.origin === 'exit-only';
        // A non-zero exit alone does not decide the turn. A reply the model wrote still goes
        // through every gate an exit-0 turn passes; the provider's own error text never does.
        const candidate = exitOnly && source === 'model' && responseText.trim() !== '';
        // Only a reply the model wrote can be corrected: no start failure, timeout or provider verdict.
        eligible = candidate || (classification === null && exitCode === 0 && turnResult.failure === undefined);
        const exitMessage = invokeError;
        let anomalyReason: string | null = null;
        if (candidate) {
          invokeError = null;
        } else if (exitOnly) {
          anomalyReason = responseText.trim() === '' ? 'no reply' : 'reply is not model output';
          invokeError = responseText.trim() === '' ? exitMessage : responseText;
        }
        // The turn event follows the provider verdict only; later gates never rename it.
        let turnError = invokeError;
        if (invokeError === null) {
          try {
            outcome = resolveStageOutcome(responseText, {
              required: sessionId !== null, decisionValues, ask, protocol, questionFile, handoffFile,
            });
            gates.outcome = { state: 'passed', ...(outcome === null ? {} : { status: outcome.status }) };
          } catch (error) {
            gateFailure = classifyGateError(error);
            if (error instanceof QuestionFileError) {
              gates.outcome = { state: 'failed', reason: `question file unusable (${error.kind})` };
            } else if (error instanceof HandoffFileError) {
              gates.outcome = { state: 'failed', reason: `handoff file unusable (${error.kind})` };
            } else if (error instanceof Error) {
              invokeError = error.message;
              gates.outcome = { state: 'failed', reason: truncateText(error.message) };
            } else throw error;
          }
        }
        if (artifactName === null) gates.artifact = { state: 'not-applicable' };
        else if (gates.outcome.state !== 'not-evaluated' && outcome?.status !== 'complete') {
          gates.artifact = { state: 'not-applicable' };
        }
        if (invokeError === null && gateFailure === null && outcome !== null) {
          const bad = checkOutputs(outcome, gates);
          if (bad !== null) {
            gateFailure = bad;
            invokeError = bad.detail;
          }
        }
        if (candidate && (invokeError !== null || gateFailure !== null)) {
          // Rejected: the error is the model text itself, the failed gate is the recorded reason.
          anomalyReason = invokeError ?? `${gateFailure!.errorKind}: ${gateFailure!.detail}`;
          invokeError = responseText;
          turnError = invokeError;
        }
        eventReporter.emit(
          turnError === null ? 'provider.turn_completed' : 'provider.turn_failed',
          turnError === null ? 'completed' : turnError,
          turnDetails,
        );
        if (classification?.kind === 'quota') {
          const resetAt = classification.resetAt ?? '';
          eventReporter.emit(
            'provider.quota',
            [classification.message, resetAt].filter((item) => item !== '').join(' '),
            {
              retry_at: resetAt,
              client: eventReporter.client,
              ...(classification.window ? { window: classification.window } : {}),
            },
          );
        }
        if (exitOnly) {
          eventReporter.emit(
            'provider.exit_anomaly',
            invokeError === null || anomalyReason === null
              ? `exit ${exitCode} with a usable reply; accepted`
              : `exit ${exitCode}; rejected: ${anomalyReason}`,
            {
              turn,
              client: eventReporter.client,
              exit_code: exitCode,
              signal: null,
              origin: 'exit-only',
              accepted: anomalyReason === null,
              reason: anomalyReason,
            },
          );
        }
        const needsVerify =
          verifyCommands.length > 0 && invokeError === null && outcome?.status === 'complete';
        record.status = needsVerify ? 'running' : invokeError === null && gateFailure === null ? 'completed' : 'failed';
        // Only a real model reply belongs in the conversation. Error text, and the reply of a
        // turn the provider itself reported as failed, stay out, so a resume cannot replay
        // them as if the model had said them.
        const modelResponded =
          responseText !== '' && source === 'model' && (classification === null || exitOnly);
        const recordedClassification = classification;
        // An accepted turn is no longer a failure: nothing downstream may see its classification.
        if (exitOnly && anomalyReason === null) classification = null;
        if (modelResponded) record.history.push({ role: 'assistant', content: responseText });
        store.save(record, context);
        if (modelResponded) {
          store.saveResponse(context, responseText);
          if (verifyCommands.length > 0) store.saveTurnResponse(context, turn, responseText);
        }
        if (verifyCommands.length > 0 && outcome?.status === 'complete') {
          store.saveTurnOutcome(context, turn, outcome);
        }
        if (recordsTurn) {
          // The only writer of diagnostics.json: once this turn's gates have run, before any verify or follow-up turn.
          const accepted = exitOnly && anomalyReason === null;
          const reason = exitOnly ? (anomalyReason === null ? null : truncateText(anomalyReason)) : truncateText(recordedClassification?.message ?? exitMessage ?? 'provider failure');
          const errors = recordedClassification?.origin === 'provider-error' ? [recordedClassification.message] : [];
          const stream = turnResult.summarizer.finish(
            { bytes: turnResult.facts?.stdoutBytes ?? 0, lines: turnResult.facts?.stdoutLines ?? 0 },
            errors,
          );
          store.saveDiagnostics(context, buildTurnDiagnostics({
            turn,
            agentId: record.agentId || null,
            ...(turnResult.failure ? { failure: turnResult.failure } : {}),
            ...(turnResult.facts ? { facts: turnResult.facts } : {}),
            classification: recordedClassification,
            stream,
            resultState: {
              observed: observeTurn({
                source: parsedSource,
                responseText,
                artifactPath: artifactName ? path.join(context.artifactDirectory, artifactName) : null,
                responseWritten: modelResponded,
                conversationTurns: record.history.filter((item) => item.role === 'assistant').length,
              }),
              gates,
              turn_verdict: accepted ? 'accepted' : 'failed',
              reason,
            },
          }));
        }
        if (gateFailure !== null && eligible) {
          if (queueCorrection(gateFailure)) continue;
          exhaust(gateFailure);
          if (gateFailure.kind === 'question_file' || gateFailure.kind === 'handoff') {
            invokeError = failureDetail;
            record.status = 'failed';
            store.save(record, context);
            store.saveExecution(context, record, 'failed', invokeError, null, false, finalFields(outcomeFields()));
            break;
          }
        }
        if (!needsVerify || outcome === null) {
          store.saveExecution(context, record, record.status, invokeError, outcome, false, finalFields(outcomeFields()));
          break;
        }
      }
      if (gateFailure !== null && eligible && pendingGate) {
        // Resumed from a saved response that failed a gate.
        if (queueCorrection(gateFailure)) continue;
        exhaust(gateFailure);
        if (gateFailure.kind === 'question_file' || gateFailure.kind === 'handoff') {
          record.status = 'failed';
          store.save(record, context);
          store.saveExecution(context, record, 'failed', failureDetail, null, false, finalFields(outcomeFields()));
          break;
        }
      }
      if (invokeError !== null || outcome === null || outcome.status !== 'complete' || verifyCommands.length === 0) {
        record.status = invokeError === null && outcome !== null ? 'completed' : 'failed';
        store.save(record, context);
        store.saveExecution(context, record, record.status, invokeError, outcome, false, finalFields(outcomeFields()));
        break;
      }

      store.clearProcessEndpoint(context);
      eventReporter.emit('verify.started', `${verifyCommands.length} command(s)`, {
        turn,
        commands: verifyCommands,
      });
      let result: VerifyRunResult;
      try {
        result = await this.verifyRunner.run({
          commands: verifyCommands,
          workspace: workspacePath,
          executionDirectory: context.directory,
          turnDirectory: store.turnDirectory(context, turn),
          timeoutSec: stage?.verifyTimeoutSec ?? null,
          onStart: (info) => {
            store.saveProcessMetadata(context, info);
          },
          onEnd: () => {
            store.clearProcessEndpoint(context);
          },
          onHeartbeat: (command, elapsed) => {
            eventReporter.emit('verify.heartbeat', `${command} running for ${elapsed}s`, {
              turn,
              command,
              elapsed_seconds: elapsed,
            });
          },
        });
      } catch (error) {
        return markCancelled(error);
      }
      verifyRuns += 1;
      const redRun = result.passed ? red : red + 1;
      lastReport = store.saveTurnVerify(
        context,
        turn,
        formatVerifyReport(result, {
          run: verifyRuns,
          red: redRun,
          maxVerify,
          timeoutSec: stage?.verifyTimeoutSec ?? null,
        }),
      );
      lastResult = result.passed ? 'pass' : 'fail';
      if (result.infraError !== null) {
        record.status = 'failed';
        store.save(record, context);
        store.saveExecution(context, record, 'failed', result.infraError, null, false, finalFields(extraFields()));
        break;
      }
      if (result.passed) {
        eventReporter.emit('verify.passed', 'all commands passed', { turn, report: lastReport });
        record.status = 'completed';
        store.save(record, context);
        store.saveExecution(context, record, 'completed', null, outcome, false, finalFields(extraFields()));
        store.publishVerifyReport(context, turn);
        break;
      }
      red += 1;
      const failed = result.commands.find((item) => item.status === 'fail' || item.status === 'timed_out');
      eventReporter.emit('verify.failed', `${failed?.command ?? 'verify'} failed`, {
        turn,
        red,
        max_verify: maxVerify,
        command: failed?.command ?? null,
        status: failed?.status ?? null,
        exit_code: failed?.exitCode ?? null,
        report: lastReport,
      });
      if (red >= maxVerify) {
        failureReason = VERIFY_EXHAUSTED;
        record.status = 'failed';
        store.save(record, context);
        store.saveExecution(
          context,
          record,
          'failed',
          `Verify failed ${red} times.`,
          null,
          false,
          finalFields(extraFields(failureReason)),
        );
        outcome = null;
        break;
      }
      store.saveExecutionProgress(context, record, extraFields() ?? {});
      const report = readFileSync(path.join(context.directory, lastReport), 'utf8');
      const sessionDirectory = path.dirname(path.dirname(context.directory));
      const taskFile = path.join(sessionDirectory, 'task.md');
      let taskPointer: string | null = null;
      try {
        if (statSync(taskFile).isFile()) taskPointer = taskFile;
      } catch {
        taskPointer = null;
      }
      const repair = buildVerifyRepairPrompt(
        report,
        red,
        maxVerify,
        artifactName ? path.join(context.artifactDirectory, artifactName) : null,
        taskPointer,
        taskPointer === null ? null : sessionDirectory,
      );
      record.history.push({ role: 'user', content: repair });
      store.save(record, context);
      // pending_turn keeps resume from counting a turn short after an empty reply.
      store.saveExecutionProgress(context, record, { turn_kind: 'repair', pending_turn: turn + 1 });
      turn += 1;
      currentAgentId = record.agentId;
      currentSession = null;
      currentPrompt = currentAgentId
        ? repair
        : flattenHistory(record.history as { role: string; content: string }[]);
      currentPrompt = renderProviderPrompt(currentPrompt, { ...sessionPaths(context, sessionId),
        contract: currentAgentId ? 'reminder' : 'full', turn: 'repair', decisionValues, decisionInstructions: stage?.decisionInstructions, ask, protocol, questionFile, handoffFile,
        artifactDirectory: context.artifactDirectory, artifactName, artifactFiles: promptArtifactFiles(stage === null ? [] : allStageArtifacts(stage)),
      });
    }
    const sessionStatus = store.readSessionStatus(context.sessionId);
    return {
      agent_id: record.agentId || '',
      options: { ...record.options },
      session_id: context.sessionId,
      execution_id: context.executionId,
      artifact_directory: context.artifactDirectory,
      outcome_status: outcome?.status ?? '',
      ...(outcome?.status === 'question' ? {
        questions: outcome.questions, questions_file: path.join(context.directory, 'questions.json'),
      } : {}),
      outcome_decision: outcome?.decision ?? '',
      session_status: typeof sessionStatus.status === 'string' ? sessionStatus.status : '',
      response: responseText,
      failure_reason: failureReason,
      ...(failureDetail === '' ? {} : { failure_detail: failureDetail }),
      failure_kind: classification?.kind ?? '',
      reset_at: classification?.kind === 'quota' && classification.resetAt ? classification.resetAt : '',
      client: eventReporter.client,
      execution_status: record.status,
    };
  }

  private carryExhaustedArtifact(
    store: SessionStore,
    context: ExecutionContext,
    resumeExecutionId: string,
    artifactName: string,
  ): void {
    const previous = store
      .executionSnapshots(context.sessionId)
      .find((snapshot) => snapshot.executionId === resumeExecutionId);
    if (previous === undefined || previous.failureReason !== VERIFY_EXHAUSTED) return;
    store.carryVerifyArtifact(previous.artifactDirectory, context, artifactName);
  }

  private cachedCliVersion(client: CliClient, clientId: string, workspace: string): string | null {
    const key = clientId.toLowerCase();
    if (this.cliVersions.has(key)) return this.cliVersions.get(key) ?? null;
    const version = readCliVersion(client, workspace);
    this.cliVersions.set(key, version);
    return version;
  }

  private async runTurn(
    client: CliClient,
    model: string,
    workspace: string,
    prompt: string,
    agentId: string | null,
    newSession: NewSession | null,
    options: Record<string, string>,
    eventReporter: ProviderEventReporter,
    store: SessionStore,
    context: ExecutionContext,
    turn: number,
  ): Promise<TurnResult> {
    const tmp = mkdtempSync(path.join(tmpdir(), 'migent_'));
    try {
      const promptFile = path.join(tmp, 'prompt.txt');
      const lastMessageFile = path.join(tmp, 'last_message.txt');
      writeFileSync(promptFile, prompt, 'utf8');
      const spec = client.runCommand({
        model,
        workspace,
        prompt,
        agentId,
        newAgentId: newSession?.agentId ?? null,
        promptFile,
        lastMessageFile,
        options,
      });
      // One parser per turn: a client's parser may keep state between lines.
      const parseEvent = client.createEventParser();
      const debugStep = debugEnabled()
        ? (step: string, fromWrapper = false) => {
            const line = `${new Date().toISOString()} turn=${turn} ${fromWrapper ? 'wrapper: ' : ''}${step}`;
            // Wrapper lines already reached stderr through the tee.
            if (!fromWrapper) log(`debug: ${line}`);
            store.appendDebugLog(context, line);
          }
        : null;
      // Every id this turn may own on the CLI's server: the one Migent holds, and any
      // different one the CLI reports. Cleanup targets all of them.
      const expectedId = agentId || newSession?.agentId || null;
      const knownIds = new Set<string>(expectedId ? [expectedId] : []);
      const reports = new Map<string, InterruptReport>();
      let mismatchReported = false;
      const reportMismatch = (reported: string) => {
        if (expectedId === null || reported === expectedId || mismatchReported) return;
        mismatchReported = true;
        eventReporter.emit(
          'provider.warning',
          `provider reported session ${reported}, not the expected ${expectedId}; both are targeted for cleanup`,
          { expected_agent_id: expectedId, reported_agent_id: reported },
        );
      };
      const cleanup = async (phase: 'before' | 'after', reason: StopReason): Promise<boolean> => {
        let attempted = false;
        for (const id of [...knownIds]) {
          // After the process is gone, only sessions not yet seen interrupted are asked again.
          if (phase === 'after' && reports.get(id)?.outcome === 'interrupted') continue;
          const report = await interruptSession(client, id, workspace, this.interruptPolicy);
          if (report === null) continue;
          attempted = true;
          reports.set(id, report);
          const details = { agent_id: id, reason, phase, outcome: report.outcome, attempts: report.attempts };
          if (isSettled(report)) {
            eventReporter.emit('provider.interrupt', `session ${id}: ${report.outcome}`, details);
          } else if (phase === 'after') {
            eventReporter.emit(
              'provider.warning',
              `could not confirm session ${id} stopped (${report.detail}); agent id retained for recovery`,
              details,
            );
          }
        }
        return attempted;
      };
      const summarizer = new StreamSummarizer(client.eventLabel !== undefined);
      const result = await this.executor.run(spec, workspace, {
        onDebug: debugStep,
        // Only a client with a server-side interrupt gets hooks, and so the exit grace period.
        ...(client.interruptCommand === undefined
          ? {}
          : {
              onInterrupt: (reason: StopReason) => cleanup('before', reason),
              onStopped: (reason: StopReason) => cleanup('after', reason),
            }),
        onOutput: (line) => {
          summarizer.add(line, client.eventLabel?.(line) ?? null);
          const reported = client.sessionIdFromLine?.(line) ?? null;
          if (reported !== null && !knownIds.has(reported)) {
            knownIds.add(reported);
            reportMismatch(reported);
          }
          const event = parseEvent(line);
          if (!isRecord(event) || typeof event.event !== 'string') return;
          // The runner alone decides whether a turn failed. A protocol-level failure the CLI
          // announces mid-stream stays visible as a diagnostic, never as a second verdict.
          eventReporter.emit(
            event.event === 'provider.turn_failed' || event.event === 'provider.turn_completed'
              ? 'provider.error'
              : event.event,
            typeof event.summary === 'string' ? event.summary : null,
            isRecord(event.details) ? event.details : null,
          );
        },
        onHeartbeat: (elapsed) => {
          eventReporter.emit('provider.heartbeat', `running for ${elapsed}s`, {
            elapsed_seconds: elapsed,
          });
        },
        onStart: (info) => {
          store.saveProcessMetadata(context, info);
        },
      });
      const { stdout, error: executorError, exitCode, failure } = result;
      const parsed = client.parseRun(stdout, lastMessageFile);
      if (parsed.sessionId) reportMismatch(parsed.sessionId);
      const classification = classifyFinishedProcess(client, stdout, exitCode, executorError);
      let invokeError = executorError;
      if (exitCode === 0 && classification !== null) invokeError = classification.message;
      let usage: UsageCapture | null = null;
      try {
        const captured = client.captureUsage(stdout);
        usage = isRecord(captured) ? captured : null;
      } catch {
        usage = null;
      }
      return {
        responseText: parsed.text,
        sessionId: parsed.sessionId,
        invokeError,
        argv: spec.argv,
        usage,
        classification,
        source: parsed.source,
        exitCode,
        ...(failure ? { failure } : {}),
        ...(result.process ? { facts: result.process } : {}),
        summarizer,
      };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

/** What one CLI process turn produced, for the turn loop. Internal. */
interface TurnResult {
  responseText: string;
  sessionId: string | null;
  invokeError: string | null;
  argv: string[];
  usage: UsageCapture | null;
  classification: FailureClassification | null;
  source: ResponseSource | undefined;
  exitCode: number | null;
  failure?: ExecutionFailure;
  facts?: ProcessFacts;
  summarizer: StreamSummarizer;
}

function classifyFinishedProcess(
  client: CliClient,
  stdout: string,
  exitCode: number | null,
  executorError: string | null,
): FailureClassification | null {
  if (exitCode === null) return { kind: 'provider', origin: 'start', message: executorError ?? '' };
  const classified = classifyFailure(client, stdout, exitCode);
  // Signal death (negative, or the shell's 128 + signal) is not a normal exit: its reply never counts.
  const signalled = exitCode < 0 || (exitCode > 128 && exitCode <= 128 + 64);
  return classified !== null && signalled ? { ...classified, origin: 'start' } : classified;
}

function loadRunStage(store: SessionStore, sessionId: string, stageId: string): StageSpec | null {
  const sessionStatus = store.readSessionStatus(sessionId);
  if (sessionStatus.workflow_id === 'agent') return null;
  const frozen = loadFrozenWorkflow(path.join(store.sessionsDirectory, sessionId));
  if (frozen) return frozen.stages[stageId] ?? null;
  const workflowPath = sessionStatus.workflow_path;
  if (typeof workflowPath === 'string') {
    const stage = loadStage(store.workspace, workflowPath, stageId);
    if (stage !== null) return stage;
  }
  const workflowId = sessionStatus.workflow_id;
  if (typeof workflowId !== 'string') return null;
  try {
    return loadNamedWorkflow(store.workspace, workflowId).stages[stageId] ?? null;
  } catch (error) {
    if (error instanceof ConfigurationError) return null;
    throw error;
  }
}

function validateSessionProfile(
  previousClient: string,
  previousModel: string,
  previousOptions: Record<string, string>,
  client: string,
  model: string,
  options: Record<string, string>,
): void {
  if (
    previousClient !== client ||
    previousModel !== model ||
    !sameOptions(previousOptions, options)
  ) {
    throw new ConfigurationError(
      'Cannot resume an agent session with a different client, model, or options: ' +
        `recorded ${previousClient}/${previousModel}, requested ${client}/${model}. Start a new attempt.`,
    );
  }
}

function sameOptions(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function resolveWorkspace(workspace: string): string {
  const expanded = expandHome(workspace);
  const resolved = path.resolve(expanded);
  try {
    if (!statSync(resolved).isDirectory()) throw new Error('missing');
    return resolved;
  } catch (error) {
    if (error instanceof Error && error.message === 'missing') {
      throw new Error(`Workspace does not exist: ${workspace}`, { cause: error });
    }
    if (isMissingPath(error)) throw new Error(`Workspace does not exist: ${workspace}`, { cause: error });
    throw error;
  }
}

function expandHome(target: string): string {
  if (target === '~') return platformHome() || target;
  if (target.startsWith('~/')) return path.join(platformHome() || '', target.slice(2));
  return target;
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

interface PendingVerify {
  responseText: string;
  outcome: StageOutcome | null;
  invokeError: string | null;
  gateFailure: GateFailure | null;
}

interface TurnDrive {
  client: CliClient;
  clientId: string;
  model: string;
  workspacePath: string;
  resolvedOptions: Record<string, string>;
  profile: Record<string, string>;
  store: SessionStore;
  context: ExecutionContext;
  record: AgentSessionRecord;
  eventReporter: ProviderEventReporter;
  sessionId: string | null;
  stage: StageSpec | null;
  decisionValues: string[];
  artifactName: string | null;
  verifyCommands: string[];
  maxVerify: number;
  verifyTimeoutSec: number | null;
  turn: number;
  red: number;
  verifyRuns: number;
  lastReport: string | null;
  lastResult: 'pass' | 'fail' | null;
  currentPrompt: string;
  currentAgentId: string | null;
  currentSession: NewSession | null;
  pendingVerify: PendingVerify | null;
  corrections: CorrectionLedger;
  /** Response protocol the execution runs under. */
  protocol: number;
  /** The first turn must not delete the file a resumed correction asks the agent to repair. */
  keepFile?: boolean;
}

/**
 * Empty replies leave no assistant message, so the count can fall short of the real turn. A queued
 * correction saves the turn it runs as; the real turn is never lower than that.
 */
function persistedTurn(metadata: Record<string, unknown>, counted: number): number {
  const saved = metadata.pending_turn;
  return typeof saved === 'number' && saved > counted ? saved : counted;
}

function readExecutionJson(directory: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path.join(directory, 'execution.json'), 'utf8')) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function verifyProgress(metadata: Record<string, unknown>): {
  red: number;
  runs: number;
  lastReport: string | null;
  lastResult: 'pass' | 'fail' | null;
} {
  const verify = isRecord(metadata.verify) ? metadata.verify : null;
  const lastResult = verify?.last_result === 'pass' || verify?.last_result === 'fail' ? verify.last_result : null;
  return {
    red: typeof verify?.red === 'number' ? verify.red : 0,
    runs: typeof verify?.runs === 'number' ? verify.runs : 0,
    lastReport: typeof verify?.last_report === 'string' ? verify.last_report : null,
    lastResult,
  };
}

function frozenDocument(context: ExecutionContext) {
  return loadFrozenWorkflow(path.dirname(path.dirname(context.directory)));
}

function savedResponse(context: ExecutionContext, last: Record<string, string>): string {
  try {
    return readFileSync(path.join(context.directory, 'response.md'), 'utf8');
  } catch {
    return typeof last.content === 'string' ? last.content : '';
  }
}

function savedOutcome(
  store: SessionStore,
  context: ExecutionContext,
  turn: number,
  responseText: string,
  context2: OutcomeContext,
): StageOutcome | null {
  try {
    const raw = JSON.parse(
      readFileSync(path.join(store.turnDirectory(context, turn), 'outcome.json'), 'utf8'),
    ) as unknown;
    if (isRecord(raw) && raw.status === 'complete') {
      return new StageOutcome(
        raw.status,
        typeof raw.blocker === 'string' && raw.blocker ? raw.blocker : null,
        typeof raw.decision === 'string' && raw.decision ? raw.decision : null,
      );
    }
  } catch {
    // The saved response is the fallback.
  }
  return resolveStageOutcome(responseText, context2);
}

function readCliVersion(client: CliClient, workspace: string): string | null {
  const spec = client.versionCommand();
  const [command] = spec.argv;
  if (command === undefined) return null;
  const result = spawnProviderSync(command, spec.argv.slice(1), {
    encoding: 'utf8',
    timeout: 10_000,
    cwd: workspace,
  });
  if (result.error || result.status !== 0) return null;
  return client.parseVersion(result.stdout ?? '');
}

function readGitFacts(workspace: string): { git_head: string | null; git_dirty: boolean | null } {
  const head = gitOutput(workspace, ['rev-parse', 'HEAD']);
  const porcelain = gitOutput(workspace, ['status', '--porcelain']);
  if (head === null || porcelain === null || head.trim() === '') return { git_head: null, git_dirty: null };
  return { git_head: head.trim(), git_dirty: porcelain.trim() !== '' };
}

function gitOutput(workspace: string, args: string[]): string | null {
  const result = spawnProviderSync('git', args, {
    encoding: 'utf8',
    timeout: 10_000,
    cwd: workspace,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

function promptArtifactFiles(
  files: readonly { artifact: StageArtifact; decision: string | null }[],
): { file: string; description: string | null; required: boolean; decision: string | null }[] {
  return files.map(({ artifact, decision }) => ({
    file: artifact.file,
    description: artifact.description,
    required: artifact.required,
    decision,
  }));
}
