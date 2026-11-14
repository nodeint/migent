import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CliClient, ClientRegistry, ExecutionSnapshot } from '@nodeint/migent-kernel';
import { createNewSession, sessionOptions } from '@nodeint/migent-kernel';
import { CommandExecutor, DEFAULT_TIMEOUT_SEC, type StopReason } from '@nodeint/migent-kernel';
import {
  DEFAULT_INTERRUPT_POLICY,
  type InterruptPolicy,
  type InterruptReport,
  interruptSession,
  isSettled,
} from '@nodeint/migent-kernel';
import { StreamSummarizer } from '@nodeint/migent-kernel';
import { VerifyRunner } from '@nodeint/migent-kernel';
import { ConfigurationError } from '@nodeint/migent-kernel';
import { readCorrectionLedger } from '@nodeint/migent-kernel';
import {
  CURRENT_RESPONSE_PROTOCOL,
  LEGACY_RESPONSE_PROTOCOL,
} from '@nodeint/migent-prompts';
import { type ExecutionContext, SessionStore, stringOptions } from '@nodeint/migent-session';

import { ProviderEventReporter } from './provider-events.js';
import {
  type ContinuedDrive,
  driveBase,
  type OpenedRun,
  previousReportPath,
  type PriorExecution,
  renderFirstPrompt,
} from './run-drive.js';
import {
  persistedTurn,
  readCliVersion,
  readExecutionJson,
  readGitFacts,
  storedProtocol,
  verifyProgress,
} from './run-facts.js';
import { loadRunningExecution, reopenConversation, resumePendingPrompt, savedVerdict } from './run-resume.js';
import {
  carryExhaustedArtifact,
  loadRunStage,
  resolveWorkspace,
  type RunRequest,
  type StageFacts,
  stageFacts,
  validateSessionProfile,
} from './run-setup.js';
import { TurnLoop } from './turn-loop.js';
import { finishTurn, forwardProviderEvent, turnDebugStep } from './turn-process.js';
import {
  handoffPath,
  questionRequestPath,
  type RunResult,
  type RunTurnArgs,
  type TurnDrive,
  type TurnResult,
} from './turn-types.js';

export type { RunRequest } from './run-setup.js';
export type { RunResult } from './turn-types.js';


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
    const opened = this.openRun(request);
    const { store, context, record, isNew, agentId } = opened;
    const stage = opened.sessionId === null ? null : loadRunStage(store, context.sessionId, opened.stageId);
    const facts = stageFacts(stage);
    const resumeExecutionId = request.resumeExecutionId ?? null;
    const prior = this.priorExecution({ store, context, stageId: opened.stageId, isNew, agentId }, resumeExecutionId);
    carryPriorArtifacts({ store, context, ...facts }, prior.previous, resumeExecutionId);
    const turnPrompt = renderFirstPrompt({ request, opened, stage, facts, prior });
    store.savePrompt(context, turnPrompt);
    const turnKind = request.turn ?? null;
    store.saveExecutionProgress(context, record, {
      response_protocol: prior.protocol,
      turn_kind: turnKind,
      ...(request.resumeSkipped ? { resume_skipped: request.resumeSkipped } : {}),
      ...(request.resumePolicy ? { resume_policy: request.resumePolicy } : {}),
    });
    this.emitStageStarted(opened, opened.eventReporter);
    const { progress, previous } = prior;
    return this.driveTurns({
      ...driveBase(opened, stage, facts),
      turn: 1,
      red: progress?.red ?? 0,
      verifyRuns: progress?.runs ?? 0,
      lastReport: previousReportPath(previous, progress, context.directory),
      lastResult: progress?.lastResult ?? null,
      currentPrompt: turnPrompt,
      currentAgentId: agentId,
      currentSession: opened.newSession,
      pendingVerify: null,
      corrections: {},
      protocol: prior.protocol,
    });
  }

  /** Finish a cancelled execution that has been reopened in place. Does not create an attempt. */
  public async continueCancelled(workspace: string, sessionId: string, executionId: string): Promise<RunResult> {
    const workspacePath = resolveWorkspace(workspace);
    const store = new SessionStore(workspacePath, undefined, this.registry);
    const { context, metadata } = loadRunningExecution(store, sessionId, executionId);
    const stageId = typeof metadata.stage_id === 'string' ? metadata.stage_id : 'agent';
    const clientId = store.executionClient(sessionId, executionId);
    const model = typeof metadata.model === 'string' ? metadata.model : '';
    const { client, resolvedOptions, profile } = this.resolveClient(clientId, stringOptions(metadata.options));
    const record = reopenConversation({ store, context }, { clientId, model, workspace: workspacePath });
    const stage = loadRunStage(store, sessionId, stageId);
    const facts = stageFacts(stage);
    const eventReporter = this.eventReporterFor({ store, context }, clientId, model);
    const progress = verifyProgress(metadata);
    const stamped = storedProtocol(metadata);
    const protocol = Math.max(LEGACY_RESPONSE_PROTOCOL, stamped);
    // A legacy execution continues under protocol 2 from here on; record it so later resumes, the
    // contract selection and the execution metadata agree.
    if (stamped !== protocol) store.saveExecutionProgress(context, record, { response_protocol: protocol });
    const common: ContinuedDrive = {
      ...driveBase({
        client, clientId, model, workspacePath, resolvedOptions, profile,
        store, context, record, eventReporter, sessionId,
      }, stage, facts),
      red: progress.red,
      verifyRuns: progress.runs,
      lastReport: progress.lastReport,
      lastResult: progress.lastResult,
      currentSession: null,
      corrections: readCorrectionLedger(metadata),
      protocol,
    };
    return this.continueFromHistory(common, { metadata, sessionId, executionId, stamped, facts });
  }

  // Resumes a reopened execution either from its pending prompt or from its last saved reply.
  private continueFromHistory(
    common: ContinuedDrive,
    saved: {
      metadata: Record<string, unknown>; sessionId: string; executionId: string; stamped: number; facts: StageFacts;
    },
  ): Promise<RunResult> {
    const { store, context, record, stage, protocol } = common;
    const { metadata, sessionId, executionId, stamped, facts } = saved;
    const assistants = record.history.filter((item) => item.role === 'assistant').length;
    const last = record.history.at(-1);
    const lastRole = last && typeof last.role === 'string' ? last.role : '';
    if (last === undefined || lastRole !== 'assistant') {
      if (lastRole !== 'user' || typeof last?.content !== 'string' || last.content === '') {
        throw new ConfigurationError(`Execution ${executionId} has no prompt to resume.`);
      }
      const { agentId } = record;
      const resumed = resumePendingPrompt(
        { store, context, record, metadata, sessionId, stage, protocol, stamped },
        { executionId, assistants, last: last.content },
      );
      return this.driveTurns({
        ...common,
        turn: persistedTurn(metadata, Math.max(1, assistants + 1)),
        currentPrompt: resumed.currentPrompt,
        currentAgentId: agentId,
        pendingVerify: null,
        keepFile: resumed.keepFile,
      });
    }
    const turn = persistedTurn(metadata, Math.max(1, assistants));
    const pendingVerify = savedVerdict({ store, context, turn, last }, {
      required: sessionId !== null, decisionValues: facts.decisionValues, ask: facts.ask, protocol,
      questionFile: questionRequestPath(context), handoffFile: handoffPath(context),
    });
    return this.driveTurns({
      ...common,
      turn,
      currentPrompt: '',
      currentAgentId: record.agentId,
      pendingVerify,
    });
  }

  // Resolves the client, loads or creates the run record, and marks the execution running.
  private openRun(request: RunRequest): OpenedRun {
    const workspacePath = resolveWorkspace(request.workspace);
    const stageAttempt = request.stageAttempt ?? null;
    const executionOrder = request.executionOrder ?? null;
    assertRunOrdering(stageAttempt, executionOrder);
    const clientId = request.client;
    const { client, resolvedOptions, profile } = this.resolveClient(clientId, { ...(request.options ?? {}) });
    const store = new SessionStore(workspacePath, undefined, this.registry);
    const [record, isNew, context] = loadOrCreateRun(
      store,
      request,
      { workspacePath, stageAttempt, executionOrder, profile },
    );
    request.onExecution?.(context.executionId);
    const newSession = isNew ? createNewSession(client) : null;
    if (newSession?.agentId) record.agentId = newSession.agentId;
    record.history.push({ role: 'user', content: request.prompt });
    record.status = 'running';
    store.save(record, context);
    store.saveExecution(context, record, { status: 'running' });
    return {
      client, clientId, model: request.model, workspacePath, resolvedOptions, profile, store, context, record,
      eventReporter: this.eventReporterFor({ store, context }, clientId, request.model),
      sessionId: request.sessionId ?? null,
      stageId: request.stageId ?? 'agent',
      isNew,
      newSession,
      agentId: isNew ? null : record.agentId,
    };
  }

  private driveTurns(state: TurnDrive): Promise<RunResult> {
    const loop = new TurnLoop(
      state,
      (args) => this.runTurn(args),
      this.verifyRunner,
    );
    return loop.drive();
  }

  private resolveClient(
    clientId: string,
    resolvedOptions: Record<string, string>,
  ): { client: CliClient; resolvedOptions: Record<string, string>; profile: Record<string, string> } {
    const client = this.registry.get(clientId);
    client.validateOptions(resolvedOptions);
    return { client, resolvedOptions, profile: sessionOptions(client, resolvedOptions) };
  }

  private eventReporterFor(
    target: { store: SessionStore; context: ExecutionContext },
    clientId: string,
    model: string,
  ): ProviderEventReporter {
    return new ProviderEventReporter(target, { client: clientId, model, itemProgress: this.itemProgress });
  }

  // Reads the source execution a run resumes: its protocol, the answered question, and verify progress.
  private priorExecution(
    run: { store: SessionStore; context: ExecutionContext; stageId: string; isNew: boolean; agentId: string | null },
    resumeExecutionId: string | null,
  ): PriorExecution {
    const { store, context, stageId, isNew, agentId } = run;
    const source = resumeExecutionId
      ? store.executionContext(context.sessionId, resumeExecutionId) : null;
    const sourceMetadata = source === null ? null : readExecutionJson(source.directory);
    // A new conversation takes the current protocol;
    // a continued one keeps its source's, never past 2 from a legacy stamp.
    const protocol = isNew || source === null
      ? this.newConversationProtocol
      : Math.max(LEGACY_RESPONSE_PROTOCOL, storedProtocol(sourceMetadata));
    const previous = resumeExecutionId
      ? store.executionSnapshots(context.sessionId).find((row) => row.executionId === resumeExecutionId
        && row.stageId === stageId && row.outcomeStatus === 'question')
      : undefined;
    const previousMetadata = previous
      ? JSON.parse(
        readFileSync(path.join(path.dirname(previous.artifactDirectory), 'execution.json'), 'utf8'),
      ) as Record<string, unknown>
      : null;
    const progress = previousMetadata ? verifyProgress(previousMetadata) : null;
    // Answering a question on the same agent: the conversation already holds the contract and stage instructions.
    const sameConversation = previous !== undefined && agentId !== null && agentId !== ''
      && storedProtocol(previousMetadata) === protocol;
    return { protocol, previous, progress, sameConversation };
  }

  private emitStageStarted(
    run: { client: CliClient; clientId: string; model: string; workspacePath: string; profile: Record<string, string> },
    eventReporter: ProviderEventReporter,
  ): void {
    const { client, clientId, model, workspacePath, profile } = run;
    const started: Record<string, unknown> = {
      cli_version: this.cachedCliVersion(client, clientId, workspacePath),
      ...readGitFacts(workspacePath),
    };
    if (Object.keys(profile).length > 0) started.options = profile;
    eventReporter.emit('provider.stage_started', `${clientId}/${model}`, started);
  }

  // Tracks every session id a turn may own on the CLI's server and interrupts them on stop.
  private trackTurnSessions(
    turn: { client: CliClient; workspace: string; eventReporter: ProviderEventReporter },
    expectedId: string | null,
  ): {
    observe: (reported: string) => void;
    reportMismatch: (reported: string) => void;
    cleanup: (phase: 'before' | 'after', reason: StopReason) => Promise<boolean>;
  } {
    const { client, workspace, eventReporter } = turn;
    // Every id this turn may own on the CLI's server: the one Migent holds, and any
    // different one the CLI reports. Cleanup targets all of them.
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
        const report = await interruptSession(client, { agentId: id, cwd: workspace }, this.interruptPolicy);
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
    const observe = (reported: string): void => {
      if (knownIds.has(reported)) return;
      knownIds.add(reported);
      reportMismatch(reported);
    };
    return { observe, reportMismatch, cleanup };
  }

  private cachedCliVersion(client: CliClient, clientId: string, workspace: string): string | null {
    const key = clientId.toLowerCase();
    if (this.cliVersions.has(key)) return this.cliVersions.get(key) ?? null;
    const version = readCliVersion(client, workspace);
    this.cliVersions.set(key, version);
    return version;
  }

  private async runTurn(args: RunTurnArgs): Promise<TurnResult> {
    const {
      client,
      model,
      workspace,
      prompt,
      agentId,
      newSession,
      options,
      eventReporter,
      store,
      context,
      turn,
    } = args;
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
      const debugStep = turnDebugStep(store, context, turn);
      const sessions = this.trackTurnSessions(
        { client, workspace, eventReporter },
        agentId || newSession?.agentId || null,
      );
      const summarizer = new StreamSummarizer(client.eventLabel !== undefined);
      const result = await this.executor.run(spec, workspace, {
        onDebug: debugStep,
        // Only a client with a server-side interrupt gets hooks, and so the exit grace period.
        ...(client.interruptCommand === undefined
          ? {}
          : {
              onInterrupt: (reason: StopReason) => sessions.cleanup('before', reason),
              onStopped: (reason: StopReason) => sessions.cleanup('after', reason),
            }),
        onOutput: (line) => {
          summarizer.add(line, client.eventLabel?.(line) ?? null);
          const reported = client.sessionIdFromLine?.(line) ?? null;
          if (reported !== null) sessions.observe(reported);
          forwardProviderEvent(eventReporter, parseEvent(line));
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
      return finishTurn(client, { result, argv: spec.argv, lastMessageFile, summarizer }, sessions.reportMismatch);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

function assertRunOrdering(stageAttempt: number | null, executionOrder: number | null): void {
  if (stageAttempt !== null && stageAttempt < 1) throw new Error('Stage attempt must be at least 1.');
  if (executionOrder !== null && executionOrder < 1) {
    throw new Error('Execution order must be at least 1.');
  }
}

// Carries the answered execution's artifacts, and an exhausted verify artifact, into the new execution.
function carryPriorArtifacts(
  run: { store: SessionStore; context: ExecutionContext; artifactFiles: StageFacts['artifactFiles']; verifyCommands: readonly string[] },
  previous: ExecutionSnapshot | undefined,
  resumeExecutionId: string | null,
): void {
  const { store, context, artifactFiles, verifyCommands } = run;
  if (previous) {
    for (const item of artifactFiles) {
      store.carryVerifyArtifact(previous.artifactDirectory, context, item.artifact.file);
    }
  }
  if (resumeExecutionId && verifyCommands.length > 0) {
    for (const item of artifactFiles) carryExhaustedArtifact(
      store,
      context,
      { resumeExecutionId, artifactName: item.artifact.file },
    );
  }
}

function loadOrCreateRun(
  store: SessionStore,
  request: RunRequest,
  run: {
    workspacePath: string;
    stageAttempt: number | null;
    executionOrder: number | null;
    profile: Record<string, string>;
  },
): ReturnType<SessionStore['loadOrCreate']> {
  const { workspacePath, stageAttempt, executionOrder, profile } = run;
  const clientId = request.client;
  const sessionId = request.sessionId ?? null;
  const stageId = request.stageId ?? 'agent';
  return store.loadOrCreate(
    {
      client: clientId,
      model: request.model,
      options: profile,
      workspace: workspacePath,
      sessionId,
      stageId,
      stageAttempt,
      executionOrder,
      prompt: request.prompt,
      humanInput: request.humanInput ?? null,
      resumeExecutionId: request.resumeExecutionId ?? null,
      allowCancelledSibling: request.allowCancelledSibling === true,
      validateResume: (record) => validateSessionProfile(
        record,
        { client: clientId, model: request.model, options: profile },
      ),
    },
  );
}
