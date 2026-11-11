import { type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as osConstants } from 'node:os';
import type { Readable } from 'node:stream';

import { ENDPOINT_TOKEN_BYTES, MS_PER_SECOND, TERMINATION_POLL_MS } from './constants.js';
import { collectProcessStartInfo, type ProcessStartInfo } from './process-ownership.js';
import { killProcessTree, wrapperEndpoint } from './process-wrapper.js';
import { assertArgumentsPassable,UnpassableArgument } from './provider-spawn.js';
import { log } from './runtime.js';
import {
  type CommandSpec,
  describeStartFailure,
  drainStdio,
  forwardWrapperSteps,
  startWrapper,
  type StderrDrain,
  stderrDrainOf,
  stderrTailOf,
  stderrTotalOf,
  stripType,
  TERMINATION_GRACE_SEC,
  waitForReady as awaitReady,
  type WaitForReadyOptions,
} from './wrapper-launch.js';
import {
  parseExitedSignal,
  parseFailedMessage,
  type StartFailure,
  type StartResult,
  WRAPPER_START,
  type WrapperFailedMessage,
} from './wrapper-protocol.js';

export type { CommandSpec } from './wrapper-launch.js';
export { createWrapperStepParser, describeStartFailure, startWrapper, TERMINATION_GRACE_SEC } from './wrapper-launch.js';
export type { StartFailure, StartResult } from './wrapper-protocol.js';

export const DEFAULT_TIMEOUT_SEC: number | null = null;
export const PROGRESS_INTERVAL_SEC = 30;
/** How long a client may exit by itself after its server-side turn was interrupted. */
export const INTERRUPT_EXIT_GRACE_MS = 3000;

/** A wrapper-level failure of one provider turn, for the caller to record. */
export interface ExecutionFailure {
  kind: 'start' | 'provider-exit';
  /** The typed handshake outcome for `start`; the wrapper's own report after start, if any. */
  result: StartFailure | null;
  phase: string | null;
  code: string | null;
  errno: number | null;
  syscall: string | null;
  path: string | null;
  message: string;
  stderrTail: string;
  /** Exit code of the provider process, or null when it never produced one. */
  exitCode: number | null;
  /** Terminating signal, or null. */
  signal: string | null;
  /** All stderr bytes observed, kept or not. */
  stderrTotalBytes: number;
  /** `closed`: every pipe had closed when stderr was read. `grace-expired`: the bounded wait ended first. */
  drain: StderrDrain;
  endpoint: string;
  executable: string;
  argCount: number;
  cwd: string;
  spawnedAt: string;
  failedAt: string;
}

/** What the process did, observed by the executor. No stdout semantics: only sizes as received. */
export interface ProcessFacts {
  exitCode: number | null;
  signal: string | null;
  stderrTail: string;
  stderrTotalBytes: number;
  drain: StderrDrain;
  /** Raw stdout bytes and lines as received, before any trimming. */
  stdoutBytes: number;
  stdoutLines: number;
  endpoint: string;
  executable: string;
  argCount: number;
  cwd: string;
  spawnedAt: string;
  endedAt: string;
}

export interface CommandResult {
  stdout: string;
  error: string | null;
  exitCode: number | null;
  failure?: ExecutionFailure;
  /** Present when the process ran to its own end (not on a start failure, timeout or cancellation). */
  process?: ProcessFacts;
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

export type StopReason = 'cancel' | 'timeout';

/** Runs a hook; true unless it reports (by returning false) that it did nothing. */
async function notify(
  hook: ((reason: StopReason) => Promise<void | boolean>) | null | undefined,
  reason: StopReason,
): Promise<boolean> {
  if (!hook) return false;
  try {
    return (await hook(reason)) !== false;
  } catch (error) {
    log(`Provider cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
}

export class CancellationRequested extends Error {
  public readonly signalNumber: number;

  constructor(signalNumber: number) {
    super(`Received signal ${signalNumber}.`);
    this.name = 'CancellationRequested';
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

/** Resolves the start handshake against the module cancellation state. */
export function waitForReady(child: ChildProcess, options: WaitForReadyOptions = {}): Promise<StartResult> {
  return awaitReady(child, options, cancellationSignal());
}

/** The result for an argv the platform cannot pass to the provider, or null when it can. */
function unpassableArguments(spec: CommandSpec): CommandResult | null {
  try {
    assertArgumentsPassable(spec.argv[0] ?? '', spec.argv.slice(1));
  } catch (error) {
    if (error instanceof UnpassableArgument) return { stdout: '', error: error.message, exitCode: null };
    throw error;
  }
  return null;
}

/** What every failure and fact record repeats about one launched wrapper. */
interface LaunchContext {
  endpoint: string;
  executable: string;
  argCount: number;
  cwd: string;
  spawnedAt: string;
}

/** Builds the persisted failure record; process facts default to the child's current stderr drain. */
function describeExecutionFailure(
  child: ChildProcess,
  launch: LaunchContext,
  failed: {
    result: StartFailure;
    kind: ExecutionFailure['kind'];
    process?: { exitCode: number | null; signal: string | null; drain: StderrDrain } | undefined;
  },
): ExecutionFailure {
  const { result, kind } = failed;
  const process = failed.process ?? { exitCode: null, signal: null, drain: stderrDrainOf(child) };
  const stderrTail = stderrTailOf(child);
  const detail = result.kind === 'wrapper-reported' || result.kind === 'spawn-error' ? result : null;
  return {
    kind,
    result,
    phase: result.kind === 'wrapper-reported' ? result.phase : null,
    code: detail?.code ?? null,
    errno: detail?.errno ?? null,
    syscall: detail?.syscall ?? null,
    path: detail?.path ?? null,
    message: describeStartFailure(result, { command: launch.executable, stderrTail }),
    stderrTail,
    exitCode: process.exitCode,
    signal: process.signal,
    stderrTotalBytes: stderrTotalOf(child),
    drain: process.drain,
    endpoint: launch.endpoint,
    executable: launch.executable,
    argCount: launch.argCount,
    cwd: launch.cwd,
    spawnedAt: launch.spawnedAt,
    failedAt: new Date().toISOString(),
  };
}

/** The facts recorded about a provider process that ran to its end. */
function processFactsOf(
  child: ChildProcess,
  launch: LaunchContext,
  ended: {
    exitCode: number | null;
    signal: string | null;
    drain: StderrDrain;
    streamStats: { bytes: number; lines: number };
  },
): ProcessFacts {
  return {
    exitCode: ended.exitCode,
    signal: ended.signal,
    stderrTail: stderrTailOf(child),
    stderrTotalBytes: stderrTotalOf(child),
    drain: ended.drain,
    stdoutBytes: ended.streamStats.bytes,
    stdoutLines: ended.streamStats.lines,
    endpoint: launch.endpoint,
    executable: launch.executable,
    argCount: launch.argCount,
    cwd: launch.cwd,
    spawnedAt: launch.spawnedAt,
    endedAt: new Date().toISOString(),
  };
}

export class CommandExecutor {
  public readonly timeoutSec: number | null;
  public readonly progressIntervalSec: number;
  public interruptExitGraceMs = INTERRUPT_EXIT_GRACE_MS;

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

  /** Stops the sub-agent group for a cancel; the provider hooks run only once it was told to start. */
  private async stopOnCancel(child: ChildProcess | null, options: RunOptions, launched: boolean): Promise<void> {
    log('Cancellation requested; stopping the sub-agent group.');
    if (child !== null) {
      if (launched) await this.interrupt(child, options, 'cancel');
      await stopProcessGroup(child);
      if (launched) await notify(options.onStopped, 'cancel');
    }
    log('Sub-agent group stopped.');
  }

  public async run(spec: CommandSpec, cwd: string, options: RunOptions = {}): Promise<CommandResult> {
    const { onStart, onDebug } = options;
    const executable = spec.argv[0] ?? 'command';
    let child: ChildProcess | null = null;
    // True once the provider was told to start; before that no server-side turn can exist.
    let launched = false;
    const unpassable = unpassableArguments(spec);
    if (unpassable !== null) return unpassable;
    try {
      const endpoint = wrapperEndpoint(randomBytes(ENDPOINT_TOKEN_BYTES).toString('hex'));
      onDebug?.(`endpoint ${endpoint} (length ${Buffer.byteLength(endpoint)})`);
      const spawnedAt = new Date().toISOString();
      child = startWrapper(spec, { cwd, endpoint });
      onDebug?.(`wrapper spawned pid=${child.pid ?? 'none'}`);
      if (onDebug) forwardWrapperSteps(child, onDebug);
      const started = await waitForReady(child);
      const argCount = Math.max(0, spec.argv.length - 1);
      const launch: LaunchContext = { endpoint, executable, argCount, cwd, spawnedAt };
      const running = child;
      const describe = (
        result: StartFailure,
        kind: ExecutionFailure['kind'],
        process?: { exitCode: number | null; signal: string | null; drain: StderrDrain },
      ): ExecutionFailure => describeExecutionFailure(running, launch, { result, kind, process });
      if (started.kind === 'cancelled') throwIfCancelled();
      if (started.kind !== 'ready' && started.kind !== 'cancelled') {
        onDebug?.(`wrapper failed: ${started.kind}`);
        // Read stderr only after the pipes closed (bounded), so a late line is not lost.
        await drainStdio(child);
        const failure = describe(started, 'start');
        await stopProcessGroup(child);
        // A cancel that lands before this point must never be persisted as a startup failure.
        throwIfCancelled();
        return { stdout: '', error: failure.message, exitCode: null, failure };
      }
      onDebug?.('wrapper ready');
      if (onStart && child.pid !== undefined) onStart(collectProcessStartInfo(child.pid, endpoint));
      let reported: WrapperFailedMessage | null = null;
      let reportedSignal: string | null = null;
      child.on('message', (message: unknown) => {
        reported = parseFailedMessage(message) ?? reported;
        reportedSignal = parseExitedSignal(message) ?? reportedSignal;
      });
      child.send({ type: WRAPPER_START });
      launched = true;
      onDebug?.('start sent');
      const [stdout, error, exitCode, streamStats] = await this.wait(child, spec, options);
      onDebug?.(`provider exit code=${exitCode} error=${error ?? 'none'}`);
      // The process is gone; stderr is complete only once every pipe has closed (bounded wait).
      const drain = streamStats === null ? stderrDrainOf(child) : await drainStdio(child);
      // A cancel that lands while the pipes drain must not be persisted as a failure.
      if (error !== null) throwIfCancelled();
      const wrapperReport = reported as WrapperFailedMessage | null;
      if (wrapperReport !== null && error !== null) {
        const result: StartFailure = { kind: 'wrapper-reported', ...stripType(wrapperReport) };
        const failure = describe(result, 'start');
        return { stdout, error: failure.message, exitCode: null, failure };
      }
      const facts = streamStats === null
        ? undefined
        : processFactsOf(child, launch, { exitCode, signal: reportedSignal ?? child.signalCode, drain, streamStats });
      if (error !== null && exitCode !== null && exitCode !== 0) {
        const signal = reportedSignal ?? child.signalCode;
        const failure = describe({ kind: 'exited', code: exitCode, signal }, 'provider-exit', {
          exitCode,
          signal,
          drain,
        });
        failure.message = error;
        return { stdout, error, exitCode, failure, ...(facts ? { process: facts } : {}) };
      }
      if (facts) return { stdout, error, exitCode, process: facts };
      return { stdout, error, exitCode };
    } catch (error) {
      if (error instanceof CancellationRequested) {
        await this.stopOnCancel(child, options, launched);
      }
      throw error;
    }
  }

  private async wait(
    child: ChildProcess,
    spec: CommandSpec,
    hooks: RunOptions = {},
  ): Promise<[string, string | null, number | null, { bytes: number; lines: number } | null]> {
    const { onOutput, onHeartbeat } = hooks;
    const startedAt = Date.now();
    const queue = createLineQueue(child.stdout ?? null);
    if ((spec.stdin !== null && spec.stdin !== undefined) && child.stdin) {
      child.stdin.write(spec.stdin);
      child.stdin.end();
    }
    const stdoutChunks: string[] = [];
    let outputClosed = false;
    while (true) {
      throwIfCancelled();
      let waitMs = this.progressIntervalSec * MS_PER_SECOND;
      if (this.timeoutSec !== null) {
        const remainingMs = this.timeoutSec * MS_PER_SECOND - (Date.now() - startedAt);
        if (remainingMs <= 0) return this.timeout(child, hooks);
        waitMs = Math.min(waitMs, remainingMs);
      }
      let line: string | null | 'timeout';
      if (outputClosed) {
        const finished = await waitForExit(child, waitMs);
        if (finished === 'cancel') throwIfCancelled();
        if (finished === true) break;
        line = null;
      } else {
        line = await queue.get(waitMs);
        if (line === 'cancel') throwIfCancelled();
      }
      if (line === 'timeout') {
        const elapsedSec = Math.floor((Date.now() - startedAt) / MS_PER_SECOND);
        if (onHeartbeat) onHeartbeat(elapsedSec);
        continue;
      }
      if (line === null) {
        outputClosed = true;
        continue;
      }
      stdoutChunks.push(line);
      if (onOutput) onOutput(line.replace(/[\r\n]+$/g, ''));
    }
    if (child.stdout) child.stdout.destroy();
    const stdout = stdoutChunks.join('').trim();
    const status = childStatus(child);
    const stats = { bytes: queue.bytes(), lines: stdoutChunks.length };
    if (status === 0) return [stdout, null, 0, stats];
    if (status === null) return [stdout, 'CLI exited with code null.', null, stats];
    return [stdout, `CLI exited with code ${status}.`, status, stats];
  }

  private async timeout(child: ChildProcess, hooks: RunOptions): Promise<[string, string, null, null]> {
    await this.interrupt(child, hooks, 'timeout');
    await stopProcessGroup(child);
    await notify(hooks.onStopped, 'timeout');
    return ['', `Sub-agent timed out after ${this.timeoutSec}s.`, null, null];
  }
}

function createLineQueue(stream: Readable | null): {
  get(timeoutMs: number): Promise<string | null | 'timeout' | 'cancel'>;
  /** Bytes received on the stream so far, before any line normalization. */
  bytes(): number;
} {
  let received = 0;
  const lines: (string | null)[] = [];
  let waiter: ((value: string | null | 'timeout' | 'cancel') => void) | null = null;
  if (stream) {
    stream.setEncoding('utf8');
    let buffer = '';
    const push = (line: string | null) => {
      if (waiter) {
        const pending = waiter;
        waiter = null;
        pending(line);
      } else {
        lines.push(line);
      }
    };
    stream.on('data', (chunk: string) => {
      received += Buffer.byteLength(chunk);
      buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        push(buffer.slice(0, index + 1));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    });
    const finish = () => {
      if (buffer.length > 0) {
        push(buffer);
        buffer = '';
      }
      push(null);
    };
    stream.on('end', finish);
    stream.on('error', () => {
      finish();
    });
  } else {
    lines.push(null);
  }
  return {
    bytes: () => received,
    get(timeoutMs: number) {
      const queued = lines.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiter = null;
          cancelWaiters.delete(wake);
          resolve('timeout');
        }, timeoutMs);
        const wake = () => {
          clearTimeout(timer);
          waiter = null;
          cancelWaiters.delete(wake);
          resolve('cancel');
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
): Promise<boolean | 'cancel'> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
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
      child.off('exit', onExit);
      cancelWaiters.delete(wake);
      resolve('cancel');
    };
    cancelWaiters.add(wake);
    child.once('exit', onExit);
  });
}

export function childStatus(child: ChildProcess): number | null {
  if (typeof child.exitCode === 'number') return child.exitCode;
  if (child.signalCode) {
    const signal = osConstants.signals[child.signalCode];
    if (typeof signal === 'number') return -signal;
  }
  return null;
}

export async function stopProcessGroup(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  try {
    killProcessTree(child.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }
  // The wrapper exits with the provider, but other group members may outlive both.
  const deadline = Date.now() + TERMINATION_GRACE_SEC * MS_PER_SECOND;
  await waitForExit(child, TERMINATION_GRACE_SEC * MS_PER_SECOND);
  while (processGroupAlive(child.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, TERMINATION_POLL_MS));
  }
  if (processGroupAlive(child.pid) || (child.exitCode === null && child.signalCode === null)) {
    try {
      killProcessTree(child.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    await waitForExit(child, MS_PER_SECOND);
  }
  child.stdout?.destroy();
}

function processGroupAlive(pgid: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
