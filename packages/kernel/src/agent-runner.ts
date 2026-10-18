import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  defaultAdapters,
  type AgentAdapter,
  type NewSession,
} from "./adapter.js";
import { CancellationRequested, CommandExecutor, DEFAULT_TIMEOUT_SEC } from "./command-executor.js";
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
import { AgentSessionRecord, SessionStore, type ExecutionContext } from "./session-store.js";
import { parseStageOutcome, type StageOutcome } from "./stage-outcome.js";
import { loadNamedWorkflow, loadStage, type StageSpec } from "./workflow.js";

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
}

export class AgentToolRunner {
  readonly adapters: Record<string, AgentAdapter>;
  readonly executor: CommandExecutor;
  readonly verifyRunner: VerifyRunner;

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
    const store = new SessionStore(workspacePath);
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
    const eventReporter = new ProviderEventReporter(store, context, providerKey, request.model);
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
    eventReporter.emit(
      "provider.stage_started",
      `${providerKey}/${request.model}`,
      Object.keys(profile).length > 0 ? { options: profile } : null,
    );

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

    const maxVerify = stage?.maxVerify ?? 0;
    let turn = 1;
    let red = 0;
    let verifyRuns = 0;
    let lastReport: string | null = null;
    let lastResult: "pass" | "fail" | null = null;
    let currentPrompt = turnPrompt;
    let currentAgentId = agentId;
    let currentSession = newSession;
    let responseText: string;
    let outcome: StageOutcome | null;
    let failureReason = "";
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
    while (true) {
      let parsedProviderId: string | null;
      let invokeError: string | null;
      try {
        [responseText, parsedProviderId, invokeError] = await this.runTurn(
          adapter,
          request.model,
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

      eventReporter.emit(
        invokeError === null ? "provider.turn_completed" : "provider.turn_failed",
        invokeError === null ? "completed" : invokeError,
      );
      record.agentId = parsedProviderId || record.agentId;
      record.model = request.model;
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
      if (invokeError === null && outcome !== null) {
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
        store.saveExecution(context, record, record.status, invokeError, outcome, false, extraFields());
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
      const repair = buildVerifyRepairPrompt(
        report,
        red,
        maxVerify,
        artifactName ? path.join(context.artifactDirectory, artifactName) : null,
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
  ): Promise<[string, string | null, string | null]> {
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
      const [stdout, invokeError] = await this.executor.run(
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
      return [responseText || invokeError || "", parsedProviderId, invokeError];
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

function loadRunStage(store: SessionStore, sessionId: string, stageId: string): StageSpec | null {
  const sessionStatus = store.readSessionStatus(sessionId);
  if (sessionStatus.workflow_id === "agent") return null;
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
