import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CliClient, ClientRegistry, FailureClassification, NewSession, UsageCapture } from '@nodeint/migent-kernel';
import { classifyFailure, createNewSession, sessionOptions } from '@nodeint/migent-kernel';
import { CommandExecutor, DEFAULT_TIMEOUT_SEC, type StopReason } from '@nodeint/migent-kernel';
import { DEFAULT_INTERRUPT_POLICY, type InterruptPolicy, type InterruptReport, interruptSession, isSettled } from '@nodeint/migent-kernel';
import { StreamSummarizer } from '@nodeint/migent-kernel';
import { VERIFY_EXHAUSTED } from '@nodeint/migent-kernel';
import { VerifyRunner } from '@nodeint/migent-kernel';
import { ConfigurationError } from '@nodeint/migent-kernel';
import { debugEnabled, flattenHistory, log } from '@nodeint/migent-kernel';
import { classifyGateError, type GateFailure, readCorrectionLedger, ruleForTurn } from '@nodeint/migent-kernel';
import { StageOutcome } from '@nodeint/migent-kernel';
import { platformHome } from '@nodeint/migent-kernel';
import { HandoffFileError } from '@nodeint/migent-kernel';
import { QuestionFileError } from '@nodeint/migent-kernel';
import { CURRENT_RESPONSE_PROTOCOL, renderProtocolUpdate, renderProviderPrompt, type TurnKind } from '@nodeint/migent-prompts';
import { loadFrozenWorkflow } from '@nodeint/migent-session';
import { AgentSessionRecord, type ExecutionContext, SessionStore, stringOptions } from '@nodeint/migent-session';
import { isRecord } from '@nodeint/migent-workflow';
import { allStageArtifacts, loadNamedWorkflow, loadStage, type StageSpec } from '@nodeint/migent-workflow';

import { ProviderEventReporter } from './provider-events.js';
import { persistedTurn, readCliVersion,readExecutionJson, readGitFacts, savedOutcome, savedResponse, storedProtocol, storedTurn, verifyProgress } from './run-facts.js';
import { TurnLoop } from './turn-loop.js';
import { handoffPath, promptArtifactFiles, questionRequestPath, type RunResult, sessionPaths, type TurnDrive, type TurnResult } from './turn-types.js';

export type { RunResult } from './turn-types.js';

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
    const { decisionValues, ask, artifactFiles, artifactName, verifyCommands } = stageFacts(stage);
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
    const { decisionValues, ask, artifactFiles, artifactName, verifyCommands } = stageFacts(stage);
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
    const common: Omit<TurnDrive, 'turn' | 'currentPrompt' | 'currentAgentId' | 'pendingVerify' | 'keepFile'> = {
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
      red: progress.red,
      verifyRuns: progress.runs,
      lastReport: progress.lastReport,
      lastResult: progress.lastResult,
      currentSession: null,
      corrections,
      protocol,
    };
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
        ...common,
        turn: persistedTurn(metadata, Math.max(1, assistants + 1)),
        currentPrompt,
        currentAgentId: agentId,
        pendingVerify: null,
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
      ...common,
      turn,
      currentPrompt: '',
      currentAgentId: record.agentId,
      pendingVerify: { responseText, outcome, invokeError, gateFailure },
    });
  }

  private driveTurns(state: TurnDrive): Promise<RunResult> {
    const loop = new TurnLoop(
      state,
      (args) =>
        this.runTurn(
          args.client,
          args.model,
          args.workspace,
          args.prompt,
          args.agentId,
          args.newSession,
          args.options,
          args.eventReporter,
          args.store,
          args.context,
          args.turn,
        ),
      this.verifyRunner,
    );
    return loop.drive();
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

function classifyFinishedProcess(
  client: CliClient,
  stdout: string,
  exitCode: number | null,
  executorError: string | null,
): FailureClassification | null {
  if (exitCode === null) return { kind: 'provider', origin: 'start', message: executorError === null ? '' : executorError };
  const classified = classifyFailure(client, stdout, exitCode);
  // Signal death (negative, or the shell's 128 + signal) is not a normal exit: its reply never counts.
  const signalled = exitCode < 0 || (exitCode > 128 && exitCode <= 128 + 64);
  return classified !== null && signalled ? { ...classified, origin: 'start' } : classified;
}

/** What a stage says about its decisions, questions, artifacts, and verify list. */
function stageFacts(stage: StageSpec | null) {
  const decisionValues = stage?.decisionValues ?? [];
  const ask = stage?.ask ?? (stage === null ? 'human' : null);
  const artifactFiles = stage === null ? [] : allStageArtifacts(stage);
  const artifactName = artifactFiles[0]?.artifact.file ?? null;
  const verifyCommands = stage?.verify ?? [];
  return { decisionValues, ask, artifactFiles, artifactName, verifyCommands };
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

