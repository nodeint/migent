/** The turn loop of one execution: provider turns, gates, corrections, verify, and repair turns. */
import { rmSync } from 'node:fs';

import {
  CancellationRequested, type CliClient, CORRECTION_FAILURE_REASONS, CORRECTION_POLICY, type CorrectionFiles,
  type CorrectionLedger, decideCorrection, type FailureClassification, flattenHistory, formatVerifyReport,
  type GateFailure, log, type NewSession, StageOutcome, VERIFY_EXHAUSTED,
  type VerifyRunner, type VerifyRunResult,
} from '@nodeint/migent-kernel';
import { renderProviderPrompt } from '@nodeint/migent-prompts';
import { HANDOFF_FILE_PROTOCOL } from '@nodeint/migent-prompts';
import type { AgentSessionRecord, ExecutionContext, SessionStore } from '@nodeint/migent-session';
import { allStageArtifacts, type StageSpec } from '@nodeint/migent-workflow';

import type { ProviderEventReporter } from './provider-events.js';
import {
  assessProviderTurn,
  buildRepairPrompt,
  buildRunResult,
  checkOutputs,
  emitTurnEvents,
  evaluateGates,
  type GateEvaluation,
  type OutputCheck,
  type PersistVerdict,
  type Step,
  verifyFields,
  type VerifyVerdict,
  writeTurnDiagnostics,
} from './turn-steps.js';
import { type FreshTurn, handoffPath, type Iteration, type PendingVerify, promptArtifactFiles, questionRequestPath, type RunResult, type RunTurnArgs, sessionPaths, type TurnDrive, type TurnResult } from './turn-types.js';

/**
 * Drives the turns of one execution: provider turn, gates, correction turns, verify, and repair turns.
 * The loop state that survives correction and repair turns lives in private fields.
 */
export class TurnLoop {
  private readonly client: CliClient;
  private readonly model: string;
  private readonly workspacePath: string;
  private readonly resolvedOptions: Record<string, string>;
  private readonly profile: Record<string, string>;
  private readonly store: SessionStore;
  private readonly context: ExecutionContext;
  private readonly record: AgentSessionRecord;
  private readonly eventReporter: ProviderEventReporter;
  private readonly sessionId: string | null;
  private readonly stage: StageSpec | null;
  private readonly decisionValues: string[];
  private readonly artifactName: string | null;
  private readonly verifyCommands: string[];
  private readonly maxVerify: number;
  private readonly protocol: number;
  private readonly ask: 'human' | null;
  private readonly questionFile: string;
  private readonly handoffFile: string;
  private readonly files: CorrectionFiles;
  // The file this protocol's outcome is read from; per-turn cleanup removes it.
  private readonly signalFile: string;
  private turn: number;
  private red: number;
  private verifyRuns: number;
  private lastReport: string | null;
  private lastResult: 'pass' | 'fail' | null;
  private currentPrompt: string;
  private currentAgentId: string | null;
  private currentSession: NewSession | null;
  private pendingVerify: PendingVerify | null;
  private corrections: CorrectionLedger;
  private keepFile: boolean;
  private failureReason = '';
  private failureDetail = '';
  private classification: FailureClassification | null = null;

  constructor(
    state: TurnDrive,
    private readonly runTurn: (args: RunTurnArgs) => Promise<TurnResult>,
    private readonly verifyRunner: VerifyRunner,
  ) {
    this.client = state.client;
    this.model = state.model;
    this.workspacePath = state.workspacePath;
    this.resolvedOptions = state.resolvedOptions;
    this.profile = state.profile;
    this.store = state.store;
    this.context = state.context;
    this.record = state.record;
    this.eventReporter = state.eventReporter;
    this.sessionId = state.sessionId;
    this.stage = state.stage;
    this.decisionValues = state.decisionValues;
    this.artifactName = state.artifactName;
    this.verifyCommands = state.verifyCommands;
    this.maxVerify = state.maxVerify;
    this.protocol = state.protocol;
    this.ask = state.stage?.ask ?? (state.stage === null ? 'human' : null);
    this.turn = state.turn;
    this.red = state.red;
    this.verifyRuns = state.verifyRuns;
    this.lastReport = state.lastReport;
    this.lastResult = state.lastResult;
    this.currentPrompt = state.currentPrompt;
    this.currentAgentId = state.currentAgentId;
    this.currentSession = state.currentSession;
    this.pendingVerify = state.pendingVerify;
    this.corrections = state.corrections;
    this.questionFile = questionRequestPath(state.context);
    this.handoffFile = handoffPath(state.context);
    this.files = { protocol: state.protocol, questionFile: this.questionFile, handoffFile: this.handoffFile };
    this.signalFile = state.protocol >= HANDOFF_FILE_PROTOCOL ? this.handoffFile : this.questionFile;
    this.keepFile = state.keepFile ?? false;
  }

  public async drive(): Promise<RunResult> {
    let it: Iteration;
    while (true) {
      const pending = this.pendingVerify !== null;
      it = pending ? this.takePendingVerify() : await this.freshTurn();
      if (!pending) {
        const s = this.afterFreshTurn(it);
        if (s === 'continue') continue;
        if (s === 'stop') break;
      }
      const g = this.afterPendingGate(it);
      if (g === 'continue') continue;
      if (g === 'stop') break;
      if (this.finishWithoutVerify(it)) break;
      const verified = await this.verifyAndRepair(it);
      if (verified !== null) {
        it = verified;
        break;
      }
    }
    return this.result(it);
  }

  private markCancelled(error: unknown): never {
    if (error instanceof CancellationRequested) {
      this.eventReporter.emit('provider.cancelled', 'cancellation requested');
      this.record.status = 'cancelled';
      this.store.save(this.record, this.context);
      this.store.saveExecution(this.context, this.record, { status: 'cancelled' });
      log(`Execution ${this.context.executionId} marked cancelled.`);
    }
    throw error;
  }

  private extraFields(reason: string | null = null): Record<string, unknown> | null {
    const { verifyCommands, turn, lastResult, lastReport, verifyRuns, red, maxVerify } = this;
    return verifyFields({ verifyCommands, turn, lastResult, lastReport, verifyRuns, red, maxVerify }, reason);
  }

  // The last provider turn this execution ran; failure.md joins diagnostics.json to it.
  private finalFields(extra: Record<string, unknown> | null): Record<string, unknown> {
    return {
      ...(extra ?? {}),
      final_turn: this.turn,
    };
  }

  private outcomeFields(): Record<string, unknown> | null {
    if (CORRECTION_FAILURE_REASONS.includes(this.failureReason)) {
      return { ...(this.extraFields() ?? {}), failure_reason: this.failureReason };
    }
    const { classification } = this;
    if (classification?.kind !== 'quota') return this.extraFields();
    this.failureReason = 'quota';
    return {
      ...(this.extraFields() ?? {}),
      failure_reason: 'quota',
      retry_at: classification.resetAt,
      ...(classification.window ? { quota_window: classification.window } : {}),
    };
  }

  // Queue one correction turn when the policy grants it. False when the budget for the kind is used.
  private queueCorrection(failure: GateFailure): boolean {
    const { store, context, record, eventReporter, stage, files } = this;
    const rule = CORRECTION_POLICY[failure.kind];
    const decision = decideCorrection(failure.kind, this.corrections, this.turn);
    if (decision === 'exhausted') return false;
    // The budget is persisted before the message joins the history, so a stop between the two
    // writes sends the correction again on resume and never grants a second.
    if (decision === 'correct') {
      this.corrections = {
        ...this.corrections,
        [failure.kind]: { turn: this.turn, error_kind: failure.errorKind, error_detail: failure.detail },
      };
      store.saveExecutionProgress(context, record, { corrections: this.corrections });
      let fileField: Record<string, unknown> = {};
      if (failure.kind === 'question_file') fileField = { file: this.questionFile };
      else if (failure.kind === 'handoff') fileField = { file: this.handoffFile };
      eventReporter.emit(rule.event, `${failure.errorKind}: ${failure.detail}`, {
        turn: this.turn, error_kind: failure.errorKind, ...fileField,
      });
    }
    const used = this.corrections[failure.kind]!;
    const message = rule.render(used, files);
    record.history.push({ role: 'user', content: message });
    store.save(record, context);
    store.saveExecutionProgress(context, record, { turn_kind: rule.turnKind, pending_turn: this.turn + 1 });
    const base = record.agentId
      ? message
      : flattenHistory(record.history as { role: string; content: string }[]);
    this.currentPrompt = renderProviderPrompt(base, { ...sessionPaths(context, this.sessionId),
      contract: record.agentId ? rule.contract : 'full', turn: rule.turnKind, decisionValues: this.decisionValues,
      decisionInstructions: stage?.decisionInstructions, ask: this.ask, protocol: this.protocol,
      questionFile: this.questionFile, handoffFile: this.handoffFile, artifactDirectory: context.artifactDirectory,
      artifactName: this.artifactName,
      artifactFiles: promptArtifactFiles(stage === null ? [] : allStageArtifacts(stage)),
    });
    this.turn += 1;
    this.currentAgentId = record.agentId;
    this.currentSession = null;
    this.keepFile = rule.keepFile;
    return true;
  }

  // The budget is used: the stage fails with the original error and the kind's reason.
  private exhaust(failure: GateFailure): void {
    this.failureReason = CORRECTION_POLICY[failure.kind].failureReason;
    this.failureDetail = CORRECTION_POLICY[failure.kind].detail(failure, this.files);
  }

  // The artifact and completion-output gates. Fresh turns and resumed saved replies both run them.
  private checkOutputs(reply: StageOutcome): OutputCheck {
    const { stage, artifactName, context, store } = this;
    return checkOutputs({ stage, artifactName, context, store }, reply);
  }

  private takePendingVerify(): Iteration {
    const pending = this.pendingVerify!;
    this.pendingVerify = null;
    let { invokeError, gateFailure } = pending;
    // A saved reply passes the same output gates a fresh one does before it is accepted.
    if (invokeError === null && gateFailure === null && pending.outcome !== null) {
      const bad = this.checkOutputs(pending.outcome).failure;
      if (bad !== null) {
        gateFailure = bad;
        invokeError = bad.detail;
      }
    }
    return {
      responseText: pending.responseText,
      outcome: pending.outcome,
      invokeError,
      gateFailure,
      eligible: true,
      pendingGate: true,
      needsVerify: false,
    };
  }

  private async freshTurn(): Promise<Iteration> {
    const invoked = await this.invokeProviderTurn();
    const evaluated = this.evaluateGates(invoked.iteration, invoked.fresh);
    this.emitTurnEvents(evaluated.iteration, evaluated.fresh);
    const persisted = this.persistTurn(evaluated.iteration, evaluated.fresh);
    const iteration: Iteration = { ...evaluated.iteration, needsVerify: persisted.needsVerify };
    this.writeTurnDiagnostics(iteration, {
      ...evaluated.fresh,
      modelResponded: persisted.modelResponded,
      recordedClassification: persisted.recordedClassification,
    });
    return iteration;
  }

  // Signal-file cleanup, the provider turn, and the exit-only/candidate/eligibility computation.
  private async invokeProviderTurn(): Promise<GateEvaluation> {
    const { record, model, profile, workspacePath } = this;
    // A request file left by an earlier turn must not be read as a new question. The
    // correction turn keeps the invalid file so the agent can repair it.
    if (!this.keepFile) rmSync(this.signalFile, { force: true });
    this.keepFile = false;
    const turnResult = await this.callProvider();
    this.classification = turnResult.classification;
    const { turn } = this;
    return assessProviderTurn({ record, model, profile, workspacePath, turn }, turnResult);
  }

  // The provider turn. A cancellation marks the execution cancelled and is rethrown.
  private async callProvider(): Promise<TurnResult> {
    try {
      return await this.runTurn({
        client: this.client,
        model: this.model,
        workspace: this.workspacePath,
        prompt: this.currentPrompt,
        agentId: this.currentAgentId,
        newSession: this.currentSession,
        options: this.resolvedOptions,
        eventReporter: this.eventReporter,
        store: this.store,
        context: this.context,
        turn: this.turn,
      });
    } catch (error) {
      return this.markCancelled(error);
    }
  }

  // Outcome resolution, the artifact and completion-output gates, and candidate rejection.
  private evaluateGates(it: Iteration, fresh: FreshTurn): GateEvaluation {
    const { sessionId, decisionValues, ask, protocol, questionFile, handoffFile, artifactName } = this;
    const loop = { sessionId, decisionValues, ask, protocol, questionFile, handoffFile, artifactName };
    return evaluateGates({ ...loop, checkOutputs: (reply) => this.checkOutputs(reply) }, it, fresh);
  }

  // Turn completed or failed, quota, and exit anomaly events. Emitted before persistTurn resets the classification.
  private emitTurnEvents(it: Iteration, fresh: FreshTurn): void {
    const { eventReporter, classification, turn } = this;
    emitTurnEvents({ eventReporter, classification, turn }, it, fresh);
  }

  // Status, conversation history, saved response, and the verify turn outcome.
  private persistTurn(it: Iteration, fresh: FreshTurn): PersistVerdict {
    const { record, store, context, verifyCommands } = this;
    const { responseText } = it;
    const needsVerify =
      verifyCommands.length > 0 && it.invokeError === null && it.outcome?.status === 'complete';
    const finishedStatus = it.invokeError === null && it.gateFailure === null ? 'completed' : 'failed';
    record.status = needsVerify ? 'running' : finishedStatus;
    // Only a real model reply belongs in the conversation. Error text, and the reply of a
    // turn the provider itself reported as failed, stay out, so a resume cannot replay
    // them as if the model had said them.
    const modelResponded =
      responseText !== '' && fresh.source === 'model' && (this.classification === null || fresh.exitOnly);
    const recordedClassification = this.classification;
    // An accepted turn is no longer a failure: nothing downstream may see its classification.
    if (fresh.exitOnly && fresh.anomalyReason === null) this.classification = null;
    if (modelResponded) record.history.push({ role: 'assistant', content: responseText });
    store.save(record, context);
    if (modelResponded) {
      store.saveResponse(context, responseText);
      if (verifyCommands.length > 0) store.saveTurnResponse(context, this.turn, responseText);
    }
    if (verifyCommands.length > 0 && it.outcome?.status === 'complete') {
      store.saveTurnOutcome(context, this.turn, it.outcome);
    }
    return { needsVerify, modelResponded, recordedClassification };
  }

  // The only writer of diagnostics.json: once this turn's gates have run, before any verify or follow-up turn.
  private writeTurnDiagnostics(it: Iteration, fresh: FreshTurn): void {
    const { record, store, context, artifactName, turn } = this;
    writeTurnDiagnostics({ record, store, context, artifactName, turn }, it, fresh);
  }

  // A gate failure on a fresh turn: queue a correction, or fail the stage. Then stop when no verify follows.
  private afterFreshTurn(it: Iteration): Step {
    const { record, store, context } = this;
    if (it.gateFailure !== null && it.eligible) {
      if (this.queueCorrection(it.gateFailure)) return 'continue';
      this.exhaust(it.gateFailure);
      if (it.gateFailure.kind === 'question_file' || it.gateFailure.kind === 'handoff') {
        record.status = 'failed';
        store.save(record, context);
        store.saveExecution(context, record, { status: 'failed', error: this.failureDetail, extra: this.finalFields(this.outcomeFields()) });
        return 'stop';
      }
    }
    if (!it.needsVerify || it.outcome === null) {
      store.saveExecution(
        context,
        record,
        {
          status: record.status,
          error: it.invokeError,
          outcome: it.outcome,
          extra: this.finalFields(this.outcomeFields()),
        },
      );
      return 'stop';
    }
    return 'proceed';
  }

  // Resumed from a saved response that failed a gate.
  private afterPendingGate(it: Iteration): Step {
    const { record, store, context } = this;
    if (it.gateFailure !== null && it.eligible && it.pendingGate) {
      if (this.queueCorrection(it.gateFailure)) return 'continue';
      this.exhaust(it.gateFailure);
      if (it.gateFailure.kind === 'question_file' || it.gateFailure.kind === 'handoff') {
        record.status = 'failed';
        store.save(record, context);
        store.saveExecution(context, record, { status: 'failed', error: this.failureDetail, extra: this.finalFields(this.outcomeFields()) });
        return 'stop';
      }
    }
    return 'proceed';
  }

  // True when the execution ends here: an error, no complete outcome, or nothing to verify.
  private finishWithoutVerify(it: Iteration): boolean {
    const { record, store, context } = this;
    if (it.invokeError !== null || it.outcome === null || it.outcome.status !== 'complete' || this.verifyCommands.length === 0) {
      record.status = it.invokeError === null && it.outcome !== null ? 'completed' : 'failed';
      store.save(record, context);
      store.saveExecution(
        context,
        record,
        {
          status: record.status,
          error: it.invokeError,
          outcome: it.outcome,
          extra: this.finalFields(this.outcomeFields()),
        },
      );
      return true;
    }
    return false;
  }

  // Null when a repair turn is queued and the loop goes on; the final iteration when the execution ends.
  private async verifyAndRepair(it: Iteration): Promise<Iteration | null> {
    const verdict = await this.runVerify(it);
    if (verdict.kind === 'end') return { ...it, outcome: verdict.outcome };
    this.queueRepair(verdict.report);
    return null;
  }

  // Runs the verify commands. A repair turn follows a failed run; every other result ends the execution.
  private async runVerify(it: Iteration): Promise<VerifyVerdict> {
    const { record, store, context, eventReporter, verifyCommands, stage, maxVerify } = this;
    store.clearProcessEndpoint(context);
    eventReporter.emit('verify.started', `${verifyCommands.length} command(s)`, {
      turn: this.turn,
      commands: verifyCommands,
    });
    let result: VerifyRunResult;
    try {
      result = await this.verifyRunner.run({
        commands: verifyCommands,
        workspace: this.workspacePath,
        executionDirectory: context.directory,
        turnDirectory: store.turnDirectory(context, this.turn),
        timeoutSec: stage?.verifyTimeoutSec ?? null,
        onStart: (info) => {
          store.saveProcessMetadata(context, info);
        },
        onEnd: () => {
          store.clearProcessEndpoint(context);
        },
        onHeartbeat: (command, elapsed) => {
          eventReporter.emit('verify.heartbeat', `${command} running for ${elapsed}s`, {
            turn: this.turn,
            command,
            elapsed_seconds: elapsed,
          });
        },
      });
    } catch (error) {
      return this.markCancelled(error);
    }
    this.verifyRuns += 1;
    const redRun = result.passed ? this.red : this.red + 1;
    const lastReport = store.saveTurnVerify(
      context,
      this.turn,
      formatVerifyReport(result, {
        run: this.verifyRuns,
        red: redRun,
        maxVerify,
        timeoutSec: stage?.verifyTimeoutSec ?? null,
      }),
    );
    this.lastReport = lastReport;
    this.lastResult = result.passed ? 'pass' : 'fail';
    if (result.infraError !== null) {
      record.status = 'failed';
      store.save(record, context);
      store.saveExecution(context, record, { status: 'failed', error: result.infraError, extra: this.finalFields(this.extraFields()) });
      return { kind: 'end', outcome: it.outcome };
    }
    if (result.passed) {
      eventReporter.emit('verify.passed', 'all commands passed', { turn: this.turn, report: lastReport });
      record.status = 'completed';
      store.save(record, context);
      store.saveExecution(context, record, { status: 'completed', outcome: it.outcome, extra: this.finalFields(this.extraFields()) });
      store.publishVerifyReport(context, this.turn);
      return { kind: 'end', outcome: it.outcome };
    }
    this.red += 1;
    const failed = result.commands.find((item) => item.status === 'fail' || item.status === 'timed_out');
    eventReporter.emit('verify.failed', `${failed?.command ?? 'verify'} failed`, {
      turn: this.turn,
      red: this.red,
      max_verify: maxVerify,
      command: failed?.command ?? null,
      status: failed?.status ?? null,
      exit_code: failed?.exitCode ?? null,
      report: lastReport,
    });
    if (this.red >= maxVerify) {
      this.failureReason = VERIFY_EXHAUSTED;
      record.status = 'failed';
      store.save(record, context);
      store.saveExecution(
        context,
        record,
        { status: 'failed', error: `Verify failed ${this.red} times.`, extra: this.finalFields(this.extraFields(this.failureReason)) },
      );
      return { kind: 'end', outcome: null };
    }
    store.saveExecutionProgress(context, record, this.extraFields() ?? {});
    return { kind: 'repair', report: lastReport };
  }

  // Queues the repair turn that follows a failed verify run.
  private queueRepair(lastReport: string): void {
    const { record, store, context, stage, artifactName } = this;
    const repair = buildRepairPrompt({ context, artifactName, red: this.red, maxVerify: this.maxVerify }, lastReport);
    record.history.push({ role: 'user', content: repair });
    store.save(record, context);
    // pending_turn keeps resume from counting a turn short after an empty reply.
    store.saveExecutionProgress(context, record, { turn_kind: 'repair', pending_turn: this.turn + 1 });
    this.turn += 1;
    this.currentAgentId = record.agentId;
    this.currentSession = null;
    this.currentPrompt = this.currentAgentId
      ? repair
      : flattenHistory(record.history as { role: string; content: string }[]);
    this.currentPrompt = renderProviderPrompt(this.currentPrompt, { ...sessionPaths(context, this.sessionId),
      contract: this.currentAgentId ? 'reminder' : 'full', turn: 'repair', decisionValues: this.decisionValues, decisionInstructions: stage?.decisionInstructions, ask: this.ask, protocol: this.protocol, questionFile: this.questionFile, handoffFile: this.handoffFile,
      artifactDirectory: context.artifactDirectory, artifactName,
      artifactFiles: promptArtifactFiles(stage === null ? [] : allStageArtifacts(stage)),
    });
  }

  private result(it: Iteration): RunResult {
    const { record, store, context, eventReporter, classification, failureReason, failureDetail } = this;
    return buildRunResult(
      { record, store, context, eventReporter, classification, failureReason, failureDetail },
      it,
    );
  }
}
