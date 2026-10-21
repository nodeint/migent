import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants as fsConstants, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  CancellationRequested,
  PROGRESS_INTERVAL_SEC,
  cancellationSignal,
  childStatus,
  startWrapper,
  stopProcessGroup,
  waitForExit,
  waitForReady,
} from "./command-executor.js";
import { collectProcessStartInfo, type ProcessStartInfo } from "./process-ownership.js";
import { WRAPPER_START, wrapperEndpoint } from "./process-wrapper.js";

export const VERIFY_TAIL_LINES = 200;
const OUTPUT_DRAIN_MS = 1000;

export type VerifyCommandStatus = "pass" | "fail" | "timed_out" | "skipped";

export interface VerifyCommandResult {
  command: string;
  status: VerifyCommandStatus;
  /** null for skipped and timed_out. */
  exitCode: number | null;
  /** Relative to the execution directory; null for skipped. */
  log: string | null;
  /** Last lines of output; empty for pass and skipped. */
  tail: string[];
}

export interface VerifyRunResult {
  passed: boolean;
  commands: VerifyCommandResult[];
  /** Set when the shell could not be started. This is not a red verify. */
  infraError: string | null;
}

export interface VerifyRunInput {
  commands: readonly string[];
  workspace: string;
  executionDirectory: string;
  /** executions/<id>/turns/NN */
  turnDirectory: string;
  timeoutSec: number | null;
  onStart?: (info: ProcessStartInfo) => void;
  onEnd?: () => void;
  onHeartbeat?: (command: string, elapsedSec: number) => void;
}

const require = createRequire(import.meta.url);
const whichSync = (
  require("which") as { sync(command: string, options?: { nothrow?: boolean }): string | null }
).sync;

/** `/bin/sh` when it exists. On Windows, the `sh` on PATH (Git for Windows). */
export function defaultVerifyShell(): string {
  const posix = "/bin/sh";
  try {
    accessSync(posix, fsConstants.X_OK);
    return posix;
  } catch {
    // Missing here is normal on Windows.
  }
  if (process.platform === "win32") {
    const found = whichSync("sh", { nothrow: true });
    if (found) return found;
  }
  return posix;
}

export class VerifyRunner {
  readonly progressIntervalSec: number;
  readonly shell: string;

  constructor(progressIntervalSec = PROGRESS_INTERVAL_SEC, shell = defaultVerifyShell()) {
    this.progressIntervalSec = progressIntervalSec;
    this.shell = shell;
  }

  async run(input: VerifyRunInput): Promise<VerifyRunResult> {
    const startedAt = Date.now();
    const deadline = input.timeoutSec === null ? null : startedAt + input.timeoutSec * 1000;
    const commands: VerifyCommandResult[] = [];
    let stopped = false;
    for (const [index, command] of input.commands.entries()) {
      if (stopped) {
        commands.push({ command, status: "skipped", exitCode: null, log: null, tail: [] });
        continue;
      }
      const result = await this.runCommand(command, index + 1, deadline, input);
      if (result === "infra") {
        return { passed: false, commands, infraError: `Unable to start the verify shell for: ${command}` };
      }
      commands.push(result);
      if (result.status !== "pass") stopped = true;
    }
    return { passed: !stopped, commands, infraError: null };
  }

  private async runCommand(
    command: string,
    number: number,
    deadline: number | null,
    input: VerifyRunInput,
  ): Promise<VerifyCommandResult | "infra"> {
    // The wrapper reports a missing executable as exit 127, which would look like a red
    // command. A shell that cannot run is infrastructure, so check it before spawning.
    try {
      accessSync(this.shell, fsConstants.X_OK);
    } catch {
      input.onEnd?.();
      return "infra";
    }
    const cancellation = cancellationSignal();
    const endpoint = wrapperEndpoint(randomBytes(16).toString("hex"));
    // `exec 2>&1` merges stderr into stdout in arrival order.
    const child = startWrapper(
      { argv: [this.shell, "-c", `exec 2>&1; ${command}`] },
      input.workspace,
      endpoint,
      ["ignore", "pipe", "inherit", "ipc"],
    );
    try {
      const ready = await waitForReady(child);
      cancellation.throwIfCancelled();
      if (!ready) {
        await stopProcessGroup(child);
        return "infra";
      }
      if (child.pid !== undefined) input.onStart?.(collectProcessStartInfo(child.pid, endpoint));
      const output = captureOutput(child);
      child.send({ type: WRAPPER_START });
      const startedAt = Date.now();
      let timedOut = false;
      while (true) {
        let waitMs = this.progressIntervalSec * 1000;
        if (deadline !== null) {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) {
            timedOut = true;
            break;
          }
          waitMs = Math.min(waitMs, remainingMs);
        }
        const finished = await waitForExit(child, waitMs);
        if (finished === "cancel") {
          cancellation.throwIfCancelled();
          continue;
        }
        if (finished) break;
        if (deadline !== null && Date.now() >= deadline) {
          timedOut = true;
          break;
        }
        input.onHeartbeat?.(command, Math.floor((Date.now() - startedAt) / 1000));
      }
      if (timedOut) await stopProcessGroup(child);
      else await output.drain();
      child.stdout?.destroy();
      const status = childStatus(child);
      const tail = output.tail();
      const log = writeLog(input, number, tail);
      if (timedOut) {
        return { command, status: "timed_out", exitCode: null, log, tail };
      }
      if (status === 0) return { command, status: "pass", exitCode: 0, log, tail: [] };
      return { command, status: "fail", exitCode: status, log, tail };
    } catch (error) {
      if (error instanceof CancellationRequested) await stopProcessGroup(child);
      throw error;
    } finally {
      input.onEnd?.();
    }
  }
}

function captureOutput(child: ChildProcess): { tail(): string[]; drain(): Promise<void> } {
  const lines: string[] = [];
  let partial = "";
  let ended = false;
  const stream = child.stdout;
  const waiters: Array<() => void> = [];
  const push = (line: string) => {
    lines.push(line);
    if (lines.length > VERIFY_TAIL_LINES) lines.shift();
  };
  const finish = () => {
    if (ended) return;
    ended = true;
    if (partial.length > 0) push(partial);
    partial = "";
    for (const waiter of waiters.splice(0)) waiter();
  };
  if (stream) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      partial += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      let index = partial.indexOf("\n");
      while (index >= 0) {
        push(partial.slice(0, index));
        partial = partial.slice(index + 1);
        index = partial.indexOf("\n");
      }
    });
    stream.on("end", finish);
    stream.on("error", finish);
    stream.on("close", finish);
  } else {
    ended = true;
  }
  return {
    tail() {
      // A destroyed stream may still hold a partial line.
      finish();
      return [...lines];
    },
    drain() {
      if (ended) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, OUTPUT_DRAIN_MS);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

function writeLog(input: VerifyRunInput, number: number, tail: string[]): string {
  const name = `${String(number).padStart(2, "0")}.log`;
  const directory = path.join(input.turnDirectory, "commands");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  writeFileSync(file, tail.length > 0 ? `${tail.join("\n")}\n` : "", "utf8");
  return path.relative(input.executionDirectory, file).split(path.sep).join("/");
}

export interface VerifyReportInput {
  run: number;
  red: number;
  maxVerify: number;
  timeoutSec?: number | null;
}

export function formatVerifyReport(result: VerifyRunResult, input: VerifyReportInput): string {
  const lines = [
    `verify: ${result.passed ? "pass" : "fail"}`,
    `run: ${input.run}`,
    `red: ${input.red} of ${input.maxVerify}`,
    "",
    "commands:",
  ];
  for (const entry of result.commands) {
    lines.push(`- [${entry.status}] ${entry.command}`);
    if (entry.status === "timed_out") lines.push(`  timed_out: ${input.timeoutSec ?? 0}s`);
    else if (entry.exitCode !== null) lines.push(`  exit_code: ${entry.exitCode}`);
    if (entry.log !== null) lines.push(`  log: ${entry.log}`);
  }
  for (const entry of result.commands) {
    if (entry.status !== "fail" && entry.status !== "timed_out") continue;
    lines.push("", `tail of ${entry.command} (last ${VERIFY_TAIL_LINES} lines):`, "```");
    lines.push(...entry.tail, "```");
  }
  return `${lines.join("\n")}\n`;
}
