import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  defaultAdapters,
  type AgentAdapter,
  type FailureClassification,
  type NewSession,
  type UsageCapture,
} from "./adapter.js";
import { CancellationRequested, CommandExecutor, DEFAULT_TIMEOUT_SEC } from "./command-executor.js";
import { spawnProviderSync } from "./provider-spawn.js";
import { buildVerifyRepairPrompt } from "./prompt.js";
import { VERIFY_EXHAUSTED } from "./selection.js";
import { VerifyRunner, formatVerifyReport, type VerifyRunResult } from "./verify-runner.js";
import { ConfigurationError } from "./errors.js";
import { nonemptyArtifact } from "./outputs.js";
import { isRecord } from "./record.js";
import {
  addArtifactContext,
  addStageOutcomeContract,
  flattenHistory,
  log,
} from "./runtime.js";
import { ProviderEventReporter } from "./provider-events.js";
import { loadFrozenWorkflow } from "./session-freeze.js";
import { AgentSessionRecord, SessionStore, stringOptions, type ExecutionContext } from "./session-store.js";
import { parseStageOutcome, StageOutcome } from "./stage-outcome.js";
import { isWorkflowV2, loadNamedWorkflow, loadStage, type StageSpec } from "./workflow.js";

export interface RunResult {
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
  prompt: string;
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

export class AgentToolRunner {
  readonly adapters: Record<string, AgentAdapter>;
  readonly executor: CommandExecutor;
  readonly verifyRunner: VerifyRunner;
  itemProgress = false;
  private readonly cliVersions = new Map<string, string | null>();

  constructor(
    adapters?: Record<string, AgentAdapter>,
    timeoutSec: number | null = DEFAULT_TIMEOUT_SEC,
    verifyRunner: VerifyRunner = new VerifyRunner(),
  ) {
    this.verifyRunner = verifyRunner;
    this.adapters = adapters ?? defaultAdapters();
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
    const adapter = this.adapters[providerKey];
    if (adapter === undefined) {
      const supported = Object.keys(this.adapters).sort().join(", ");
      throw new Error(`Unsupported CLI provider: ${request.provider}. Supported: ${supported}`);
    }
    const resolvedOptions = { ...(request.options ?? {}) };
    adapter.validateOptions(resolvedOptions);
    const profile = profileOptions(adapter, resolvedOptions);
    const store = new SessionStore(workspacePath, undefined, this.adapters);
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
    const newSession = isNew ? (adapter.createNewSession?.() ?? { agentId: null }) : null;
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
    if (sessionId !== null) turnPrompt = addStageOutcomeContract(turnPrompt, decisionValues);
    const artifactName = stage?.artifact ?? null;
    const verifyCommands = stage?.verify ?? [];
    if (request.resumeExecutionId && verifyCommands.length > 0 && artifactName) {
      this.carryExhaustedArtifact(store, context, request.resumeExecutionId, artifactName);
    }
    turnPrompt = addArtifactContext(turnPrompt, context.artifactDirectory, artifactName);
    store.savePrompt(context, turnPrompt);
    const started: Record<string, unknown> = {
      cli_version: this.cachedCliVersion(adapter, providerKey, workspacePath),
      ...readGitFacts(workspacePath),
    };
    if (Object.keys(profile).length > 0) started.options = profile;
    eventReporter.emit("provider.stage_started", `${providerKey}/${request.model}`, started);

    return this.driveTurns({
      adapter,
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
      red: 0,
      verifyRuns: 0,
      lastReport: null,
      lastResult: null,
      currentPrompt: turnPrompt,
      currentAgentId: agentId,
      currentSession: newSession,
      pendingVerify: null,
    });
  }

  /** Finish a cancelled execution that has been reopened in place. Does not create an attempt. */
  async continueCancelled(workspace: string, sessionId: string, executionId: string): Promise<RunResult> {
    const workspacePath = resolveWorkspace(workspace);
    const store = new SessionStore(workspacePath, undefined, this.adapters);
    const context = store.executionContext(sessionId, executionId);
    if (context === null) throw new Error(`Execution ${executionId} was not found in session ${sessionId}.`);
    const metadata = JSON.parse(readFileSync(path.join(context.directory, "execution.json"), "utf8")) as unknown;
    if (!isRecord(metadata)) throw new Error(`Execution ${executionId} is unreadable.`);
    if (metadata.status !== "running") {
      throw new Error(`Execution ${executionId} is ${String(metadata.status)}, not running.`);
    }
    const providerKey = typeof metadata.provider === "string" ? metadata.provider.toLowerCase() : "";
    const model = typeof metadata.model === "string" ? metadata.model : "";
    const adapter = this.adapters[providerKey];
    if (adapter === undefined) {
      const supported = Object.keys(this.adapters).sort().join(", ");
      throw new Error(`Unsupported CLI provider: ${String(metadata.provider)}. Supported: ${supported}`);
    }
    const resolvedOptions = stringOptions(metadata.options);
    adapter.validateOptions(resolvedOptions);
    const profile = profileOptions(adapter, resolvedOptions);
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
    const artifactName = stage?.artifact ?? null;
    const verifyCommands = stage?.verify ?? [];
    const eventReporter = new ProviderEventReporter(store, context, providerKey, model, this.itemProgress);
    const progress = verifyProgress(metadata);
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
      } else {
        currentPrompt = agentId
          ? last.content
          : flattenHistory(record.history as Array<{ role: string; content: string }>);
        currentPrompt = addStageOutcomeContract(currentPrompt, decisionValues);
      }
      return this.driveTurns({
        adapter,
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
      });
    }
    const turn = Math.max(1, assistants);
    const responseText = savedResponse(context, last);
    let outcome: StageOutcome | null = null;
    let invokeError: string | null = null;
    try {
      outcome = savedOutcome(store, context, turn, responseText, sessionId !== null, decisionValues);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      invokeError = error.message;
    }
    return this.driveTurns({
      adapter,
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
      pendingVerify: { responseText, outcome, invokeError },
    });
  }

  private async driveTurns(state: TurnDrive): Promise<RunResult> {
    const {
      adapter,
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
    let turn = state.turn;
    let red = state.red;
    let verifyRuns = state.verifyRuns;
    let lastReport = state.lastReport;
    let lastResult = state.lastResult;
    let currentPrompt = state.currentPrompt;
    let currentAgentId = state.currentAgentId;
    let currentSession = state.currentSession;
    let pendingVerify = state.pendingVerify;
    let responseText = pendingVerify?.responseText ?? "";
    let outcome: StageOutcome | null = pendingVerify?.outcome ?? null;
    let failureReason = "";
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
      if (classification?.kind !== "quota") return extraFields();
      failureReason = "quota";
      return { ...(extraFields() ?? {}), failure_reason: "quota", retry_at: classification.resetAt };
    };
    while (true) {
      let invokeError: string | null = null;
      if (pendingVerify) {
        responseText = pendingVerify.responseText;
        outcome = pendingVerify.outcome;
        invokeError = pendingVerify.invokeError;
        pendingVerify = null;
      } else {
        let parsedProviderId: string | null;
        let argv: string[] = [];
        let usage: UsageCapture | null = null;
        try {
          [responseText, parsedProviderId, invokeError, argv, usage, classification] = await this.runTurn(
            adapter,
            model,
            workspacePath,
            currentPrompt,
            currentAgentId,
            currentSession,
            resolvedOptions,
            eventReporter,
            store,
            context,
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
        eventReporter.emit(
          invokeError === null ? "provider.turn_completed" : "provider.turn_failed",
          invokeError === null ? "completed" : invokeError,
          turnDetails,
        );
        record.model = model;
        record.options = profile;
        record.workspace = workspacePath;
        outcome = null;
        if (invokeError === null) {
          try {
            outcome = parseStageOutcome(responseText, sessionId !== null, decisionValues);
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            invokeError = error.message;
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
        const needsVerify =
          verifyCommands.length > 0 && invokeError === null && outcome?.status === "complete";
        record.status = needsVerify ? "running" : invokeError === null ? "completed" : "failed";
        record.history.push({ role: "assistant", content: responseText });
        store.save(record, context);
        store.saveResponse(context, responseText);
        if (verifyCommands.length > 0) {
          store.saveTurnResponse(context, turn, responseText);
          if (outcome?.status === "complete") store.saveTurnOutcome(context, turn, outcome);
        }
        if (!needsVerify || outcome === null) {
          store.saveExecution(context, record, record.status, invokeError, outcome, false, outcomeFields());
          break;
        }
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
      turn += 1;
      currentAgentId = record.agentId;
      currentSession = null;
      currentPrompt = currentAgentId
        ? repair
        : flattenHistory(record.history as Array<{ role: string; content: string }>);
      currentPrompt = addStageOutcomeContract(currentPrompt, decisionValues);
    }
    const sessionStatus = store.readSessionStatus(context.sessionId);
    return {
      agent_id: record.agentId || "",
      options: { ...record.options },
      session_id: context.sessionId,
      execution_id: context.executionId,
      artifact_directory: context.artifactDirectory,
      outcome_status: outcome?.status ?? "",
      outcome_decision: outcome?.decision ?? "",
      session_status: typeof sessionStatus.status === "string" ? sessionStatus.status : "",
      response: responseText,
      failure_reason: failureReason,
      failure_kind: classification?.kind ?? "",
      reset_at: classification?.kind === "quota" && classification.resetAt ? classification.resetAt : "",
      provider: eventReporter.provider,
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

  private cachedCliVersion(adapter: AgentAdapter, providerKey: string, workspace: string): string | null {
    if (this.cliVersions.has(providerKey)) return this.cliVersions.get(providerKey) ?? null;
    const version = readCliVersion(adapter, workspace);
    this.cliVersions.set(providerKey, version);
    return version;
  }

  private async runTurn(
    adapter: AgentAdapter,
    model: string,
    workspace: string,
    prompt: string,
    agentId: string | null,
    newSession: NewSession | null,
    options: Record<string, string>,
    eventReporter: ProviderEventReporter,
    store: SessionStore,
    context: ExecutionContext,
  ): Promise<[string, string | null, string | null, string[], UsageCapture | null, FailureClassification | null]> {
    const tmp = mkdtempSync(path.join(tmpdir(), "migent_"));
    try {
      const promptFile = path.join(tmp, "prompt.txt");
      const lastMessageFile = path.join(tmp, "last_message.txt");
      writeFileSync(promptFile, prompt, "utf8");
      const spec = adapter.buildCommand({
        model,
        workspace,
        prompt,
        agentId,
        newAgentId: newSession?.agentId ?? null,
        promptFile,
        lastMessageFile,
        options,
      });
      const [stdout, executorError, exitCode] = await this.executor.run(
        spec,
        workspace,
        (line) => {
          const event = adapter.parseProgressEvent?.(line);
          if (!isRecord(event) || typeof event.event !== "string") return;
          eventReporter.emit(
            event.event,
            typeof event.summary === "string" ? event.summary : null,
            isRecord(event.details) ? event.details : null,
          );
        },
        (elapsed) => {
          eventReporter.emit("provider.heartbeat", `running for ${elapsed}s`, {
            elapsed_seconds: elapsed,
          });
        },
        (info) => {
          store.saveProcessMetadata(context, info);
        },
      );
      const [responseText, parsedProviderId] = adapter.parseResponse(stdout, lastMessageFile);
      const classification = classifyFinishedProcess(adapter, stdout, exitCode, executorError);
      let invokeError = executorError;
      if (exitCode === 0 && classification !== null) invokeError = classification.message;
      let usage: UsageCapture | null = null;
      if (adapter.captureUsage) {
        try {
          const captured = adapter.captureUsage(stdout);
          usage = isRecord(captured) ? captured : null;
        } catch {
          usage = null;
        }
      }
      return [responseText || invokeError || "", parsedProviderId, invokeError, spec.argv, usage, classification];
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

function classifyFinishedProcess(
  adapter: AgentAdapter,
  stdout: string,
  exitCode: number | null,
  executorError: string | null,
): FailureClassification | null {
  if (exitCode === null) return { kind: "provider", message: executorError ?? "" };
  if (adapter.classifyFailure) return adapter.classifyFailure(stdout, exitCode);
  if (exitCode !== 0) return { kind: "provider", message: `CLI exited with code ${exitCode}.` };
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

function profileOptions(adapter: AgentAdapter, options: Record<string, string>): Record<string, string> {
  if (adapter.profileOptions) return { ...adapter.profileOptions(options) };
  const names = new Set(
    (adapter.providerOptions?.() ?? []).filter((item) => item.overridable).map((item) => item.name),
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
}

interface TurnDrive {
  adapter: AgentAdapter;
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
  required: boolean,
  decisionValues: readonly string[],
): StageOutcome | null {
  try {
    const raw = JSON.parse(
      readFileSync(path.join(store.turnDirectory(context, turn), "outcome.json"), "utf8"),
    ) as unknown;
    if (isRecord(raw) && typeof raw.status === "string" && raw.status) {
      return new StageOutcome(
        raw.status,
        typeof raw.blocker === "string" && raw.blocker ? raw.blocker : null,
        typeof raw.decision === "string" && raw.decision ? raw.decision : null,
      );
    }
  } catch {
    // The saved response is the fallback.
  }
  return parseStageOutcome(responseText, required, decisionValues);
}

function readCliVersion(adapter: AgentAdapter, workspace: string): string | null {
  if (!adapter.versionCommand) return null;
  const argv = adapter.versionCommand();
  const command = argv[0];
  if (command === undefined) return null;
  const result = spawnProviderSync(command, argv.slice(1), {
    encoding: "utf8",
    timeout: 10_000,
    cwd: workspace,
  });
  if (result.error || result.status !== 0 || !adapter.parseVersion) return null;
  return adapter.parseVersion(result.stdout ?? "");
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
