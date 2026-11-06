import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  defaultProviders,
  type Provider,
  type FailureClassification,
  type ResponseSource,
  type NewSession,
  type UsageCapture,
} from "./provider-contract.js";
import { CancellationRequested, CommandExecutor, DEFAULT_TIMEOUT_SEC, type ExecutionFailure, type StopReason } from "./command-executor.js";
import { DEFAULT_INTERRUPT_POLICY, type InterruptPolicy, type InterruptReport, interruptSession, isSettled } from "./provider-interrupt.js";
import { KERNEL_VERSION } from "./package-version.js";
import { spawnProviderSync } from "./provider-spawn.js";
import { buildVerifyRepairPrompt } from "./prompt.js";
import { VERIFY_EXHAUSTED } from "./selection.js";
import { VerifyRunner, formatVerifyReport, type VerifyRunResult } from "./verify-runner.js";
import { ConfigurationError } from "./errors.js";
import { nonemptyArtifact } from "./outputs.js";
import { isRecord } from "./record.js";
import {
  renderProviderPrompt,
  flattenHistory,
  debugEnabled,
  log,
} from "./runtime.js";
import { renderProtocolUpdate, renderQuestionCorrection, type TurnKind } from "@nodeint/migent-prompts";
import { ProviderEventReporter } from "./provider-events.js";
import { loadFrozenWorkflow } from "./session-freeze.js";
import { AgentSessionRecord, SessionStore, stringOptions, type ExecutionContext } from "./session-store.js";
import { StageOutcome } from "./stage-outcome.js";
import { resolveStageOutcome, type OutcomeContext } from "./outcome-resolver.js";
import { QuestionFileError, type Question } from "./questions.js";
import { isWorkflowV2, loadNamedWorkflow, loadStage, type StageSpec } from "./workflow.js";

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
  /** Readable diagnostic for `question_file_invalid`: the file, the problem and how to recover. Absent otherwise. */
  failure_detail?: string;
  /** `quota`, `provider`, or empty when the turn was not a provider failure. */
  failure_kind: string;
  /** UTC ISO instant for a quota failure. Empty otherwise. */
  reset_at: string;
  provider: string;
  /** Final status of this execution, e.g. `failed` when the provider exited non-zero without a classified failure. */
  execution_status?: string;
}

export interface RunRequest {
  provider: string;
  model: string;
  /** CLI client id to drive the model with. Absent means the provider's own. */
  client?: string | null;
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

/** Failure reason when the question request file stays invalid after the correction turn. */
export const QUESTION_FILE_INVALID = "question_file_invalid";
/** Version of the response contract baked into a saved first prompt. 2 = questions via request file. */
const RESPONSE_PROTOCOL = 2;

const TURN_KINDS: readonly TurnKind[] = ["start", "continue", "reply", "answers", "repair", "correction"];

/** The kind of the execution's latest user turn, as saved in execution.json. */
function storedTurn(metadata: Record<string, unknown>): TurnKind | null {
  const value = metadata.turn_kind;
  return TURN_KINDS.find((kind) => kind === value) ?? null;
}

/** Task file and session directory of a workflow execution, for the prompt's Execution block. */
function sessionPaths(context: ExecutionContext, sessionId: string | null): { taskFile?: string; sessionDirectory?: string } {
  if (sessionId === null) return {};
  const sessionDirectory = path.dirname(path.dirname(context.directory));
  const taskFile = path.join(sessionDirectory, "task.md");
  try {
    return statSync(taskFile).isFile() ? { taskFile, sessionDirectory } : {};
  } catch {
    return {};
  }
}
const QUESTION_FILE_NAME = "question-request.json";

/** Absolute, native path the agent writes questions to. It sits outside `artifacts/`. */
export function questionRequestPath(context: ExecutionContext): string {
  return path.resolve(context.directory, QUESTION_FILE_NAME);
}

interface QuestionCorrection {
  turn: number;
  error_kind: string;
  error_detail: string;
}

function storedCorrection(metadata: Record<string, unknown>): QuestionCorrection | null {
  const value = metadata.question_correction;
  if (!isRecord(value) || typeof value.turn !== "number") return null;
  return {
    turn: value.turn,
    error_kind: typeof value.error_kind === "string" ? value.error_kind : "",
    error_detail: typeof value.error_detail === "string" ? value.error_detail : "",
  };
}

export class AgentToolRunner {
  readonly providers: Record<string, Provider>;
  readonly executor: CommandExecutor;
  readonly verifyRunner: VerifyRunner;
  itemProgress = false;
  interruptPolicy: InterruptPolicy = DEFAULT_INTERRUPT_POLICY;
  private readonly cliVersions = new Map<string, string | null>();

  constructor(
    providers?: Record<string, Provider>,
    timeoutSec: number | null = DEFAULT_TIMEOUT_SEC,
    verifyRunner: VerifyRunner = new VerifyRunner(),
  ) {
    this.verifyRunner = verifyRunner;
    this.providers = providers ?? defaultProviders();
    this.executor = new CommandExecutor(timeoutSec);
  }

  async run(request: RunRequest): Promise<RunResult> {
    const workspacePath = resolveWorkspace(request.workspace);
    const stageAttempt = request.stageAttempt ?? null;
    const executionOrder = request.executionOrder ?? null;
    if (stageAttempt !== null && stageAttempt < 1) throw new Error("Stage attempt must be at least 1.");
    if (executionOrder !== null && executionOrder < 1) {
      throw new Error("Execution order must be at least 1.");
    }
    const providerKey = request.provider.toLowerCase();
    const base = this.providers[providerKey];
    if (base === undefined) {
      const supported = Object.keys(this.providers).sort().join(", ");
      throw new Error(`Unsupported CLI provider: ${request.provider}. Supported: ${supported}`);
    }
    const provider = withClient(base, request.client ?? null);
    const resolvedOptions = { ...(request.options ?? {}) };
    provider.validateOptions(resolvedOptions);
    const profile = profileOptions(provider, resolvedOptions);
    const store = new SessionStore(workspacePath, undefined, this.providers);
    const sessionId = request.sessionId ?? null;
    const stageId = request.stageId ?? "agent";
    const [record, isNew, context] = store.loadOrCreate(
      providerKey,
      request.model,
      profile,
      workspacePath,
      sessionId,
      stageId,
      stageAttempt,
      executionOrder,
      request.prompt,
      request.resumeExecutionId ?? null,
    );
    request.onExecution?.(context.executionId);
    if (!isNew) {
      validateSessionProfile(
        record.provider,
        record.model,
        record.options,
        providerKey,
        request.model,
        profile,
      );
    }
    const newSession = isNew ? (provider.createNewSession?.() ?? { agentId: null }) : null;
    if (newSession?.agentId) record.agentId = newSession.agentId;
    record.history.push({ role: "user", content: request.prompt });
    record.status = "running";
    store.save(record, context);
    store.saveExecution(context, record, "running");
    const eventReporter = new ProviderEventReporter(
      store,
      context,
      providerKey,
      request.model,
      this.itemProgress,
    );
    const agentId = isNew ? null : record.agentId;
    let turnPrompt = request.prompt;
    if (!isNew && !agentId) {
      turnPrompt = flattenHistory(record.history as Array<{ role: string; content: string }>);
    }
    const stage = sessionId === null ? null : loadRunStage(store, context.sessionId, stageId);
    const decisionValues = stage?.decisionValues ?? [];
    const ask = stage?.ask ?? (stage === null ? "human" : null);
    const artifactName = stage?.artifact ?? null;
    const verifyCommands = stage?.verify ?? [];
    const previous = request.resumeExecutionId
      ? store.executionSnapshots(context.sessionId).find((row) => row.executionId === request.resumeExecutionId && row.stageId === stageId && row.outcomeStatus === "question")
      : undefined;
    const previousMetadata = previous
      ? JSON.parse(readFileSync(path.join(path.dirname(previous.artifactDirectory), "execution.json"), "utf8")) as Record<string, unknown>
      : null;
    const progress = previousMetadata ? verifyProgress(previousMetadata) : null;
    // Answering a question on the same agent: the conversation already holds the contract and stage instructions.
    const sameConversation = previous !== undefined && agentId !== null && agentId !== ""
      && previousMetadata?.response_protocol === RESPONSE_PROTOCOL;
    if (previous && artifactName) store.carryVerifyArtifact(previous.artifactDirectory, context, artifactName);
    if (request.resumeExecutionId && verifyCommands.length > 0 && artifactName) {
      this.carryExhaustedArtifact(store, context, request.resumeExecutionId, artifactName);
    }
    turnPrompt = renderProviderPrompt(turnPrompt, { ...sessionPaths(context, sessionId),
      contract: sessionId === null ? false : sameConversation ? "reminder" : "full", turn: request.turn ?? null, decisionValues, decisionInstructions: stage?.decisionInstructions, ask,
      questionFile: questionRequestPath(context),
      artifactDirectory: context.artifactDirectory, artifactName,
      previousArtifactDirectory: previous?.artifactDirectory ?? null,
      previousVerifyReport: previous && progress?.lastReport
        ? path.resolve(path.dirname(previous.artifactDirectory), progress.lastReport) : null,
    });
    store.savePrompt(context, turnPrompt);
    store.saveExecutionProgress(context, record, { response_protocol: RESPONSE_PROTOCOL, turn_kind: request.turn ?? null });
    const started: Record<string, unknown> = {
      cli_version: this.cachedCliVersion(provider, providerKey, workspacePath),
      ...readGitFacts(workspacePath),
    };
    if (Object.keys(profile).length > 0) started.options = profile;
    eventReporter.emit("provider.stage_started", `${providerKey}/${request.model}`, started);

    return this.driveTurns({
      provider,
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
      questionCorrection: null,
    });
  }

  /** Finish a cancelled execution that has been reopened in place. Does not create an attempt. */
  async continueCancelled(workspace: string, sessionId: string, executionId: string): Promise<RunResult> {
    const workspacePath = resolveWorkspace(workspace);
    const store = new SessionStore(workspacePath, undefined, this.providers);
    const context = store.executionContext(sessionId, executionId);
    if (context === null) throw new Error(`Execution ${executionId} was not found in session ${sessionId}.`);
    const metadata = JSON.parse(readFileSync(path.join(context.directory, "execution.json"), "utf8")) as unknown;
    if (!isRecord(metadata)) throw new Error(`Execution ${executionId} is unreadable.`);
    if (metadata.status !== "running") {
      throw new Error(`Execution ${executionId} is ${String(metadata.status)}, not running.`);
    }
    const providerKey = typeof metadata.provider === "string" ? metadata.provider.toLowerCase() : "";
    const model = typeof metadata.model === "string" ? metadata.model : "";
    const provider = this.providers[providerKey];
    if (provider === undefined) {
      const supported = Object.keys(this.providers).sort().join(", ");
      throw new Error(`Unsupported CLI provider: ${String(metadata.provider)}. Supported: ${supported}`);
    }
    const resolvedOptions = stringOptions(metadata.options);
    provider.validateOptions(resolvedOptions);
    const profile = profileOptions(provider, resolvedOptions);
    const record = AgentSessionRecord.fromJson(
      JSON.parse(readFileSync(context.conversationReadPath, "utf8")) as unknown,
      providerKey,
      model,
      workspacePath,
    );
    record.status = "running";
    store.save(record, context);
    const stageId = typeof metadata.stage_id === "string" ? metadata.stage_id : "agent";
    const stage = loadRunStage(store, sessionId, stageId);
    const decisionValues = stage?.decisionValues ?? [];
    const ask = stage?.ask ?? (stage === null ? "human" : null);
    const artifactName = stage?.artifact ?? null;
    const verifyCommands = stage?.verify ?? [];
    const eventReporter = new ProviderEventReporter(store, context, providerKey, model, this.itemProgress);
    const progress = verifyProgress(metadata);
    const correction = storedCorrection(metadata);
    const questionFile = questionRequestPath(context);
    const assistants = record.history.filter((item) => item.role === "assistant").length;
    const last = record.history.at(-1);
    const lastRole = last && typeof last.role === "string" ? last.role : "";
    if (last === undefined || lastRole !== "assistant") {
      if (lastRole !== "user" || typeof last?.content !== "string" || last.content === "") {
        throw new ConfigurationError(`Execution ${executionId} has no prompt to resume.`);
      }
      const agentId = record.agentId;
      // The first turn is sent as prompt.md, contract included. A later repair turn
      // stores only the repair text, and the loop adds the contract again before sending.
      let currentPrompt: string;
      if (assistants === 0) {
        try {
          currentPrompt = readFileSync(path.join(context.directory, "prompt.md"), "utf8");
        } catch {
          throw new ConfigurationError(`Execution ${executionId} has no prompt to resume.`);
        }
        // A first prompt saved under an older protocol carries the old question instructions.
        if (sessionId !== null && ask !== null && metadata.response_protocol !== RESPONSE_PROTOCOL) {
          currentPrompt += renderProtocolUpdate({ ...sessionPaths(context, sessionId), turn: storedTurn(metadata),
            decisionValues, decisionInstructions: stage?.decisionInstructions, ask, questionFile,
          });
        }
      } else {
        currentPrompt = agentId
          ? last.content
          : flattenHistory(record.history as Array<{ role: string; content: string }>);
        const contract = agentId && metadata.response_protocol === RESPONSE_PROTOCOL ? "reminder" : "full";
        currentPrompt = renderProviderPrompt(currentPrompt, { ...sessionPaths(context, sessionId), contract, turn: storedTurn(metadata), decisionValues, decisionInstructions: stage?.decisionInstructions, ask, questionFile, artifactDirectory: context.artifactDirectory, artifactName });
      }
      return this.driveTurns({
        provider,
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
        turn: Math.max(1, assistants + 1),
        red: progress.red,
        verifyRuns: progress.runs,
        lastReport: progress.lastReport,
        lastResult: progress.lastResult,
        currentPrompt,
        currentAgentId: agentId,
        currentSession: null,
        pendingVerify: null,
        questionCorrection: correction,
      });
    }
    const turn = Math.max(1, assistants);
    const responseText = savedResponse(context, last);
    let outcome: StageOutcome | null = null;
    let invokeError: string | null = null;
    let questionError: QuestionFileError | null = null;
    try {
      outcome = savedOutcome(store, context, turn, responseText, { required: sessionId !== null, decisionValues, ask, questionFile });
    } catch (error) {
      if (error instanceof QuestionFileError) questionError = error;
      else if (error instanceof Error) invokeError = error.message;
      else throw error;
    }
    return this.driveTurns({
      provider,
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
      currentPrompt: "",
      currentAgentId: record.agentId,
      currentSession: null,
      pendingVerify: { responseText, outcome, invokeError, questionError },
      questionCorrection: correction,
    });
  }

  private async driveTurns(state: TurnDrive): Promise<RunResult> {
    const {
      provider,
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
    const maxVerify = state.maxVerify;
    const ask = stage?.ask ?? (stage === null ? "human" : null);
    let turn = state.turn;
    let red = state.red;
    let verifyRuns = state.verifyRuns;
    let lastReport = state.lastReport;
    let lastResult = state.lastResult;
    let currentPrompt = state.currentPrompt;
    let currentAgentId = state.currentAgentId;
    let currentSession = state.currentSession;
    let pendingVerify = state.pendingVerify;
    let questionCorrection = state.questionCorrection;
    const questionFile = questionRequestPath(context);
    let keepQuestionFile = false;
    let responseText = pendingVerify?.responseText ?? "";
    let outcome: StageOutcome | null = pendingVerify?.outcome ?? null;
    let failureReason = "";
    let failureDetail = "";
    let classification: FailureClassification | null = null;
    const markCancelled = (error: unknown): never => {
      if (error instanceof CancellationRequested) {
        eventReporter.emit("provider.cancelled", "cancellation requested");
        record.status = "cancelled";
        store.save(record, context);
        store.saveExecution(context, record, "cancelled");
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
    const outcomeFields = (): Record<string, unknown> | null => {
      if (failureReason === QUESTION_FILE_INVALID) {
        return { ...(extraFields() ?? {}), failure_reason: QUESTION_FILE_INVALID };
      }
      if (classification?.kind !== "quota") return extraFields();
      failureReason = "quota";
      return { ...(extraFields() ?? {}), failure_reason: "quota", retry_at: classification.resetAt };
    };
    while (true) {
      let invokeError: string | null = null;
      let questionError: QuestionFileError | null = null;
      if (pendingVerify) {
        responseText = pendingVerify.responseText;
        outcome = pendingVerify.outcome;
        invokeError = pendingVerify.invokeError;
        questionError = pendingVerify.questionError;
        pendingVerify = null;
      } else {
        // A request file left by an earlier turn must not be read as a new question. The
        // correction turn keeps the invalid file so the agent can repair it.
        if (!keepQuestionFile) rmSync(questionFile, { force: true });
        keepQuestionFile = false;
        let parsedProviderId: string | null;
        let argv: string[] = [];
        let usage: UsageCapture | null = null;
        let parsedSource: ResponseSource | undefined;
        let exitCode: number | null = null;
        try {
          [responseText, parsedProviderId, invokeError, argv, usage, classification, parsedSource, exitCode] = await this.runTurn(
            provider,
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

        record.agentId = parsedProviderId || record.agentId;
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
        const source: ResponseSource = parsedSource ?? (classification === null ? "model" : "none");
        const exitOnly = classification?.origin === "exit-only";
        // A non-zero exit alone does not decide the turn. A reply the model wrote still goes
        // through every gate an exit-0 turn passes; the provider's own error text never does.
        const candidate = exitOnly && source === "model" && responseText.trim() !== "";
        const exitMessage = invokeError;
        let anomalyReason: string | null = null;
        if (candidate) {
          invokeError = null;
        } else if (exitOnly) {
          anomalyReason = responseText.trim() === "" ? "no reply" : "reply is not model output";
          invokeError = responseText.trim() === "" ? exitMessage : responseText;
        }
        // The turn event follows the provider verdict only; later gates never rename it.
        let turnError = invokeError;
        if (invokeError === null) {
          try {
            outcome = resolveStageOutcome(responseText, {
              required: sessionId !== null, decisionValues, ask, questionFile,
            });
          } catch (error) {
            if (error instanceof QuestionFileError) questionError = error;
            else if (error instanceof Error) invokeError = error.message;
            else throw error;
          }
        }
        if (invokeError === null && outcome?.status === "complete" && artifactName) {
          const artifactPath = path.join(context.artifactDirectory, artifactName);
          if (!nonemptyArtifact(artifactPath)) {
            invokeError = `Stage artifact missing or empty: ${artifactName}.`;
          }
        }
        if (invokeError === null && outcome !== null && !isWorkflowV2(frozenDocument(context))) {
          const missing = store.missingCompletionOutputs(context, outcome);
          if (missing.length > 0) {
            invokeError = `Completion outputs missing or empty: ${missing.join(", ")}.`;
          }
        }
        if (candidate && invokeError !== null) {
          // Rejected: the error is the model text itself, the failed gate is the recorded reason.
          anomalyReason = invokeError;
          invokeError = responseText;
          turnError = invokeError;
        }
        eventReporter.emit(
          turnError === null ? "provider.turn_completed" : "provider.turn_failed",
          turnError === null ? "completed" : turnError,
          turnDetails,
        );
        if (exitOnly) {
          eventReporter.emit(
            "provider.exit_anomaly",
            invokeError === null || anomalyReason === null
              ? `exit ${exitCode} with a usable reply; accepted`
              : `exit ${exitCode}; rejected: ${anomalyReason}`,
            {
              turn,
              provider: eventReporter.provider,
              exit_code: exitCode,
              signal: null,
              origin: "exit-only",
              accepted: anomalyReason === null,
              reason: anomalyReason,
            },
          );
        }
        const needsVerify =
          verifyCommands.length > 0 && invokeError === null && outcome?.status === "complete";
        record.status = needsVerify ? "running" : invokeError === null && questionError === null ? "completed" : "failed";
        // Only a real model reply belongs in the conversation. Error text, and the reply of a
        // turn the provider itself reported as failed, stay out, so a resume cannot replay
        // them as if the model had said them.
        const modelResponded =
          responseText !== "" && (classification === null || (exitOnly && source === "model"));
        // An accepted turn is no longer a failure: nothing downstream may see its classification.
        if (exitOnly && anomalyReason === null) classification = null;
        if (modelResponded) record.history.push({ role: "assistant", content: responseText });
        store.save(record, context);
        if (modelResponded) {
          store.saveResponse(context, responseText);
          if (verifyCommands.length > 0) store.saveTurnResponse(context, turn, responseText);
        }
        if (verifyCommands.length > 0 && outcome?.status === "complete") {
          store.saveTurnOutcome(context, turn, outcome);
        }
        if (questionError !== null) {
          const next = this.questionRetry(questionError, questionCorrection, turn, state, eventReporter);
          if (next === null) {
            invokeError = questionFailureMessage(questionError);
            failureDetail = invokeError;
            failureReason = QUESTION_FILE_INVALID;
            record.status = "failed";
            store.save(record, context);
            store.saveExecution(context, record, "failed", invokeError, null, false, outcomeFields());
            break;
          }
          ({ correction: questionCorrection, prompt: currentPrompt } = next);
          turn += 1;
          currentAgentId = record.agentId;
          currentSession = null;
          keepQuestionFile = true;
          continue;
        }
        if (!needsVerify || outcome === null) {
          store.saveExecution(context, record, record.status, invokeError, outcome, false, outcomeFields());
          break;
        }
      }
      if (questionError !== null) {
        // Resumed from a saved response whose question file was unusable.
        const next = this.questionRetry(questionError, questionCorrection, turn, state, eventReporter);
        if (next === null) {
          failureReason = QUESTION_FILE_INVALID;
          failureDetail = questionFailureMessage(questionError);
          record.status = "failed";
          store.save(record, context);
          store.saveExecution(context, record, "failed", failureDetail, null, false, outcomeFields());
          break;
        }
        ({ correction: questionCorrection, prompt: currentPrompt } = next);
        turn += 1;
        currentAgentId = record.agentId;
        currentSession = null;
        keepQuestionFile = true;
        continue;
      }
      if (invokeError !== null || outcome === null || outcome.status !== "complete" || verifyCommands.length === 0) {
        record.status = invokeError === null && outcome !== null ? "completed" : "failed";
        store.save(record, context);
        store.saveExecution(context, record, record.status, invokeError, outcome, false, outcomeFields());
        break;
      }

      store.clearProcessEndpoint(context);
      eventReporter.emit("verify.started", `${verifyCommands.length} command(s)`, {
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
            eventReporter.emit("verify.heartbeat", `${command} running for ${elapsed}s`, {
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
      lastResult = result.passed ? "pass" : "fail";
      if (result.infraError !== null) {
        record.status = "failed";
        store.save(record, context);
        store.saveExecution(context, record, "failed", result.infraError, null, false, extraFields());
        break;
      }
      if (result.passed) {
        eventReporter.emit("verify.passed", "all commands passed", { turn, report: lastReport });
        record.status = "completed";
        store.save(record, context);
        store.saveExecution(context, record, "completed", null, outcome, false, extraFields());
        store.publishVerifyReport(context, turn);
        break;
      }
      red += 1;
      const failed = result.commands.find((item) => item.status === "fail" || item.status === "timed_out");
      eventReporter.emit("verify.failed", `${failed?.command ?? "verify"} failed`, {
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
        record.status = "failed";
        store.save(record, context);
        store.saveExecution(
          context,
          record,
          "failed",
          `Verify failed ${red} times.`,
          null,
          false,
          extraFields(failureReason),
        );
        outcome = null;
        break;
      }
      store.saveExecutionProgress(context, record, extraFields() ?? {});
      const report = readFileSync(path.join(context.directory, lastReport), "utf8");
      const sessionDirectory = path.dirname(path.dirname(context.directory));
      const taskFile = path.join(sessionDirectory, "task.md");
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
      record.history.push({ role: "user", content: repair });
      store.save(record, context);
      store.saveExecutionProgress(context, record, { turn_kind: "repair" });
      turn += 1;
      currentAgentId = record.agentId;
      currentSession = null;
      currentPrompt = currentAgentId
        ? repair
        : flattenHistory(record.history as Array<{ role: string; content: string }>);
      currentPrompt = renderProviderPrompt(currentPrompt, { ...sessionPaths(context, sessionId),
        contract: currentAgentId ? "reminder" : "full", turn: "repair", decisionValues, decisionInstructions: stage?.decisionInstructions, ask, questionFile,
        artifactDirectory: context.artifactDirectory, artifactName,
      });
    }
    const sessionStatus = store.readSessionStatus(context.sessionId);
    return {
      agent_id: record.agentId || "",
      options: { ...record.options },
      session_id: context.sessionId,
      execution_id: context.executionId,
      artifact_directory: context.artifactDirectory,
      outcome_status: outcome?.status ?? "",
      ...(outcome?.status === "question" ? {
        questions: outcome.questions, questions_file: path.join(context.directory, "questions.json"),
      } : {}),
      outcome_decision: outcome?.decision ?? "",
      session_status: typeof sessionStatus.status === "string" ? sessionStatus.status : "",
      response: responseText,
      failure_reason: failureReason,
      ...(failureDetail === "" ? {} : { failure_detail: failureDetail }),
      failure_kind: classification?.kind ?? "",
      reset_at: classification?.kind === "quota" && classification.resetAt ? classification.resetAt : "",
      provider: eventReporter.provider,
      execution_status: record.status,
    };
  }

  /**
   * Decide whether an unusable question file gets the one correction turn. Returns null when the
   * budget is already used. The budget is persisted before the message joins the history, so a
   * stop between the two writes still sends the correction on resume and never grants a second.
   */
  private questionRetry(
    error: QuestionFileError,
    correction: QuestionCorrection | null,
    turn: number,
    state: TurnDrive,
    eventReporter: ProviderEventReporter,
  ): { correction: QuestionCorrection; prompt: string } | null {
    const { store, context, record, decisionValues, stage, artifactName, sessionId } = state;
    if (correction !== null && correction.turn !== turn) return null;
    const used: QuestionCorrection = correction ?? { turn, error_kind: error.kind, error_detail: error.detail };
    if (correction === null) {
      store.saveExecutionProgress(context, record, { question_correction: used });
      eventReporter.emit("question.file_invalid", `${error.kind}: ${error.detail}`, {
        turn, error_kind: error.kind, file: error.file,
      });
    }
    const message = renderQuestionCorrection({
      questionFile: error.file, errorKind: used.error_kind, errorDetail: used.error_detail,
    });
    record.history.push({ role: "user", content: message });
    store.save(record, context);
    store.saveExecutionProgress(context, record, { turn_kind: "correction" });
    const ask = stage?.ask ?? (stage === null ? "human" : null);
    const base = record.agentId
      ? message
      : flattenHistory(record.history as Array<{ role: string; content: string }>);
    const prompt = renderProviderPrompt(base, { ...sessionPaths(context, sessionId),
      contract: record.agentId ? "reminder" : "full", turn: "correction", decisionValues, decisionInstructions: stage?.decisionInstructions, ask,
      questionFile: error.file, artifactDirectory: context.artifactDirectory, artifactName,
    });
    return { correction: used, prompt };
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

  private cachedCliVersion(provider: Provider, providerKey: string, workspace: string): string | null {
    if (this.cliVersions.has(providerKey)) return this.cliVersions.get(providerKey) ?? null;
    const version = readCliVersion(provider, workspace);
    this.cliVersions.set(providerKey, version);
    return version;
  }

  private async runTurn(
    provider: Provider,
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
  ): Promise<
    [
      string,
      string | null,
      string | null,
      string[],
      UsageCapture | null,
      FailureClassification | null,
      ResponseSource | undefined,
      number | null,
    ]
  > {
    const tmp = mkdtempSync(path.join(tmpdir(), "migent_"));
    try {
      const promptFile = path.join(tmp, "prompt.txt");
      const lastMessageFile = path.join(tmp, "last_message.txt");
      writeFileSync(promptFile, prompt, "utf8");
      const spec = provider.buildCommand({
        model,
        workspace,
        prompt,
        agentId,
        newAgentId: newSession?.agentId ?? null,
        promptFile,
        lastMessageFile,
        options,
      });
      const debugStep = debugEnabled()
        ? (step: string, fromWrapper = false) => {
            const line = `${new Date().toISOString()} turn=${turn} ${fromWrapper ? "wrapper: " : ""}${step}`;
            // Wrapper lines already reached stderr through the tee.
            if (!fromWrapper) log(`debug: ${line}`);
            store.appendDebugLog(context, line);
          }
        : null;
      // Every id this turn may own on the provider's server: the one Migent holds, and any
      // different one the provider reports. Cleanup targets all of them.
      const expectedId = agentId || newSession?.agentId || null;
      const knownIds = new Set<string>(expectedId ? [expectedId] : []);
      const reports = new Map<string, InterruptReport>();
      let mismatchReported = false;
      const reportMismatch = (reported: string) => {
        if (expectedId === null || reported === expectedId || mismatchReported) return;
        mismatchReported = true;
        eventReporter.emit(
          "provider.warning",
          `provider reported session ${reported}, not the expected ${expectedId}; both are targeted for cleanup`,
          { expected_agent_id: expectedId, reported_agent_id: reported },
        );
      };
      const cleanup = async (phase: "before" | "after", reason: StopReason): Promise<boolean> => {
        let attempted = false;
        for (const id of [...knownIds]) {
          // After the process is gone, only sessions not yet seen interrupted are asked again.
          if (phase === "after" && reports.get(id)?.outcome === "interrupted") continue;
          const report = await interruptSession(provider, id, workspace, this.interruptPolicy);
          if (report === null) continue;
          attempted = true;
          reports.set(id, report);
          const details = { agent_id: id, reason, phase, outcome: report.outcome, attempts: report.attempts };
          if (isSettled(report)) {
            eventReporter.emit("provider.interrupt", `session ${id}: ${report.outcome}`, details);
          } else if (phase === "after") {
            eventReporter.emit(
              "provider.warning",
              `could not confirm session ${id} stopped (${report.detail}); agent id retained for recovery`,
              details,
            );
          }
        }
        return attempted;
      };
      const result = await this.executor.run(spec, workspace, {
        onDebug: debugStep,
        // Only a provider with a server-side interrupt gets hooks, and so the exit grace period.
        ...(provider.interruptCommand === undefined
          ? {}
          : {
              onInterrupt: (reason: StopReason) => cleanup("before", reason),
              onStopped: (reason: StopReason) => cleanup("after", reason),
            }),
        onOutput: (line) => {
          const reported = provider.sessionIdFromLine?.(line) ?? null;
          if (reported !== null && !knownIds.has(reported)) {
            knownIds.add(reported);
            reportMismatch(reported);
          }
          const event = provider.parseProgressEvent?.(line);
          if (!isRecord(event) || typeof event.event !== "string") return;
          eventReporter.emit(
            event.event,
            typeof event.summary === "string" ? event.summary : null,
            isRecord(event.details) ? event.details : null,
          );
        },
        onHeartbeat: (elapsed) => {
          eventReporter.emit("provider.heartbeat", `running for ${elapsed}s`, {
            elapsed_seconds: elapsed,
          });
        },
        onStart: (info) => {
          store.saveProcessMetadata(context, info);
        },
      });
      const { stdout, error: executorError, exitCode, failure } = result;
      if (failure) store.saveDiagnostics(context, diagnosticsPayload(failure, turn));
      const [responseText, parsedProviderId, parsedSource] = provider.parseResponse(stdout, lastMessageFile);
      if (parsedProviderId) reportMismatch(parsedProviderId);
      const classification = classifyFinishedProcess(provider, stdout, exitCode, executorError);
      let invokeError = executorError;
      if (exitCode === 0 && classification !== null) invokeError = classification.message;
      let usage: UsageCapture | null = null;
      if (provider.captureUsage) {
        try {
          const captured = provider.captureUsage(stdout);
          usage = isRecord(captured) ? captured : null;
        } catch {
          usage = null;
        }
      }
      return [responseText, parsedProviderId, invokeError, spec.argv, usage, classification, parsedSource, exitCode];
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

function diagnosticsPayload(failure: ExecutionFailure, turn: number): Record<string, unknown> {
  return {
    schema_version: 1,
    turn,
    recorded_at: failure.failedAt,
    failure: {
      kind: failure.kind,
      phase: failure.phase,
      code: failure.code,
      errno: failure.errno,
      syscall: failure.syscall,
      path: failure.path,
      message: failure.message,
    },
    stderr_tail: failure.stderrTail,
    // Only the executable and the argument count: other tokens may carry secrets or prompt text.
    command: { executable: failure.executable, argument_count: failure.argCount },
    cwd: failure.cwd,
    endpoint: failure.endpoint,
    endpoint_length: Buffer.byteLength(failure.endpoint),
    migent_version: KERNEL_VERSION,
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    timings: { spawned_at: failure.spawnedAt, failed_at: failure.failedAt },
  };
}

function classifyFinishedProcess(
  provider: Provider,
  stdout: string,
  exitCode: number | null,
  executorError: string | null,
): FailureClassification | null {
  if (exitCode === null) return { kind: "provider", origin: "start", message: executorError ?? "" };
  if (provider.classifyFailure) {
    const classified = provider.classifyFailure(stdout, exitCode);
    // Signal death (negative, or the shell's 128 + signal) is not a normal exit: its reply never counts.
    const signalled = exitCode < 0 || (exitCode > 128 && exitCode <= 128 + 64);
    return classified !== null && signalled ? { ...classified, origin: "start" } : classified;
  }
  if (exitCode !== 0) return { kind: "provider", origin: "exit-only", message: `CLI exited with code ${exitCode}.` };
  return null;
}

function loadRunStage(store: SessionStore, sessionId: string, stageId: string): StageSpec | null {
  const sessionStatus = store.readSessionStatus(sessionId);
  if (sessionStatus.workflow_id === "agent") return null;
  const frozen = loadFrozenWorkflow(path.join(store.sessionsDirectory, sessionId));
  if (frozen) return frozen.stages[stageId] ?? null;
  const workflowPath = sessionStatus.workflow_path;
  if (typeof workflowPath === "string") {
    const stage = loadStage(store.workspace, workflowPath, stageId);
    if (stage !== null) return stage;
  }
  const workflowId = sessionStatus.workflow_id;
  if (typeof workflowId !== "string") return null;
  try {
    return loadNamedWorkflow(store.workspace, workflowId).stages[stageId] ?? null;
  } catch (error) {
    if (error instanceof ConfigurationError) return null;
    throw error;
  }
}

function withClient(provider: Provider, client: string | null): Provider {
  if (client === null) return provider;
  if (provider.withClient === undefined) throw new Error(`Provider ${provider.command} cannot switch CLI client.`);
  return provider.withClient(client) as Provider;
}

function profileOptions(provider: Provider, options: Record<string, string>): Record<string, string> {
  if (provider.profileOptions) return { ...provider.profileOptions(options) };
  const names = new Set(
    (provider.providerOptions?.() ?? []).filter((item) => item.overridable).map((item) => item.name),
  );
  const profile: Record<string, string> = {};
  for (const [key, value] of Object.entries(options)) {
    if (names.has(key)) profile[key] = value;
  }
  return profile;
}

function validateSessionProfile(
  previousProvider: string,
  previousModel: string,
  previousOptions: Record<string, string>,
  provider: string,
  model: string,
  options: Record<string, string>,
): void {
  if (
    previousProvider !== provider ||
    previousModel !== model ||
    !sameOptions(previousOptions, options)
  ) {
    throw new Error("Cannot resume an agent session with a different provider, model, or options.");
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
    if (!statSync(resolved).isDirectory()) throw new Error("missing");
    return resolved;
  } catch (error) {
    if (error instanceof Error && error.message === "missing") {
      throw new Error(`Workspace does not exist: ${workspace}`);
    }
    if (isMissingPath(error)) throw new Error(`Workspace does not exist: ${workspace}`);
    throw error;
  }
}

function expandHome(target: string): string {
  if (target === "~") return process.env.HOME || target;
  if (target.startsWith("~/")) return path.join(process.env.HOME || "", target.slice(2));
  return target;
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

interface PendingVerify {
  responseText: string;
  outcome: StageOutcome | null;
  invokeError: string | null;
  questionError: QuestionFileError | null;
}

interface TurnDrive {
  provider: Provider;
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
  lastResult: "pass" | "fail" | null;
  currentPrompt: string;
  currentAgentId: string | null;
  currentSession: NewSession | null;
  pendingVerify: PendingVerify | null;
  questionCorrection: QuestionCorrection | null;
}

function questionFailureMessage(error: QuestionFileError): string {
  return `The response said status: question, but the question request file is unusable (${error.kind}): ${error.detail}. ` +
    `File: ${error.file}. The agent had one correction turn. Run \`migent session continue\` to rerun the stage.`;
}

function verifyProgress(metadata: Record<string, unknown>): {
  red: number;
  runs: number;
  lastReport: string | null;
  lastResult: "pass" | "fail" | null;
} {
  const verify = isRecord(metadata.verify) ? metadata.verify : null;
  const lastResult = verify?.last_result === "pass" || verify?.last_result === "fail" ? verify.last_result : null;
  return {
    red: typeof verify?.red === "number" ? verify.red : 0,
    runs: typeof verify?.runs === "number" ? verify.runs : 0,
    lastReport: typeof verify?.last_report === "string" ? verify.last_report : null,
    lastResult,
  };
}

function frozenDocument(context: ExecutionContext) {
  return loadFrozenWorkflow(path.dirname(path.dirname(context.directory)));
}

function savedResponse(context: ExecutionContext, last: Record<string, string>): string {
  try {
    return readFileSync(path.join(context.directory, "response.md"), "utf8");
  } catch {
    return typeof last.content === "string" ? last.content : "";
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
      readFileSync(path.join(store.turnDirectory(context, turn), "outcome.json"), "utf8"),
    ) as unknown;
    if (isRecord(raw) && raw.status === "complete") {
      return new StageOutcome(
        raw.status,
        typeof raw.blocker === "string" && raw.blocker ? raw.blocker : null,
        typeof raw.decision === "string" && raw.decision ? raw.decision : null,
      );
    }
  } catch {
    // The saved response is the fallback.
  }
  return resolveStageOutcome(responseText, context2);
}

function readCliVersion(provider: Provider, workspace: string): string | null {
  if (!provider.versionCommand) return null;
  const argv = provider.versionCommand();
  const command = argv[0];
  if (command === undefined) return null;
  const result = spawnProviderSync(command, argv.slice(1), {
    encoding: "utf8",
    timeout: 10_000,
    cwd: workspace,
  });
  if (result.error || result.status !== 0 || !provider.parseVersion) return null;
  return provider.parseVersion(result.stdout ?? "");
}

function readGitFacts(workspace: string): { git_head: string | null; git_dirty: boolean | null } {
  const head = gitOutput(workspace, ["rev-parse", "HEAD"]);
  const porcelain = gitOutput(workspace, ["status", "--porcelain"]);
  if (head === null || porcelain === null || head.trim() === "") return { git_head: null, git_dirty: null };
  return { git_head: head.trim(), git_dirty: porcelain.trim() !== "" };
}

function gitOutput(workspace: string, args: string[]): string | null {
  const result = spawnProviderSync("git", args, {
    encoding: "utf8",
    timeout: 10_000,
    cwd: workspace,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}
