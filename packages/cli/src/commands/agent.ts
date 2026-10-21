import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AgentToolRunner,
  CancellationRequested,
  ConfigurationError,
  ProviderEventReporter,
  SessionStore,
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
  waitUntil,
  type RunResult,
  type WaitHooks,
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
    waitHooks?: WaitHooks;
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
    let result: Awaited<ReturnType<AgentToolRunner["run"]>> | undefined;
    let resumedMany: Array<Awaited<ReturnType<AgentToolRunner["run"]>>> | null = null;
    try {
      const runner = args.runner ?? cliHooks.runner ?? new AgentToolRunner(adapterMap());
      const waitedUntil = new Map<string, string>();
      const rerun = (prompt: string, resumeId: string) =>
        runner.run({
          provider: target.provider,
          model: target.model,
          options: { ...target.options },
          prompt,
          workspace,
          sessionId: resolvedSessionId,
          resumeExecutionId: resumeId,
          stageId: args.role,
        });
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
        if (continued.length === 0) {
          throw new ConfigurationError(`Session ${resolvedSessionId} is cancelled without an execution.`);
        }
        const finished: RunResult[] = [];
        for (const item of continued) {
          finished.push(
            await rerunQuota(
              workspace,
              resolvedSessionId,
              item,
              (current) => lastUserPrompt(workspace, resolvedSessionId, current.execution_id),
              rerun,
              waitedUntil,
              args.waitHooks,
            ),
          );
        }
        if (finished.length === 1) result = finished[0];
        else resumedMany = finished;
      } else {
        const prompt = prependRoleInstructions(
          loadRoleInstructions(loadYamlMapping(path.join(workspace, ".migent", "config.yaml")), args.role),
          resolvePrompt({
            prompt: args.prompt ?? null,
            promptFile: args.promptFile ?? null,
            promptStdin: args.promptStdin ?? false,
          }),
        );
        result = await rerunQuota(
          workspace,
          resolvedSessionId,
          await runner.run({
            provider: target.provider,
            model: target.model,
            options: { ...target.options },
            prompt,
            workspace,
            sessionId: resolvedSessionId,
            resumeExecutionId,
            stageId: args.role,
          }),
          () => prompt,
          rerun,
          waitedUntil,
          args.waitHooks,
        );
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
    if (resumedMany !== null) {
      if (args.asJson) process.stdout.write(`${JSON.stringify(resumedMany)}\n`);
      else {
        for (const item of resumedMany) printAgent({ ...item }, args.role, target.provider, target.model);
      }
      if (resumedMany.some((item) => item.failure_reason === "verify_exhausted")) return 6;
      return resumedMany.every((item) => item.outcome_status === "complete") ? 0 : 1;
    }
    if (result === undefined) throw new Error("Agent run produced no result.");
    if (args.asJson) process.stdout.write(`${JSON.stringify(result)}\n`);
    else printAgent({ ...result }, args.role, target.provider, target.model);
    return result.outcome_status === "complete" ? 0 : 1;
  }
}

async function rerunQuota(
  workspace: string,
  sessionId: string,
  initial: RunResult,
  promptFor: (result: RunResult) => string,
  run: (prompt: string, resumeExecutionId: string) => Promise<RunResult>,
  waitedUntil: Map<string, string>,
  hooks?: WaitHooks,
): Promise<RunResult> {
  let current = initial;
  let armed: string | null = null;
  while (current.failure_kind === "quota" && current.reset_at !== "") {
    if (armed !== null && !laterInstant(current.reset_at, armed)) return current;
    const resetAt = current.reset_at;
    const provider = current.provider;
    const shared = waitedUntil.get(provider);
    const now = hooks?.now ?? Date.now;
    const past = !Number.isFinite(Date.parse(resetAt)) || now() >= Date.parse(resetAt);
    if (!past && (shared === undefined || laterInstant(resetAt, shared))) {
      emitRoleQuota(workspace, sessionId, current);
      await waitUntil(resetAt, hooks).promise;
    }
    waitedUntil.set(provider, resetAt);
    armed = resetAt;
    current = await run(promptFor(current), current.execution_id);
  }
  return current;
}

function laterInstant(next: string, previous: string): boolean {
  const left = Date.parse(next);
  const right = Date.parse(previous);
  if (Number.isFinite(left) && Number.isFinite(right)) return left > right;
  return next > previous;
}

function emitRoleQuota(workspace: string, sessionId: string, result: RunResult): void {
  const store = new SessionStore(workspace);
  const context = store.executionContext(sessionId, result.execution_id);
  if (context === null) return;
  let model = "";
  try {
    const metadata = JSON.parse(readFileSync(path.join(context.directory, "execution.json"), "utf8")) as unknown;
    if (isRecord(metadata) && typeof metadata.model === "string") model = metadata.model;
  } catch {
    model = "";
  }
  const summary = [result.response, result.reset_at].filter((item) => item !== "").join(" ");
  new ProviderEventReporter(store, context, result.provider, model).emit("provider.quota", summary, {
    retry_at: result.reset_at,
    provider: result.provider,
  });
}

function lastUserPrompt(workspace: string, sessionId: string, executionId: string): string {
  const context = new SessionStore(workspace).executionContext(sessionId, executionId);
  if (context === null) throw new ConfigurationError(`Execution ${executionId} was not found.`);
  const raw = JSON.parse(readFileSync(context.conversationReadPath, "utf8")) as unknown;
  const history = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.history) ? raw.history : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (isRecord(entry) && entry.role === "user" && typeof entry.content === "string" && entry.content !== "") {
      return entry.content;
    }
  }
  throw new ConfigurationError(`Execution ${executionId} has no prompt to resume.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
