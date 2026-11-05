import { type ChildProcess, type StdioOptions, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { constants as osConstants } from "node:os";
import { log } from "./runtime.js";
import { collectProcessStartInfo, type ProcessStartInfo, wrapperArgv } from "./process-ownership.js";
import { UnpassableArgument, assertArgumentsPassable } from "./provider-spawn.js";
import { killProcessTree, wrapperEndpoint } from "./process-wrapper.js";
import { TailBuffer } from "./tail-buffer.js";
import {
  UNPASSABLE_ARGUMENT_CODE,
  WRAPPER_READY,
  WRAPPER_START,
  type StartFailure,
  type StartResult,
  type WrapperFailedMessage,
  parseFailedMessage,
} from "./wrapper-protocol.js";

export type { StartFailure, StartResult } from "./wrapper-protocol.js";

export const DEFAULT_TIMEOUT_SEC: number | null = null;
export const PROGRESS_INTERVAL_SEC = 30;
export const TERMINATION_GRACE_SEC = 5;
/** How long a client may exit by itself after its server-side turn was interrupted. */
export const INTERRUPT_EXIT_GRACE_MS = 3000;

export interface CommandSpec {
  argv: string[];
  stdin?: string | null;
}

/** A wrapper-level failure of one provider turn, for the caller to record. */
export interface ExecutionFailure {
  kind: "start" | "provider-exit";
  /** The typed handshake outcome for `start`; the wrapper's own report after start, if any. */
  result: StartFailure | null;
  phase: string | null;
  code: string | null;
  errno: number | null;
  syscall: string | null;
  path: string | null;
  message: string;
  stderrTail: string;
  endpoint: string;
  executable: string;
  argCount: number;
  cwd: string;
  spawnedAt: string;
  failedAt: string;
}

export interface CommandResult {
  stdout: string;
  error: string | null;
  exitCode: number | null;
  failure?: ExecutionFailure;
}

export interface RunOptions {
  onOutput?: ((line: string) => void) | null;
  onHeartbeat?: ((elapsedSec: number) => void) | null;
  onStart?: ((info: ProcessStartInfo) => void) | null;
  /** Receives timestamped trace steps when set (see `MIGENT_DEBUG`). */
  onDebug?: ((step: string, fromWrapper?: boolean) => void) | null;
  /**
   * Awaited before the process group is stopped on cancellation or timeout, so a provider whose
   * turn runs in a server can stop it first. The callback bounds its own time and must not throw.
   */
  onInterrupt?: ((reason: StopReason) => Promise<void | boolean>) | null;
  /** Awaited after the process group is stopped, for a last check of what the interrupt could not settle. */
  onStopped?: ((reason: StopReason) => Promise<void | boolean>) | null;
}

export type StopReason = "cancel" | "timeout";

/** Runs a hook; true unless it reports (by returning false) that it did nothing. */
async function notify(hook: ((reason: StopReason) => Promise<void | boolean>) | null | undefined, reason: StopReason): Promise<boolean> {
  if (!hook) return false;
  try {
    return (await hook(reason)) !== false;
  } catch (error) {
    log(`Provider cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
}

export class CancellationRequested extends Error {
  readonly signalNumber: number;

  constructor(signalNumber: number) {
    super(`Received signal ${signalNumber}.`);
    this.name = "CancellationRequested";
    this.signalNumber = signalNumber;
  }
}

// Stays set so every in-flight command observes the same signal.
let cancelled: CancellationRequested | null = null;
const cancelWaiters = new Set<() => void>();

export function raiseCancellation(signalNumber: number): void {
  cancelled = new CancellationRequested(signalNumber);
  for (const waiter of cancelWaiters) waiter();
  throw cancelled;
}

export function resetCancellation(): void {
  cancelled = null;
}

export interface WaitHooks {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WaitHandle {
  promise: Promise<"reached" | "replaced">;
  replace(retryAt: string): void;
}

/** Sleep in slices until `retryAt`, or until `replace` moves the instant. */
export function waitUntil(retryAt: string, hooks: WaitHooks = {}): WaitHandle {
  const now = hooks.now ?? Date.now;
  const sleep = hooks.sleep ?? defaultWaitSleep;
  let current = retryAt;
  let replaced = false;
  let wake: (() => void) | null = null;
  const promise = (async (): Promise<"reached" | "replaced"> => {
    while (!replaced) {
      cancellationSignal().throwIfCancelled();
      const target = Date.parse(current);
      if (!Number.isFinite(target) || now() >= target) return "reached";
      const delay = Math.min(PROGRESS_INTERVAL_SEC * 1000, Math.max(0, target - now()));
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          unbind();
          wake = null;
          if (error) reject(error);
          else resolve();
        };
        const unbind = cancellationSignal().onCancel(() => {
          try {
            cancellationSignal().throwIfCancelled();
            finish();
          } catch (error) {
            finish(error);
          }
        });
        wake = () => finish();
        sleep(delay).then(
          () => finish(),
          (error: unknown) => finish(error),
        );
      });
    }
    return "replaced";
  })();
  return {
    promise,
    replace(next: string) {
      current = next;
      replaced = true;
      const pending = wake;
      wake = null;
      pending?.();
    },
  };
}

function defaultWaitSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

export function cancellationSignal(): {
  throwIfCancelled(): void;
  onCancel(waiter: () => void): () => void;
} {
  return {
    throwIfCancelled,
    onCancel(waiter) {
      cancelWaiters.add(waiter);
      return () => {
        cancelWaiters.delete(waiter);
      };
    },
  };
}

function throwIfCancelled(): void {
  if (cancelled) throw cancelled;
}

export class CommandExecutor {
  readonly timeoutSec: number | null;
  readonly progressIntervalSec: number;
  interruptExitGraceMs = INTERRUPT_EXIT_GRACE_MS;

  constructor(
    timeoutSec: number | null = DEFAULT_TIMEOUT_SEC,
    progressIntervalSec = PROGRESS_INTERVAL_SEC,
  ) {
    this.timeoutSec = timeoutSec;
    this.progressIntervalSec = progressIntervalSec;
  }

  /** After an interrupt ran: let the client exit by itself for a bounded time; the caller forces the rest. */
  private async interrupt(child: ChildProcess, options: RunOptions, reason: StopReason): Promise<void> {
    if (!options.onInterrupt) return;
    // No grace when the hook had nothing to interrupt: the client is the only thing left to stop.
    if (await notify(options.onInterrupt, reason)) await waitForExit(child, this.interruptExitGraceMs);
  }

  async run(spec: CommandSpec, cwd: string, options: RunOptions = {}): Promise<CommandResult> {
    const { onOutput, onHeartbeat, onStart, onDebug } = options;
    const executable = spec.argv[0] ?? "command";
    let child: ChildProcess | null = null;
    // True once the provider was told to start; before that no server-side turn can exist.
    let launched = false;
    try {
      assertArgumentsPassable(spec.argv[0] ?? "", spec.argv.slice(1));
    } catch (error) {
      if (error instanceof UnpassableArgument) return { stdout: "", error: error.message, exitCode: null };
      throw error;
    }
    try {
      const endpoint = wrapperEndpoint(randomBytes(16).toString("hex"));
      onDebug?.(`endpoint ${endpoint} (length ${Buffer.byteLength(endpoint)})`);
      const spawnedAt = new Date().toISOString();
      child = startWrapper(spec, cwd, endpoint);
      onDebug?.(`wrapper spawned pid=${child.pid ?? "none"}`);
      if (onDebug) forwardWrapperSteps(child, onDebug);
      const started = await waitForReady(child);
      const describe = (result: StartFailure, kind: ExecutionFailure["kind"]): ExecutionFailure => {
        const stderrTail = stderrTailOf(child as ChildProcess);
        const detail = result.kind === "wrapper-reported" || result.kind === "spawn-error" ? result : null;
        return {
          kind,
          result,
          phase: result.kind === "wrapper-reported" ? result.phase : null,
          code: detail?.code ?? null,
          errno: detail?.errno ?? null,
          syscall: detail?.syscall ?? null,
          path: detail?.path ?? null,
          message: describeStartFailure(result, { command: executable, stderrTail }),
          stderrTail,
          endpoint,
          executable,
          argCount: Math.max(0, spec.argv.length - 1),
          cwd,
          spawnedAt,
          failedAt: new Date().toISOString(),
        };
      };
      if (started.kind === "cancelled") throwIfCancelled();
      if (started.kind !== "ready" && started.kind !== "cancelled") {
        onDebug?.(`wrapper failed: ${started.kind}`);
        const failure = describe(started, "start");
        await stopProcessGroup(child);
        // A cancel that lands before this point must never be persisted as a startup failure.
        throwIfCancelled();
        return { stdout: "", error: failure.message, exitCode: null, failure };
      }
      onDebug?.("wrapper ready");
      if (onStart && child.pid !== undefined) onStart(collectProcessStartInfo(child.pid, endpoint));
      let reported: WrapperFailedMessage | null = null;
      child.on("message", (message: unknown) => {
        reported = parseFailedMessage(message) ?? reported;
      });
      child.send({ type: WRAPPER_START });
      launched = true;
      onDebug?.("start sent");
      const [stdout, error, exitCode] = await this.wait(child, spec, onOutput, onHeartbeat, options);
      onDebug?.(`provider exit code=${exitCode} error=${error ?? "none"}`);
      if (error !== null) {
        await channelDrained(child);
        // A cancel that lands while the pipes drain must not be persisted as a failure.
        throwIfCancelled();
      }
      const wrapperReport = reported as WrapperFailedMessage | null;
      if (wrapperReport !== null && error !== null) {
        const result: StartFailure = { kind: "wrapper-reported", ...stripType(wrapperReport) };
        const failure = describe(result, "start");
        return { stdout, error: failure.message, exitCode: null, failure };
      }
      if (error !== null && exitCode !== null && exitCode !== 0) {
        const tail = stderrTailOf(child);
        if (tail.trim().length > 0) {
          const failure = describe({ kind: "exited", code: exitCode, signal: null }, "provider-exit");
          failure.message = error;
          return { stdout, error, exitCode, failure };
        }
      }
      return { stdout, error, exitCode };
    } catch (error) {
      if (error instanceof CancellationRequested) {
        log("Cancellation requested; stopping the sub-agent group.");
        if (child !== null) {
          if (launched) await this.interrupt(child, options, "cancel");
          await stopProcessGroup(child);
          if (launched) await notify(options.onStopped, "cancel");
        }
        log("Sub-agent group stopped.");
      }
      throw error;
    }
  }

  private async wait(
    child: ChildProcess,
    spec: CommandSpec,
    onOutput?: ((line: string) => void) | null,
    onHeartbeat?: ((elapsedSec: number) => void) | null,
    hooks: RunOptions = {},
  ): Promise<[string, string | null, number | null]> {
    const startedAt = Date.now();
    const queue = createLineQueue(child.stdout ?? null);
    if (spec.stdin != null && child.stdin) {
      child.stdin.write(spec.stdin);
      child.stdin.end();
    }
    const stdoutChunks: string[] = [];
    let outputClosed = false;
    while (true) {
      throwIfCancelled();
      let waitMs = this.progressIntervalSec * 1000;
      if (this.timeoutSec !== null) {
        const remainingMs = this.timeoutSec * 1000 - (Date.now() - startedAt);
        if (remainingMs <= 0) return this.timeout(child, hooks);
        waitMs = Math.min(waitMs, remainingMs);
      }
      let line: string | null | "timeout";
      if (outputClosed) {
        const finished = await waitForExit(child, waitMs);
        if (finished === "cancel") throwIfCancelled();
        if (finished === true) break;
        line = null;
      } else {
        line = await queue.get(waitMs);
        if (line === "cancel") throwIfCancelled();
      }
      if (line === "timeout") {
        const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
        if (onHeartbeat) onHeartbeat(elapsedSec);
        continue;
      }
      if (line === null) {
        outputClosed = true;
        continue;
      }
      stdoutChunks.push(line);
      if (onOutput) onOutput(line.replace(/[\r\n]+$/g, ""));
    }
    if (child.stdout) child.stdout.destroy();
    const stdout = stdoutChunks.join("").trim();
    const status = childStatus(child);
    if (status === 0) return [stdout, null, 0];
    if (status === null) return [stdout, "CLI exited with code null.", null];
    return [stdout, `CLI exited with code ${status}.`, status];
  }

  private async timeout(child: ChildProcess, hooks: RunOptions): Promise<[string, string, null]> {
    await this.interrupt(child, hooks, "timeout");
    await stopProcessGroup(child);
    await notify(hooks.onStopped, "timeout");
    return ["", `Sub-agent timed out after ${this.timeoutSec}s.`, null];
  }
}

function createLineQueue(stream: Readable | null): {
  get(timeoutMs: number): Promise<string | null | "timeout" | "cancel">;
} {
  const lines: Array<string | null> = [];
  let waiter: ((value: string | null | "timeout" | "cancel") => void) | null = null;
  if (stream) {
    stream.setEncoding("utf8");
    let buffer = "";
    const push = (line: string | null) => {
      if (waiter) {
        const pending = waiter;
        waiter = null;
        pending(line);
      } else {
        lines.push(line);
      }
    };
    stream.on("data", (chunk: string) => {
      buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        push(buffer.slice(0, index + 1));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    });
    const finish = () => {
      if (buffer.length > 0) {
        push(buffer);
        buffer = "";
      }
      push(null);
    };
    stream.on("end", finish);
    stream.on("error", () => {
      finish();
    });
  } else {
    lines.push(null);
  }
  return {
    get(timeoutMs: number) {
      const queued = lines.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiter = null;
          cancelWaiters.delete(wake);
          resolve("timeout");
        }, timeoutMs);
        const wake = () => {
          clearTimeout(timer);
          waiter = null;
          cancelWaiters.delete(wake);
          resolve("cancel");
        };
        cancelWaiters.add(wake);
        waiter = (value) => {
          clearTimeout(timer);
          cancelWaiters.delete(wake);
          resolve(value);
        };
      });
    },
  };
}

export function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean | "cancel"> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      cancelWaiters.delete(wake);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      cancelWaiters.delete(wake);
      resolve(true);
    };
    const wake = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      cancelWaiters.delete(wake);
      resolve("cancel");
    };
    cancelWaiters.add(wake);
    child.once("exit", onExit);
  });
}

export function childStatus(child: ChildProcess): number | null {
  if (typeof child.exitCode === "number") return child.exitCode;
  if (child.signalCode) {
    const signal = osConstants.signals[child.signalCode];
    if (typeof signal === "number") return -signal;
  }
  return null;
}

let stderrGuarded = false;

/** Mirror wrapper stderr to ours. A closed pipe emits `error` asynchronously; swallow it and keep draining. */
function forwardToOwnerStderr(chunk: Buffer): void {
  if (!stderrGuarded) {
    stderrGuarded = true;
    process.stderr.on("error", () => undefined);
  }
  if (process.stderr.destroyed || process.stderr.writableEnded) return;
  try {
    process.stderr.write(chunk);
  } catch {
    // the owner's stderr is gone
  }
}

interface WrapperDiagnostics {
  spawnError: NodeJS.ErrnoException | null;
  stderr: TailBuffer;
}

const diagnostics = new WeakMap<ChildProcess, WrapperDiagnostics>();

/** The last stderr the wrapper (and the provider, which shares its fd 2) wrote. */
export function stderrTailOf(child: ChildProcess): string {
  return diagnostics.get(child)?.stderr.toString() ?? "";
}

export function startWrapper(
  spec: CommandSpec,
  cwd: string,
  endpoint: string,
  stdio: StdioOptions = [spec.stdin != null ? "pipe" : "inherit", "pipe", "pipe", "ipc"],
): ChildProcess {
  const argv = wrapperArgv(spec.argv, { endpoint, graceSec: TERMINATION_GRACE_SEC });
  const child = spawn(argv[0] ?? "", argv.slice(1), {
    cwd,
    // POSIX: a new process group, so the whole provider tree can be signalled at once.
    // Windows: `taskkill /T` follows the tree instead, and detaching would open a new console.
    detached: process.platform !== "win32",
    stdio,
    windowsHide: true,
  });
  const record: WrapperDiagnostics = { spawnError: null, stderr: new TailBuffer() };
  diagnostics.set(child, record);
  child.on("error", (error: NodeJS.ErrnoException) => {
    record.spawnError = error;
  });
  // Tee for the whole life of the child, so a full pipe can never block the provider.
  const stderr = child.stderr;
  if (stderr) {
    stderr.on("data", (chunk: Buffer) => {
      record.stderr.append(chunk);
      forwardToOwnerStderr(chunk);
    });
    stderr.on("error", () => undefined);
  }
  return child;
}

export const SIGNAL_SETTLE_MS = 300;
const EXIT_DRAIN_MS = 200;

export interface WaitForReadyOptions {
  /** How long a signal-like exit stays a candidate while cancellation may still arrive. */
  settleMs?: number;
}

function signalLike(code: number | null, signal: string | null): boolean {
  return signal !== null || (code !== null && code > 128 && code <= 128 + 64);
}

/**
 * Resolves the start handshake. A non-ready observation is only a candidate: it becomes the
 * result once settled, and a cancellation raised before that wins (`cancelled`).
 */
export function waitForReady(child: ChildProcess, options: WaitForReadyOptions = {}): Promise<StartResult> {
  const settleMs = options.settleMs ?? SIGNAL_SETTLE_MS;
  return new Promise((resolve) => {
    let candidate: StartFailure | null = null;
    let timer: NodeJS.Timeout | null = null;
    let done = false;
    const finish = (result: StartResult) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("close", onClose);
      child.off("error", onError);
      cancelWaiters.delete(onCancel);
      resolve(result);
    };
    const settle = (next: StartFailure, delayMs: number) => {
      candidate = next;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // The flag can be set with no waiter call left (callback order is not guaranteed).
        finish(cancelled !== null ? { kind: "cancelled" } : (candidate as StartFailure));
      }, delayMs);
    };
    const onMessage = (message: unknown) => {
      if (done) return;
      if (message && typeof message === "object" && (message as { type?: unknown }).type === WRAPPER_READY) {
        finish({ kind: "ready" });
        return;
      }
      const failed = parseFailedMessage(message);
      if (failed !== null) {
        const { type: _type, ...rest } = failed;
        settle({ kind: "wrapper-reported", ...rest }, 0);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return;
      // A wrapper-reported failure already explains this exit.
      if (candidate?.kind === "wrapper-reported") return;
      const next: StartFailure = { kind: "exited", code, signal };
      // Plain exits wait for the pipes to close so stderr and a `failed` message can land.
      settle(next, signalLike(code, signal) ? settleMs : EXIT_DRAIN_MS);
    };
    const onClose = () => {
      if (done || candidate === null) return;
      if (candidate.kind === "exited" && signalLike(candidate.code, candidate.signal)) return;
      settle(candidate, 0);
    };
    const onError = (error: NodeJS.ErrnoException) => {
      const { message, code, errno, syscall, path } = error;
      settle({ kind: "spawn-error", message, code, errno, syscall, path }, 0);
    };
    const onCancel = () => finish({ kind: "cancelled" });
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("close", onClose);
    child.once("error", onError);
    cancelWaiters.add(onCancel);
    // Events that fired before this listener was attached.
    const early = diagnostics.get(child)?.spawnError;
    if (early) onError(early);
    else if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
  });
}

function stripType(message: WrapperFailedMessage): Omit<WrapperFailedMessage, "type"> {
  const { type: _type, ...rest } = message;
  return rest;
}

/** Waits (bounded) for a finished child's pipes to close, so late stderr and IPC are seen. */
function channelDrained(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, EXIT_DRAIN_MS);
    function done() {
      clearTimeout(timer);
      child.off("close", done);
      resolve();
    }
    child.once("close", done);
  });
}

const WRAPPER_STEP_PREFIX = "[migent-wrapper] ";

const MAX_STEP_LINE_CHARS = 4096;

/**
 * Splits a stream into wrapper trace lines. Memory stays bounded: a line that does not start
 * with the wrapper prefix, or grows past the limit, is dropped up to its next newline.
 */
export function createWrapperStepParser(onStep: (step: string) => void): (chunk: string) => void {
  let partial = "";
  let discarding = false;
  return (chunk) => {
    let rest = chunk;
    while (rest.length > 0) {
      const newline = rest.indexOf("\n");
      const piece = newline === -1 ? rest : rest.slice(0, newline);
      rest = newline === -1 ? "" : rest.slice(newline + 1);
      if (!discarding) {
        partial += piece;
        const prefixLength = Math.min(partial.length, WRAPPER_STEP_PREFIX.length);
        if (partial.slice(0, prefixLength) !== WRAPPER_STEP_PREFIX.slice(0, prefixLength) || partial.length > MAX_STEP_LINE_CHARS) {
          discarding = true;
          partial = "";
        }
      }
      if (newline === -1) continue;
      if (!discarding && partial.startsWith(WRAPPER_STEP_PREFIX)) {
        onStep(partial.slice(WRAPPER_STEP_PREFIX.length).replace(/\r$/, "").replace(/^\S+Z /, ""));
      }
      partial = "";
      discarding = false;
    }
  };
}

/** Hands the wrapper's own `[migent-wrapper]` trace lines to the debug sink as they arrive. */
function forwardWrapperSteps(child: ChildProcess, onDebug: (step: string, fromWrapper?: boolean) => void): void {
  const parse = createWrapperStepParser((step) => onDebug(step, true));
  const stderr = child.stderr;
  if (!stderr) return;
  const decoder = new StringDecoder("utf8");
  stderr.on("data", (chunk: Buffer) => parse(decoder.write(chunk)));
}

const STDERR_EXCERPT_LINES = 3;

function stderrExcerpt(stderrTail: string): string {
  const lines = stderrTail.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  return lines.slice(-STDERR_EXCERPT_LINES).join(" | ");
}

/** The user-facing message for a failed start. Pure. */
export function describeStartFailure(
  failure: StartFailure,
  context: { command: string; stderrTail?: string },
): string {
  const excerpt = stderrExcerpt(context.stderrTail ?? "");
  const withExcerpt = (text: string) => (excerpt ? `${text} stderr: ${excerpt}` : text);
  switch (failure.kind) {
    case "spawn-error": {
      const where = failure.path ?? "node";
      const cause = [failure.code, failure.syscall ? `(${failure.syscall})` : null].filter(Boolean).join(" ");
      return `Could not launch ${where}: ${cause ? `${cause} ` : ""}${failure.message}`.trim();
    }
    case "exited": {
      const how = failure.signal ? `signal ${failure.signal}` : `code ${failure.code ?? "null"}`;
      return withExcerpt(`Provider process wrapper exited before it was ready (${how}).`);
    }
    case "wrapper-reported": {
      if (failure.phase === "spawn") {
        if (failure.code === "ENOENT") return `CLI executable not found: ${context.command}`;
        if (failure.code === UNPASSABLE_ARGUMENT_CODE) return failure.message;
        if (failure.code) {
          const syscall = failure.syscall ? ` (${failure.syscall})` : "";
          return `Provider CLI could not be started: ${context.command}: ${failure.code}${syscall} ${failure.message}`;
        }
      }
      const early = failure.phase === "argv" || failure.phase === "ipc" || failure.phase === "listen";
      const head = early ? "Provider wrapper failed to start" : "Provider wrapper failed";
      return withExcerpt(`${head} (${failure.phase}): ${failure.message}`);
    }
  }
}

export async function stopProcessGroup(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  try {
    killProcessTree(child.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  // The wrapper exits with the provider, but other group members may outlive both.
  const deadline = Date.now() + TERMINATION_GRACE_SEC * 1000;
  await waitForExit(child, TERMINATION_GRACE_SEC * 1000);
  while (processGroupAlive(child.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (processGroupAlive(child.pid) || (child.exitCode === null && child.signalCode === null)) {
    try {
      killProcessTree(child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await waitForExit(child, 1000);
  }
  child.stdout?.destroy();
}

function processGroupAlive(pgid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
