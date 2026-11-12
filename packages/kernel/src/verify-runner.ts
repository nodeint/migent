import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants as fsConstants, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  CancellationRequested,
  cancellationSignal,
  childStatus,
  PROGRESS_INTERVAL_SEC,
  startWrapper,
  stopProcessGroup,
  waitForExit,
  waitForReady,
} from './command-executor.js';
import { ENDPOINT_TOKEN_BYTES, MS_PER_SECOND, PAD_WIDTH_2 } from './constants.js';
import { platformComSpec } from './env.js';
import { collectProcessStartInfo, type ProcessStartInfo } from './process-ownership.js';
import { wrapperEndpoint } from './process-wrapper.js';
import type { CommandSpec } from './wrapper-launch.js';
import { WRAPPER_START } from './wrapper-protocol.js';

export const VERIFY_TAIL_LINES = 200;
const OUTPUT_DRAIN_MS = 1000;

export type VerifyCommandStatus = 'pass' | 'fail' | 'timed_out' | 'skipped';

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

const WINDOWS_DEFAULT_COMSPEC = 'C:\\Windows\\System32\\cmd.exe';

/** The operating system's own shell: `%ComSpec%` (cmd.exe) on Windows, `/bin/sh` elsewhere. */
export function defaultVerifyShell(): string {
  if (process.platform === 'win32') return platformComSpec() ?? WINDOWS_DEFAULT_COMSPEC;
  return '/bin/sh';
}

/** The shell invocation for one command, with stderr merged into stdout in arrival order. */
export function verifyShellSpec(
  shell: string,
  command: string,
  platform: NodeJS.Platform = process.platform,
): CommandSpec {
  if (platform === 'win32') {
    // `/s /c "..."` strips only the outer quotes, so the command keeps its own syntax. Wrapping it
    // to redirect (e.g. `(...) 2>&1`) would change how cmd.exe parses it, so the wrapper merges
    // stderr at the file-descriptor level instead.
    return { argv: [shell, '/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true, mergeStderr: true };
  }
  return { argv: [shell, '-c', `exec 2>&1; ${command}`] };
}

export class VerifyRunner {
  public readonly progressIntervalSec: number;
  public readonly shell: string;

  constructor(progressIntervalSec = PROGRESS_INTERVAL_SEC, shell = defaultVerifyShell()) {
    this.progressIntervalSec = progressIntervalSec;
    this.shell = shell;
  }

  public async run(input: VerifyRunInput): Promise<VerifyRunResult> {
    const startedAt = Date.now();
    const deadline = input.timeoutSec === null ? null : startedAt + input.timeoutSec * MS_PER_SECOND;
    const commands: VerifyCommandResult[] = [];
    let stopped = false;
    for (const [index, command] of input.commands.entries()) {
      if (stopped) {
        commands.push({ command, status: 'skipped', exitCode: null, log: null, tail: [] });
        continue;
      }
      const result = await this.runCommand(command, { number: index + 1, deadline }, input);
      if (result === 'infra') {
        return { passed: false, commands, infraError: `Unable to start the verify shell for: ${command}` };
      }
      commands.push(result);
      if (result.status !== 'pass') stopped = true;
    }
    return { passed: !stopped, commands, infraError: null };
  }

  private async runCommand(
    command: string,
    step: { number: number; deadline: number | null },
    input: VerifyRunInput,
  ): Promise<VerifyCommandResult | 'infra'> {
    // The wrapper reports a missing executable as exit 127, which would look like a red
    // command. A shell that cannot run is infrastructure, so check it before spawning.
    if (!isExecutable(this.shell)) {
      input.onEnd?.();
      return 'infra';
    }
    const cancellation = cancellationSignal();
    const endpoint = wrapperEndpoint(randomBytes(ENDPOINT_TOKEN_BYTES).toString('hex'));
    const child = startWrapper(
      verifyShellSpec(this.shell, command),
      { cwd: input.workspace, endpoint, stdio: ['ignore', 'pipe', 'inherit', 'ipc'] },
    );
    try {
      const started = await waitForReady(child);
      cancellation.throwIfCancelled();
      if (started.kind !== 'ready') {
        await stopProcessGroup(child);
        return 'infra';
      }
      if (child.pid !== undefined) input.onStart?.(collectProcessStartInfo(child.pid, endpoint));
      return await this.runStarted(child, { command, ...step }, input);
    } catch (error) {
      if (error instanceof CancellationRequested) await stopProcessGroup(child);
      throw error;
    } finally {
      input.onEnd?.();
    }
  }

  /** Starts a ready command, waits for it, and records its result. */
  private async runStarted(
    child: ChildProcess,
    step: { command: string; number: number; deadline: number | null },
    input: VerifyRunInput,
  ): Promise<VerifyCommandResult> {
    const { command, number, deadline } = step;
    const output = captureOutput(child);
    child.send({ type: WRAPPER_START });
    const timedOut = await this.awaitExit(child, { command, deadline }, input);
    if (timedOut) await stopProcessGroup(child);
    else await output.drain();
    child.stdout?.destroy();
    const status = timedOut ? 'timed_out' : childStatus(child);
    return commandResult(command, { status, tail: output.tail() }, (tail) => writeLog(input, number, tail));
  }

  /** Waits for the command to exit; resolves true when the deadline passed first. */
  private async awaitExit(
    child: ChildProcess,
    step: { command: string; deadline: number | null },
    input: VerifyRunInput,
  ): Promise<boolean> {
    const { command, deadline } = step;
    const startedAt = Date.now();
    while (true) {
      const waitMs = remainingWaitMs(this.progressIntervalSec * MS_PER_SECOND, deadline);
      if (waitMs <= 0) return true;
      const finished = await waitForExit(child, waitMs);
      if (finished === 'cancel') {
        cancellationSignal().throwIfCancelled();
        continue;
      }
      if (finished) return false;
      if (deadline !== null && Date.now() >= deadline) return true;
      input.onHeartbeat?.(command, Math.floor((Date.now() - startedAt) / MS_PER_SECOND));
    }
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The next wait slice, capped by the deadline; zero or less means the deadline passed. */
function remainingWaitMs(intervalMs: number, deadline: number | null): number {
  if (deadline === null) return intervalMs;
  const remainingMs = deadline - Date.now();
  return remainingMs <= 0 ? 0 : Math.min(intervalMs, remainingMs);
}

function commandResult(
  command: string,
  outcome: { status: 'timed_out' | number | null; tail: string[] },
  log: (tail: string[]) => ReturnType<typeof writeLog>,
): VerifyCommandResult {
  const { status, tail } = outcome;
  const logPath = log(tail);
  if (status === 'timed_out') return { command, status: 'timed_out', exitCode: null, log: logPath, tail };
  if (status === 0) return { command, status: 'pass', exitCode: 0, log: logPath, tail: [] };
  return { command, status: 'fail', exitCode: status, log: logPath, tail };
}

function captureOutput(child: ChildProcess): { tail(): string[]; drain(): Promise<void> } {
  const lines: string[] = [];
  let partial = '';
  let ended = false;
  const stream = child.stdout;
  const waiters: (() => void)[] = [];
  const push = (line: string) => {
    lines.push(line);
    if (lines.length > VERIFY_TAIL_LINES) lines.shift();
  };
  const finish = () => {
    if (ended) return;
    ended = true;
    if (partial.length > 0) push(partial);
    partial = '';
    for (const waiter of waiters.splice(0)) waiter();
  };
  if (stream) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      partial += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let index = partial.indexOf('\n');
      while (index >= 0) {
        push(partial.slice(0, index));
        partial = partial.slice(index + 1);
        index = partial.indexOf('\n');
      }
    });
    stream.on('end', finish);
    stream.on('error', finish);
    stream.on('close', finish);
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
  const name = `${String(number).padStart(PAD_WIDTH_2, '0')}.log`;
  const directory = path.join(input.turnDirectory, 'commands');
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  writeFileSync(file, tail.length > 0 ? `${tail.join('\n')}\n` : '', 'utf8');
  return path.relative(input.executionDirectory, file).split(path.sep).join('/');
}

export interface VerifyReportInput {
  run: number;
  red: number;
  maxVerify: number;
  timeoutSec?: number | null;
}

export function formatVerifyReport(result: VerifyRunResult, input: VerifyReportInput): string {
  const lines = [
    `verify: ${result.passed ? 'pass' : 'fail'}`,
    `run: ${input.run}`,
    `red: ${input.red} of ${input.maxVerify}`,
    '',
    'commands:',
  ];
  for (const entry of result.commands) {
    lines.push(`- [${entry.status}] ${entry.command}`);
    if (entry.status === 'timed_out') lines.push(`  timed_out: ${input.timeoutSec ?? 0}s`);
    else if (entry.exitCode !== null) lines.push(`  exit_code: ${entry.exitCode}`);
    if (entry.log !== null) lines.push(`  log: ${entry.log}`);
  }
  for (const entry of result.commands) {
    if (entry.status !== 'fail' && entry.status !== 'timed_out') continue;
    lines.push('', `tail of ${entry.command} (last ${VERIFY_TAIL_LINES} lines):`, '```');
    lines.push(...entry.tail, '```');
  }
  return `${lines.join('\n')}\n`;
}
