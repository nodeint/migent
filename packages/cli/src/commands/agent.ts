import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AgentToolRunner,
  createProviderResolver,
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
  stringOptions,
  loadWorkspaceConfig,
  resolveRoleTarget,
  waitUntil,
  type RunResult,
  type WaitHooks,
} from "@nodeint/migent-kernel";
import { printAgent, printError, printNotice, printResumeCommand } from "../display.js";
import { cliHooks } from "../hooks.js";
import { requireCurrentSchema } from "../migrate.js";
import { bindCancellationSignals } from "../signals.js";
import { providerMap, parseOptions } from "../provider.js";
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
  const runner = args.runner ?? cliHooks.runner ?? new AgentToolRunner(providerMap());
  const parsed = parseOptions(args.options ?? []);
  const target = resolveRoleTarget(workspace, args.role, {
    provider: args.provider ?? null,
    model: args.model ?? null,
    options: Object.keys(parsed).length > 0 ? parsed : null,
  }, createProviderResolver(runner.providers));
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
    const unbind = bindCancellationSignals(lock);
    let result: Awaited<ReturnType<AgentToolRunner["run"]>> | undefined;
    let resumedMany: Array<Awaited<ReturnType<AgentToolRunner["run"]>>> | null = null;
    try {
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
          loadRoleInstructions(loadWorkspaceConfig(workspace), args.role),
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
        return finishRole(resolvedSessionId, 130);
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
      if (resumedMany.some((item) => item.failure_reason === "verify_exhausted")) {
        return finishRole(resolvedSessionId, 6);
      }
      return finishRole(resolvedSessionId, resumedMany.every((item) => item.outcome_status === "complete") ? 0 : 1);
    }
    if (result === undefined) throw new Error("Agent run produced no result.");
    if (args.asJson) process.stdout.write(`${JSON.stringify(result)}\n`);
    else printAgent({ ...result }, args.role, target.provider, target.model);
    return finishRole(resolvedSessionId, result.outcome_status === "complete" ? 0 : 1);
  }
}

export async function continueAgent(
  workspace: string,
  args: { sessionId: string; reply: string | null; runner?: AgentToolRunner | null; waitHooks?: WaitHooks },
): Promise<number> {
  requireCurrentSchema(workspace);
  requireAgentSession(workspace, args.sessionId);
  let lock: SessionLock;
  try {
    lock = SessionLock.acquire(path.join(workspace, ".migent", "sessions", args.sessionId));
  } catch (error) {
    if (error instanceof Error) {
      printError(error.message);
      return 2;
    }
    throw error;
  }
  try {
    return await continueLocked();
  } catch (error) {
    if (isSessionLockLost(error)) {
      printError(error.message);
      return 2;
    }
    throw error;
  } finally {
    lock.release();
  }

  async function continueLocked(): Promise<number> {
    repairSessionUnlocked(workspace, args.sessionId);
    const store = new SessionStore(workspace);
    const status = store.readSessionStatus(args.sessionId);
    const sessionStatus = typeof status.status === "string" ? status.status : "";
    const role = typeof status.role === "string" ? status.role : "";
    if (role === "") throw new ConfigurationError(`Session ${args.sessionId} has no role.`);
    if (sessionStatus === "completed" && args.reply === null) {
      printNotice(`Session ${args.sessionId} is completed.`);
      return 0;
    }
    if (sessionStatus === "cancelled" && args.reply !== null) {
      throw new ConfigurationError(
        `Session ${args.sessionId} was cancelled. session continue resumes that execution. Omit --reply.`,
      );
    }
    const latest = store.latestExecution(args.sessionId);
    if (latest === null) throw new ConfigurationError(`Session ${args.sessionId} has no execution.`);
    const profile = executionProfile(latest.directory, latest.executionId);
    const optionLabel =
      Object.entries(profile.options)
        .map(([key, value]) => `${key}: ${value}`)
        .join(", ") || "default";
    printNotice(`agent ${role} · ${profile.provider}/${profile.model} (${optionLabel}).`);
    const unbind = bindCancellationSignals(lock);
    try {
      const runner = args.runner ?? cliHooks.runner ?? new AgentToolRunner(providerMap());
      if (sessionStatus === "cancelled") {
        return await runCancelledRole(
          workspace,
          args.sessionId,
          role,
          profile,
          runner,
          false,
          args.waitHooks,
        );
      }
      let prompt: string;
      if (args.reply !== null) {
        prompt = rolePrompt(workspace, role, args.reply);
      } else if (sessionStatus === "blocked") {
        const blocker = executionBlocker(latest.directory);
        const resumed = store.resumeBlockedSession(args.sessionId);
        for (const item of resumed) {
          log(`session ${args.sessionId} was blocked by ${item.executionId}. Resuming ${role}.`);
        }
        const lines = ["Previous attempt:", `- execution: ${latest.executionId}`];
        if (blocker) lines.push(`- blocker: ${blocker}`);
        lines.push("That attempt ended blocked. The blocker was handled outside this session. Continue.");
        prompt = rolePrompt(workspace, role, lines.join("\n"));
      } else if (sessionStatus === "active") {
        log(`session ${args.sessionId} is active. Resuming ${role} with its last prompt.`);
        prompt = lastUserPrompt(workspace, args.sessionId, latest.executionId);
      } else {
        throw new ConfigurationError(`Session ${args.sessionId} is ${sessionStatus || "unknown"}.`);
      }
      const waitedUntil = new Map<string, string>();
      const rerun = (nextPrompt: string, resumeId: string) =>
        runner.run({
          provider: profile.provider,
          model: profile.model,
          options: { ...profile.options },
          prompt: nextPrompt,
          workspace,
          sessionId: args.sessionId,
          resumeExecutionId: resumeId,
          stageId: role,
        });
      const result = await rerunQuota(
        workspace,
        args.sessionId,
        await rerun(prompt, latest.executionId),
        () => prompt,
        rerun,
        waitedUntil,
        args.waitHooks,
      );
      printAgent({ ...result }, role, profile.provider, profile.model);
      return finishRole(args.sessionId, result.outcome_status === "complete" ? 0 : 1);
    } catch (error) {
      if (error instanceof CancellationRequested) {
        log(error.message);
        return finishRole(args.sessionId, 130);
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
  }
}

async function runCancelledRole(
  workspace: string,
  sessionId: string,
  role: string,
  profile: { provider: string; model: string; options: Record<string, string> },
  runner: AgentToolRunner,
  asJson: boolean,
  waitHooks?: WaitHooks,
): Promise<number> {
  const reopened = new SessionStore(workspace).reopenCancelledExecutions(sessionId);
  for (const item of reopened) {
    log(`session ${sessionId} was cancelled during ${item.executionId}. Resuming that execution.`);
  }
  const waitedUntil = new Map<string, string>();
  const rerun = (prompt: string, resumeId: string) =>
    runner.run({
      provider: profile.provider,
      model: profile.model,
      options: { ...profile.options },
      prompt,
      workspace,
      sessionId,
      resumeExecutionId: resumeId,
      stageId: role,
    });
  const settled = await Promise.allSettled(
    reopened.map((item) => runner.continueCancelled(workspace, sessionId, item.executionId)),
  );
  const rejected = settled.find((item) => item.status === "rejected");
  if (rejected && rejected.status === "rejected") throw rejected.reason;
  const continued = settled.flatMap((item) => (item.status === "fulfilled" ? [item.value] : []));
  if (continued.length === 0) {
    throw new ConfigurationError(`Session ${sessionId} is cancelled without an execution.`);
  }
  const finished: RunResult[] = [];
  for (const item of continued) {
    finished.push(
      await rerunQuota(
        workspace,
        sessionId,
        item,
        (current) => lastUserPrompt(workspace, sessionId, current.execution_id),
        rerun,
        waitedUntil,
        waitHooks,
      ),
    );
  }
  if (finished.length === 1) {
    const result = finished[0];
    if (result === undefined) throw new Error("Agent run produced no result.");
    if (asJson) process.stdout.write(`${JSON.stringify(result)}\n`);
    else printAgent({ ...result }, role, profile.provider, profile.model);
    return finishRole(sessionId, result.outcome_status === "complete" ? 0 : 1);
  }
  if (asJson) process.stdout.write(`${JSON.stringify(finished)}\n`);
  else {
    for (const item of finished) printAgent({ ...item }, role, profile.provider, profile.model);
  }
  if (finished.some((item) => item.failure_reason === "verify_exhausted")) return finishRole(sessionId, 6);
  return finishRole(sessionId, finished.every((item) => item.outcome_status === "complete") ? 0 : 1);
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

function finishRole(sessionId: string, code: number): number {
  if (code === 1 || code === 6 || code === 130) printResumeCommand(sessionId);
  return code;
}

function rolePrompt(workspace: string, role: string, text: string): string {
  return prependRoleInstructions(
    loadRoleInstructions(loadWorkspaceConfig(workspace), role),
    text,
  );
}

function executionProfile(
  directory: string,
  executionId: string,
): { provider: string; model: string; options: Record<string, string> } {
  const raw = JSON.parse(readFileSync(path.join(directory, "execution.json"), "utf8")) as unknown;
  if (
    !isRecord(raw) ||
    typeof raw.provider !== "string" ||
    raw.provider === "" ||
    typeof raw.model !== "string" ||
    raw.model === ""
  ) {
    throw new ConfigurationError(`Execution ${executionId} has no provider.`);
  }
  return { provider: raw.provider, model: raw.model, options: stringOptions(raw.options) };
}

function executionBlocker(directory: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(directory, "execution.json"), "utf8")) as unknown;
    if (!isRecord(raw) || !isRecord(raw.outcome)) return null;
    return typeof raw.outcome.blocker === "string" && raw.outcome.blocker !== "" ? raw.outcome.blocker : null;
  } catch {
    return null;
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
