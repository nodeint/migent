import type { RunResult } from "./agent-runner.js";
import { AgentSessionRecord, SessionStore, type ExecutionContext } from "./session-store.js";
import { CancellationRequested } from "./command-executor.js";
import { ProviderEventReporter } from "./provider-events.js";
import { formatClock, log } from "./runtime.js";
import { parseExecutionId } from "./session-events.js";
import { VERIFY_FAILED } from "./selection.js";
import { StageOutcome } from "./stage-outcome.js";
import { VerifyRunner, formatVerifyReport, type VerifyRunResult } from "./verify-runner.js";
import type { VerifyOnlyStageSpec } from "./workflow.js";

const VERIFY_TURN = 1;

export async function runVerifyOnlyStage(input: {
  workspace: string;
  sessionId: string;
  stage: VerifyOnlyStageSpec;
  verifyRunner: VerifyRunner;
  adapters?: ConstructorParameters<typeof SessionStore>[2];
  /** Reuse a cancelled execution that has already been reopened. */
  executionId?: string | null;
  onExecution?: (executionId: string) => void;
}): Promise<RunResult> {
  const store = new SessionStore(input.workspace, undefined, input.adapters);
  const context = openContext(store, input.sessionId, input.stage.id, input.executionId ?? null);
  input.onExecution?.(context.executionId);
  if (input.executionId == null) log(startLine(input.stage, parseExecutionId(context.executionId)?.attempt ?? null));
  const reporter = new ProviderEventReporter(store, context, "", "", false);
  reporter.emit("verify.started", `${input.stage.verify.length} command(s)`, {
    turn: VERIFY_TURN,
    commands: input.stage.verify,
  });
  const record = new AgentSessionRecord("", "", input.workspace, null, {}, "running");
  let result: VerifyRunResult;
  try {
    result = await input.verifyRunner.run({
      commands: input.stage.verify,
      workspace: input.workspace,
      executionDirectory: context.directory,
      turnDirectory: store.turnDirectory(context, VERIFY_TURN),
      timeoutSec: input.stage.verifyTimeoutSec,
      onStart: (info) => {
        store.saveProcessMetadata(context, info);
      },
      onEnd: () => {
        store.clearProcessEndpoint(context);
      },
      onHeartbeat: (command, elapsed) => {
        reporter.emit("verify.heartbeat", `${command} running for ${elapsed}s`, {
          turn: VERIFY_TURN,
          command,
          elapsed_seconds: elapsed,
        });
      },
    });
  } catch (error) {
    if (error instanceof CancellationRequested) {
      record.status = "cancelled";
      store.saveExecution(context, record, "cancelled");
      log(`Execution ${context.executionId} marked cancelled.`);
    }
    throw error;
  }
  const passed = result.passed && result.infraError === null;
  const red = passed ? 0 : 1;
  const report = store.saveTurnVerify(
    context,
    VERIFY_TURN,
    formatVerifyReport(result, {
      run: 1,
      red,
      maxVerify: 1,
      timeoutSec: input.stage.verifyTimeoutSec,
    }),
  );
  if (passed) {
    reporter.emit("verify.passed", "all commands passed", { turn: VERIFY_TURN, report });
    const outcome = new StageOutcome("complete");
    store.saveExecution(context, record, "completed", null, outcome);
    store.publishVerifyReport(context, VERIFY_TURN);
    return executionJson(store, context, "complete", "");
  }
  const failed = result.commands.find((item) => item.status === "fail" || item.status === "timed_out");
  const error = result.infraError ?? `Verify failed: ${failed?.command ?? "verify"}`;
  reporter.emit("verify.failed", `${failed?.command ?? "verify"} failed`, {
    turn: VERIFY_TURN,
    command: failed?.command ?? null,
    status: failed?.status ?? null,
    exit_code: failed?.exitCode ?? null,
    report,
  });
  store.saveExecution(context, record, "failed", error, null, false, { failure_reason: VERIFY_FAILED });
  return executionJson(store, context, "", VERIFY_FAILED);
}

function openContext(
  store: SessionStore,
  sessionId: string,
  stageId: string,
  executionId: string | null,
): ExecutionContext {
  if (executionId === null) return store.openVerifyExecution(sessionId, stageId);
  const context = store.executionContext(sessionId, executionId);
  if (context === null) throw new Error(`Execution ${executionId} was not found in session ${sessionId}.`);
  store.clearVerifyTurn(context);
  return context;
}

function startLine(stage: VerifyOnlyStageSpec, attempt: number | null): string {
  const detail = `verify (${stage.verify.length} command${stage.verify.length === 1 ? "" : "s"})`;
  const parts = [`stage ${stage.id}`];
  if (attempt !== null) parts.push(`attempt ${attempt}`);
  parts.push(formatClock(), detail);
  const base = parts.join(" · ");
  if (stage.description === null) return `${base}.`;
  return `${base} — ${stage.description}.`;
}

function executionJson(
  store: SessionStore,
  context: ExecutionContext,
  outcomeStatus: string,
  failureReason: string,
): RunResult {
  const sessionStatus = store.readSessionStatus(context.sessionId);
  return {
    agent_id: "",
    options: {},
    session_id: context.sessionId,
    execution_id: context.executionId,
    artifact_directory: context.artifactDirectory,
    failure_reason: failureReason,
    failure_kind: "",
    reset_at: "",
    provider: "",
    outcome_status: outcomeStatus,
    outcome_decision: "",
    session_status: typeof sessionStatus.status === "string" ? sessionStatus.status : "",
    response: "",
  };
}
