import {
  AgentToolRunner,
  CancellationRequested,
  ConfigurationError,
  createAgentSession,
  log,
  raiseCancellation,
  requireAgentSession,
  resolveRoleTarget,
  SessionStore,
} from "@migent/kernel";
import { printAgent, printError, printNotice } from "../display.js";
import { cliHooks } from "../hooks.js";
import { requireCurrentSchema } from "../migrate.js";
import { adapterMap, parseOptions } from "../provider.js";
import { resolvePrompt } from "../workspace.js";

export async function dispatchAgent(
  workspace: string,
  args: {
    role: string;
    task?: string | null;
    sessionId?: string | null;
    provider?: string | null;
    model?: string | null;
    options?: readonly string[];
    prompt?: string | null;
    promptFile?: string | null;
    promptStdin?: boolean;
    asJson?: boolean;
    runner?: AgentToolRunner | null;
  },
): Promise<number> {
  requireCurrentSchema(workspace);
  const parsed = parseOptions(args.options ?? []);
  const target = resolveRoleTarget(workspace, args.role, {
    provider: args.provider ?? null,
    model: args.model ?? null,
    options: Object.keys(parsed).length > 0 ? parsed : null,
  });
  const [resolvedSessionId, createdSession] = resolveSession(workspace, args.sessionId ?? null, args.role, args.task ?? null);
  let resumeExecutionId: string | null = null;
  if (!createdSession) {
    const previous = new SessionStore(workspace).latestExecution(resolvedSessionId);
    if (previous !== null) resumeExecutionId = previous.executionId;
  }
  const optionLabel =
    Object.entries(target.options)
      .map(([key, value]) => `${key}: ${value}`)
      .join(", ") || "default";
  printNotice(`agent ${args.role} · ${target.provider}/${target.model} (${optionLabel}).`);
  const onSigint = () => {
    try {
      raiseCancellation(2);
    } catch {
      // The runner observes the pending cancellation.
    }
  };
  const onSigterm = () => {
    try {
      raiseCancellation(15);
    } catch {
      // The runner observes the pending cancellation.
    }
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  let result: Awaited<ReturnType<AgentToolRunner["run"]>>;
  try {
    const runner = args.runner ?? cliHooks.runner ?? new AgentToolRunner(adapterMap());
    result = await runner.run({
      provider: target.provider,
      model: target.model,
      options: { ...target.options },
      prompt: resolvePrompt({
        prompt: args.prompt ?? null,
        promptFile: args.promptFile ?? null,
        promptStdin: args.promptStdin ?? false,
      }),
      workspace,
      sessionId: resolvedSessionId,
      resumeExecutionId,
      stageId: args.role,
    });
  } catch (error) {
    if (error instanceof CancellationRequested) {
      log(error.message);
      return 130;
    }
    if (error instanceof ConfigurationError) throw error;
    if (error instanceof Error) {
      printError(error.message);
      return 2;
    }
    throw error;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
  if (createdSession) printNotice(`session_id: ${result.session_id}`);
  if (args.asJson) process.stdout.write(`${JSON.stringify(result)}\n`);
  else printAgent({ ...result }, args.role, target.provider, target.model);
  return result.outcome_status === "complete" ? 0 : 1;
}

function resolveSession(
  workspace: string,
  sessionId: string | null,
  role: string,
  task: string | null,
): [string, boolean] {
  if (sessionId !== null && typeof task === "string" && task.trim() !== "") {
    throw new ConfigurationError("--task cannot be combined with a session.");
  }
  if (sessionId !== null) {
    requireAgentSession(workspace, sessionId);
    return [sessionId, false];
  }
  const taskSummary = (task ?? role).trim();
  return [createAgentSession(workspace, role, taskSummary), true];
}
