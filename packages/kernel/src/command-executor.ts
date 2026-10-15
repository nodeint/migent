import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import { constants as osConstants } from "node:os";
import { log } from "./runtime.js";
import { collectProcessStartInfo, type ProcessStartInfo, wrapperArgv } from "./process-ownership.js";
import { UnpassableArgument, assertArgumentsPassable } from "./provider-spawn.js";
import { WRAPPER_READY, WRAPPER_START, killProcessTree, wrapperEndpoint } from "./process-wrapper.js";

export const DEFAULT_TIMEOUT_SEC: number | null = null;
export const PROGRESS_INTERVAL_SEC = 30;
export const TERMINATION_GRACE_SEC = 5;

export interface CommandSpec {
  argv: string[];
  stdin?: string | null;
}

export class CancellationRequested extends Error {
  readonly signalNumber: number;

  constructor(signalNumber: number) {
    super(`Received signal ${signalNumber}.`);
    this.name = "CancellationRequested";
    this.signalNumber = signalNumber;
  }
}

let pendingCancellation: CancellationRequested | null = null;
const cancelWaiters = new Set<() => void>();

export function raiseCancellation(signalNumber: number): void {
  pendingCancellation = new CancellationRequested(signalNumber);
  for (const waiter of cancelWaiters) waiter();
  throw pendingCancellation;
}

function takeCancellation(): CancellationRequested | null {
  const error = pendingCancellation;
  pendingCancellation = null;
  return error;
}

function throwIfCancelled(): void {
  const error = takeCancellation();
  if (error) throw error;
}

export class CommandExecutor {
  readonly timeoutSec: number | null;
  readonly progressIntervalSec: number;

  constructor(
    timeoutSec: number | null = DEFAULT_TIMEOUT_SEC,
    progressIntervalSec = PROGRESS_INTERVAL_SEC,
  ) {
    this.timeoutSec = timeoutSec;
    this.progressIntervalSec = progressIntervalSec;
  }

  async run(
    spec: CommandSpec,
    cwd: string,
    onOutput?: ((line: string) => void) | null,
    onHeartbeat?: ((elapsedSec: number) => void) | null,
    onStart?: ((info: ProcessStartInfo) => void) | null,
  ): Promise<[string, string | null]> {
    let child: ChildProcess | null = null;
    try {
      assertArgumentsPassable(spec.argv[0] ?? "", spec.argv.slice(1));
    } catch (error) {
      if (error instanceof UnpassableArgument) return ["", error.message];
      throw error;
    }
    try {
      const endpoint = wrapperEndpoint(randomBytes(16).toString("hex"));
      child = startWrapper(spec, cwd, endpoint);
      const ready = await waitForReady(child);
      throwIfCancelled();
      if (!ready) {
        if (childStatus(child) === 127) {
          return ["", `CLI executable not found: ${spec.argv[0] ?? "command"}`];
        }
        await stopProcessGroup(child);
        return ["", "Provider process wrapper did not start."];
      }
      if (onStart && child.pid !== undefined) onStart(collectProcessStartInfo(child.pid, endpoint));
      child.send({ type: WRAPPER_START });
      const [stdout, error] = await this.wait(child, spec, onOutput, onHeartbeat);
      if (error !== null && childStatus(child) === 127) {
        return [stdout, `CLI executable not found: ${spec.argv[0] ?? "command"}`];
      }
      return [stdout, error];
    } catch (error) {
      if (error instanceof CancellationRequested) {
        log("Cancellation requested; stopping the sub-agent group.");
        if (child !== null) await stopProcessGroup(child);
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
  ): Promise<[string, string | null]> {
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
        if (remainingMs <= 0) return this.timeout(child);
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
    if (status === 0) return [stdout, null];
    return [stdout, `CLI exited with code ${status}.`];
  }

  private async timeout(child: ChildProcess): Promise<[string, string]> {
    await stopProcessGroup(child);
    return ["", `Sub-agent timed out after ${this.timeoutSec}s.`];
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

function waitForExit(
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

function childStatus(child: ChildProcess): number | null {
  if (typeof child.exitCode === "number") return child.exitCode;
  if (child.signalCode) {
    const signal = osConstants.signals[child.signalCode];
    if (typeof signal === "number") return -signal;
  }
  return null;
}

function startWrapper(spec: CommandSpec, cwd: string, endpoint: string): ChildProcess {
  const argv = wrapperArgv(spec.argv, { endpoint, graceSec: TERMINATION_GRACE_SEC });
  const child = spawn(argv[0] ?? "", argv.slice(1), {
    cwd,
    // POSIX: a new process group, so the whole provider tree can be signalled at once.
    // Windows: `taskkill /T` follows the tree instead, and detaching would open a new console.
    detached: process.platform !== "win32",
    stdio: [spec.stdin != null ? "pipe" : "inherit", "pipe", "inherit", "ipc"],
    windowsHide: true,
  });
  child.on("error", () => undefined);
  return child;
}

/** Resolves true once the wrapper's endpoint is listening, false if it exits first. */
function waitForReady(child: ChildProcess): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (ready: boolean) => {
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onExit);
      cancelWaiters.delete(onCancel);
      resolve(ready);
    };
    const onMessage = (message: unknown) => {
      if (message && typeof message === "object" && (message as { type?: unknown }).type === WRAPPER_READY) {
        finish(true);
      }
    };
    const onExit = () => finish(false);
    const onCancel = () => finish(false);
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onExit);
    cancelWaiters.add(onCancel);
  });
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
