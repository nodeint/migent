import path from "node:path";
import {
  AgentToolRunner,
  CancellationRequested,
  ConfigurationError,
  createAgentSession,
  loadRoleInstructions,
  loadYamlMapping,
  log,
  prependRoleInstructions,
  requireAgentSession,
  isSessionLockLost,
  repairSessionUnlocked,
  SessionLock,
  resolveRoleTarget,
  SessionStore,
} from "@nodeint/migent-kernel";
import { printAgent, printError, printNotice } from "../display.js";
import { cliHooks } from "../hooks.js";
import { requireCurrentSchema } from "../migrate.js";
import { bindCancellationSignals } from "../signals.js";
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
  if (createdSession) log(`session_id: ${resolvedSessionId}`);
  let lock: SessionLock;
  try {
    lock = SessionLock.acquire(path.join(workspace, ".migent", "sessions", resolvedSessionId));
  } catch (error) {
    if (error instanceof Error) {
      printError(error.message);
      return 2;
    }
    throw error;
  }
  try {
    return await runLocked();
  } catch (error) {
    if (isSessionLockLost(error)) {
      printError(error.message);
      return 2;
    }
    throw error;
  } finally {
    lock.release();
  }

  async function runLocked(): Promise<number> {
    let resumeExecutionId: string | null = null;
    let resumeCancelled = false;
    if (!createdSession) {
      repairSessionUnlocked(workspace, resolvedSessionId);
      const store = new SessionStore(workspace);
      if (store.readSessionStatus(resolvedSessionId).status === "cancelled") {
        resumeCancelled = true;
      } else {
        const previous = store.latestExecution(resolvedSessionId);
        if (previous !== null) resumeExecutionId = previous.executionId;
      }
    }
    const optionLabel =
      Object.entries(target.options)
        .map(([key, value]) => `${key}: ${value}`)
        .join(", ") || "default";
    printNotice(`agent ${args.role} · ${target.provider}/${target.model} (${optionLabel}).`);
    const unbind = bindCancellationSignals();
    let result: Awaited<ReturnType<AgentToolRunner["run"]>>;
    try {
      const runner = args.runner ?? cliHooks.runner ?? new AgentToolRunner(adapterMap());
      if (resumeCancelled) {
        const reopened = new SessionStore(workspace).reopenCancelledExecutions(resolvedSessionId);
        for (const item of reopened) {
          log(`session ${resolvedSessionId} was cancelled during ${item.executionId}. Resuming that execution.`);
        }
        const settled = await Promise.allSettled(
          reopened.map((item) => runner.continueCancelled(workspace, resolvedSessionId, item.executionId)),
        );
        const rejected = settled.find((item) => item.status === "rejected");
        if (rejected && rejected.status === "rejected") throw rejected.reason;
        const continued = settled.flatMap((item) => (item.status === "fulfilled" ? [item.value] : []));
        const selected = continued.at(-1);
        if (selected === undefined) {
          throw new ConfigurationError(`Session ${resolvedSessionId} is cancelled without an execution.`);
        }
        result = selected;
      } else {
        result = await runner.run({
          provider: target.provider,
          model: target.model,
          options: { ...target.options },
          prompt: prependRoleInstructions(
            loadRoleInstructions(loadYamlMapping(path.join(workspace, ".migent", "config.yaml")), args.role),
            resolvePrompt({
              prompt: args.prompt ?? null,
              promptFile: args.promptFile ?? null,
              promptStdin: args.promptStdin ?? false,
            }),
          ),
          workspace,
          sessionId: resolvedSessionId,
          resumeExecutionId,
          stageId: args.role,
        });
      }
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
      unbind();
    }
    if (args.asJson) process.stdout.write(`${JSON.stringify(result)}\n`);
    else printAgent({ ...result }, args.role, target.provider, target.model);
    return result.outcome_status === "complete" ? 0 : 1;
  }
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
