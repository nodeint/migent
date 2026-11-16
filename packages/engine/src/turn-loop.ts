/** The turn loop of one execution: provider turns, gates, corrections, verify, and repair turns. */
import {
  type CliClient, type CorrectionFiles, type CorrectionLedger, type FailureClassification, type NewSession,
  StageOutcome, type VerifyRunner,
} from '@nodeint/migent-kernel';
import { HANDOFF_FILE_PROTOCOL } from '@nodeint/migent-prompts';
import type { AgentSessionRecord, ExecutionContext, SessionStore } from '@nodeint/migent-session';
import type { StageSpec } from '@nodeint/migent-workflow';

import type { ProviderEventReporter } from './provider-events.js';
import { gate, invoke, type PromptInputs, queueRepair, verify } from './turn-flow-steps.js';
import { finishWithoutVerify, persistTurn, resolvePendingVerify, type VerifyState } from './turn-persist-steps.js';
import {
  buildRunResult,
  checkOutputs,
  emitTurnEvents,
  evaluateGates,
  type GateEvaluation,
  type OutputCheck,
  type PersistVerdict,
  type Step,
  writeTurnDiagnostics,
} from './turn-steps.js';
import {
  handoffPath, type Iteration, type PendingVerify, questionRequestPath, type RunResult,
  type RunTurnArgs, type TurnDrive, type TurnResult,
} from './turn-types.js';

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
    ({
      client: this.client, model: this.model, workspacePath: this.workspacePath,
      resolvedOptions: this.resolvedOptions, profile: this.profile, store: this.store, context: this.context,
      record: this.record, eventReporter: this.eventReporter, sessionId: this.sessionId, stage: this.stage,
      decisionValues: this.decisionValues, artifactName: this.artifactName, verifyCommands: this.verifyCommands,
      maxVerify: this.maxVerify, protocol: this.protocol,
    } = state);
    this.ask = state.stage?.ask ?? (state.stage === null ? 'human' : null);
    ({
      turn: this.turn, red: this.red, verifyRuns: this.verifyRuns, lastReport: this.lastReport,
      lastResult: this.lastResult, currentPrompt: this.currentPrompt, currentAgentId: this.currentAgentId,
      currentSession: this.currentSession, pendingVerify: this.pendingVerify, corrections: this.corrections,
    } = state);
    this.questionFile = questionRequestPath(state.context);
    this.handoffFile = handoffPath(state.context);
    this.files = { protocol: state.protocol, questionFile: this.questionFile, handoffFile: this.handoffFile };
    this.signalFile = state.protocol >= HANDOFF_FILE_PROTOCOL ? this.handoffFile : this.questionFile;
    this.keepFile = state.keepFile ?? false;
  }

  public async drive(): Promise<RunResult> {
    while (true) {
      const final = await this.iterate();
      if (final !== null) return this.result(final);
    }
  }

  // One loop iteration: the final iteration when the execution ends, null when another turn follows.
  // The step order and the persistence points are visible here; each step is a function with typed inputs.
  private async iterate(): Promise<Iteration | null> {
    const fresh = this.pendingVerify === null;
    let it: Iteration;
    if (fresh) {
      const invoked = await this.invokeStep();
      const evaluated = this.evaluateGatesStep(invoked);
      // Emitted before persistTurn resets the classification.
      this.emitTurnEventsStep(evaluated);
      const persisted = this.persistTurnStep(evaluated);
      it = { ...evaluated.iteration, needsVerify: persisted.needsVerify };
      // The only writer of diagnostics.json: once this turn's gates have run, before any verify or follow-up turn.
      this.writeTurnDiagnosticsStep(it, evaluated, persisted);
    } else {
      it = this.takePendingVerify();
    }
    const step = this.applyGate(it, fresh);
    if (step === 'continue') return null;
    if (step === 'stop' || this.finishWithoutVerify(it)) return it;
    return this.verifyAndRepair(it);
  }

  private verifyState(): VerifyState {
    const { verifyCommands, turn, lastResult, lastReport, verifyRuns, red, maxVerify } = this;
    return { verifyCommands, turn, lastResult, lastReport, verifyRuns, red, maxVerify };
  }

  private failureState(): { failureReason: string; classification: FailureClassification | null } {
    return { failureReason: this.failureReason, classification: this.classification };
  }

  private promptInputs(): PromptInputs {
    const { sessionId, stage, decisionValues, artifactName, ask, protocol, files } = this;
    return { sessionId, stage, decisionValues, artifactName, ask, protocol, files };
  }

  private takePendingVerify(): Iteration {
    const pending = this.pendingVerify;
    if (pending === null) throw new Error('No pending verify result to take.');
    this.pendingVerify = null;
    const { stage, artifactName, context, store } = this;
    return resolvePendingVerify({ stage, artifactName, context, store }, pending);
  }

  // The artifact and completion-output gates. Fresh turns and resumed saved replies both run them.
  private checkOutputs(reply: StageOutcome): OutputCheck {
    const { stage, artifactName, context, store } = this;
    return checkOutputs({ stage, artifactName, context, store }, reply);
  }

  // Signal-file cleanup and the provider turn. The classification stays loop state.
  private async invokeStep(): Promise<GateEvaluation> {
    const { record, store, context, eventReporter, profile, workspacePath, signalFile, keepFile } = this;
    const turnArgs: RunTurnArgs = {
      client: this.client,
      model: this.model,
      workspace: workspacePath,
      prompt: this.currentPrompt,
      agentId: this.currentAgentId,
      newSession: this.currentSession,
      options: this.resolvedOptions,
      eventReporter,
      store,
      context,
      turn: this.turn,
    };
    this.keepFile = false;
    const invoked = await invoke({ turnArgs, signalFile, keepFile, record, profile, workspacePath }, this.runTurn);
    this.classification = invoked.classification;
    return invoked.evaluation;
  }

  private evaluateGatesStep(invoked: GateEvaluation): GateEvaluation {
    const { sessionId, decisionValues, ask, protocol, questionFile, handoffFile, artifactName } = this;
    const loop = { sessionId, decisionValues, ask, protocol, questionFile, handoffFile, artifactName };
    const gates = { ...loop, checkOutputs: (reply: StageOutcome) => this.checkOutputs(reply) };
    return evaluateGates(gates, invoked.iteration, invoked.fresh);
  }

  private emitTurnEventsStep(evaluated: GateEvaluation): void {
    const { eventReporter, classification, turn } = this;
    emitTurnEvents({ eventReporter, classification, turn }, evaluated.iteration, evaluated.fresh);
  }

  private persistTurnStep(evaluated: GateEvaluation): PersistVerdict {
    const { record, store, context, verifyCommands, classification, turn } = this;
    const persisted = persistTurn(
      { record, store, context, verifyCommands, classification, turn }, evaluated.iteration, evaluated.fresh,
    );
    this.classification = persisted.classification;
    return persisted;
  }

  private writeTurnDiagnosticsStep(it: Iteration, evaluated: GateEvaluation, persisted: PersistVerdict): void {
    const { record, store, context, artifactName, turn } = this;
    writeTurnDiagnostics({ record, store, context, artifactName, turn }, it, {
      ...evaluated.fresh,
      modelResponded: persisted.modelResponded,
      recordedClassification: persisted.recordedClassification,
    });
  }

  // A gate failure queues a correction or fails the stage; a fresh turn also stops when no verify follows.
  private applyGate(it: Iteration, fresh: boolean): Step {
    const { record, store, context, eventReporter, corrections, failureDetail, turn } = this;
    const result = gate(
      {
        record, store, context, eventReporter, corrections, failureDetail, fresh, turn,
        ...this.promptInputs(), verify: this.verifyState(), failure: this.failureState(),
      },
      it,
    );
    this.failureReason = result.failureReason;
    this.failureDetail = result.failureDetail;
    const { queued } = result;
    if (queued !== null) {
      this.corrections = queued.corrections;
      this.turn = queued.turn;
      this.currentPrompt = queued.currentPrompt;
      this.currentAgentId = queued.currentAgentId;
      this.currentSession = null;
      this.keepFile = queued.keepFile;
    }
    return result.step;
  }

  // True when the execution ends here: an error, no complete outcome, or nothing to verify.
  private finishWithoutVerify(it: Iteration): boolean {
    const { record, store, context } = this;
    const result = finishWithoutVerify(
      { record, store, context }, { verify: this.verifyState(), failure: this.failureState() }, it,
    );
    this.failureReason = result.failureReason;
    return result.finished;
  }

  // Null when a repair turn is queued and the loop goes on; the final iteration when the execution ends.
  private async verifyAndRepair(it: Iteration): Promise<Iteration | null> {
    const { record, store, context, eventReporter, stage, workspacePath, verifyRunner } = this;
    const ran = await verify(
      { record, store, context, eventReporter, stage, workspacePath, verifyRunner, verify: this.verifyState() },
      it,
    );
    this.verifyRuns = ran.verifyRuns;
    this.lastReport = ran.lastReport;
    this.lastResult = ran.lastResult;
    this.red = ran.outcome.red;
    if (ran.outcome.failureReason !== null) this.failureReason = ran.outcome.failureReason;
    const { verdict } = ran.outcome;
    if (verdict.kind === 'end') return { ...it, outcome: verdict.outcome };
    const queued = queueRepair(
      { record, store, context, ...this.promptInputs(), red: this.red, maxVerify: this.maxVerify, turn: this.turn },
      verdict.report,
    );
    this.turn = queued.turn;
    this.currentAgentId = queued.currentAgentId;
    this.currentSession = null;
    this.currentPrompt = queued.currentPrompt;
    return null;
  }

  private result(it: Iteration): RunResult {
    const { record, store, context, eventReporter, classification, failureReason, failureDetail } = this;
    return buildRunResult(
      { record, store, context, eventReporter, classification, failureReason, failureDetail },
      it,
    );
  }
}
