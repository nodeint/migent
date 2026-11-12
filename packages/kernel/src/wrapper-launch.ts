/** Owner-side wrapper startup: spawn the process wrapper, await its ready handshake, and report start failures. */
import { type ChildProcess, spawn, type StdioOptions } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { isShellSignalExitCode } from './constants.js';
import { wrapperArgv } from './process-ownership.js';
import { TailBuffer } from './tail-buffer.js';
import {
  parseFailedMessage,
  type StartFailure,
  type StartResult,
  UNPASSABLE_ARGUMENT_CODE,
  WRAPPER_READY,
  type WrapperFailedMessage,
} from './wrapper-protocol.js';

/** The cancellation hooks a start handshake needs; supplied by the owner of cancellation state. */
export interface CancellationSignal {
  throwIfCancelled(): void;
  onCancel(waiter: () => void): () => void;
}

export const TERMINATION_GRACE_SEC = 5;

export type StderrDrain = 'closed' | 'grace-expired';

let stderrGuarded = false;

/** Mirror wrapper stderr to ours. A closed pipe emits `error` asynchronously; swallow it and keep draining. */
function forwardToOwnerStderr(chunk: Buffer): void {
  if (!stderrGuarded) {
    stderrGuarded = true;
    process.stderr.on('error', () => undefined);
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
  /** True once the child's stdio pipes have all closed. */
  closed: boolean;
}

const diagnostics = new WeakMap<ChildProcess, WrapperDiagnostics>();

/** The last stderr the wrapper (and the provider, which shares its fd 2) wrote. */
export function stderrTailOf(child: ChildProcess): string {
  return diagnostics.get(child)?.stderr.toString() ?? '';
}

export function stderrTotalOf(child: ChildProcess): number {
  return diagnostics.get(child)?.stderr.totalBytes ?? 0;
}

/** Whether stderr was complete when read: only `closed` is authoritative. */
export function stderrDrainOf(child: ChildProcess): StderrDrain {
  const record = diagnostics.get(child);
  // A child that never started has no pipes to wait for.
  return record?.closed === true || child.pid === undefined ? 'closed' : 'grace-expired';
}

/**
 * Waits (bounded) for the child's `close`, so all stderr is read, and says whether it arrived. A
 * child that is still running cannot close, so it is not waited for.
 */
export async function drainStdio(child: ChildProcess): Promise<StderrDrain> {
  if (stderrDrainOf(child) === 'closed') return 'closed';
  if (child.exitCode !== null || child.signalCode !== null) await channelDrained(child);
  return stderrDrainOf(child);
}

export interface WrapperLaunch {
  readonly cwd: string;
  readonly endpoint: string;
  readonly stdio?: StdioOptions;
}

export function startWrapper(spec: CommandSpec, launch: WrapperLaunch): ChildProcess {
  const { cwd, endpoint } = launch;
  const stdio = launch.stdio ?? [(spec.stdin !== null && spec.stdin !== undefined) ? 'pipe' : 'inherit', 'pipe', 'pipe', 'ipc'];
  const argv = wrapperArgv(spec.argv, { endpoint, graceSec: TERMINATION_GRACE_SEC });
  const child = spawn(argv[0] ?? '', argv.slice(1), {
    cwd,
    // POSIX: a new process group, so the whole provider tree can be signalled at once.
    // Windows: `taskkill /T` follows the tree instead, and detaching would open a new console.
    detached: process.platform !== 'win32',
    stdio,
    windowsHide: true,
  });
  const record: WrapperDiagnostics = { spawnError: null, stderr: new TailBuffer(), closed: false };
  diagnostics.set(child, record);
  child.once('close', () => {
    record.closed = true;
  });
  child.on('error', (error: NodeJS.ErrnoException) => {
    record.spawnError = error;
  });
  // Tee for the whole life of the child, so a full pipe can never block the provider.
  const {stderr} = child;
  if (stderr) {
    stderr.on('data', (chunk: Buffer) => {
      record.stderr.append(chunk);
      forwardToOwnerStderr(chunk);
    });
    stderr.on('error', () => undefined);
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
  return signal !== null || (code !== null && isShellSignalExitCode(code));
}

/**
 * Resolves the start handshake. A non-ready observation is only a candidate: it becomes the
 * result once settled, and a cancellation raised before that wins (`cancelled`).
 */
export function waitForReady(
  child: ChildProcess,
  options: WaitForReadyOptions,
  cancellation: CancellationSignal,
): Promise<StartResult> {
  const settleMs = options.settleMs ?? SIGNAL_SETTLE_MS;
  const isCancelled = (): boolean => {
    try {
      cancellation.throwIfCancelled();
      return false;
    } catch {
      return true;
    }
  };
  return new Promise((resolve) => {
    let candidate: StartFailure | null = null;
    let timer: NodeJS.Timeout | null = null;
    let done = false;
    const finish = (result: StartResult) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('close', onClose);
      child.off('error', onError);
      unsubscribeCancel();
      resolve(result);
    };
    const settle = (next: StartFailure, delayMs: number) => {
      candidate = next;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // The flag can be set with no waiter call left (callback order is not guaranteed).
        finish(isCancelled() ? { kind: 'cancelled' } : (candidate as StartFailure));
      }, delayMs);
    };
    const onMessage = (message: unknown) => {
      if (done) return;
      if (message && typeof message === 'object' && (message as { type?: unknown }).type === WRAPPER_READY) {
        finish({ kind: 'ready' });
        return;
      }
      const failed = parseFailedMessage(message);
      if (failed !== null) {
        const { type: ignoredType, ...rest } = failed;
        settle({ kind: 'wrapper-reported', ...rest }, 0);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return;
      // A wrapper-reported failure already explains this exit.
      if (candidate?.kind === 'wrapper-reported') return;
      const next: StartFailure = { kind: 'exited', code, signal };
      // Plain exits wait for the pipes to close so stderr and a `failed` message can land.
      settle(next, signalLike(code, signal) ? settleMs : EXIT_DRAIN_MS);
    };
    const onClose = () => {
      if (done || candidate === null) return;
      if (candidate.kind === 'exited' && signalLike(candidate.code, candidate.signal)) return;
      settle(candidate, 0);
    };
    const onError = (error: NodeJS.ErrnoException) => {
      const { message, code, errno, syscall, path } = error;
      settle({ kind: 'spawn-error', message, code, errno, syscall, path }, 0);
    };
    const onCancel = () => finish({ kind: 'cancelled' });
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('close', onClose);
    child.once('error', onError);
    const unsubscribeCancel = cancellation.onCancel(onCancel);
    // Events that fired before this listener was attached.
    const early = diagnostics.get(child)?.spawnError;
    if (early) onError(early);
    else if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
  });
}

export function stripType(message: WrapperFailedMessage): Omit<WrapperFailedMessage, 'type'> {
  const { type: ignoredType, ...rest } = message;
  return rest;
}

/** Waits (bounded) for a finished child's pipes to close, so late stderr and IPC are seen. */
function channelDrained(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, EXIT_DRAIN_MS);
    function done() {
      clearTimeout(timer);
      child.off('close', done);
      resolve();
    }
    child.once('close', done);
  });
}

const WRAPPER_STEP_PREFIX = '[migent-wrapper] ';

const MAX_STEP_LINE_CHARS = 4096;

/**
 * Splits a stream into wrapper trace lines. Memory stays bounded: a line that does not start
 * with the wrapper prefix, or grows past the limit, is dropped up to its next newline.
 */
export function createWrapperStepParser(onStep: (step: string) => void): (chunk: string) => void {
  let partial = '';
  let discarding = false;
  return (chunk) => {
    let rest = chunk;
    while (rest.length > 0) {
      const newline = rest.indexOf('\n');
      const piece = newline === -1 ? rest : rest.slice(0, newline);
      rest = newline === -1 ? '' : rest.slice(newline + 1);
      if (!discarding) {
        partial += piece;
        const prefixLength = Math.min(partial.length, WRAPPER_STEP_PREFIX.length);
        if (
          partial.slice(0, prefixLength) !== WRAPPER_STEP_PREFIX.slice(0, prefixLength)
          || partial.length > MAX_STEP_LINE_CHARS
        ) {
          discarding = true;
          partial = '';
        }
      }
      if (newline === -1) continue;
      if (!discarding && partial.startsWith(WRAPPER_STEP_PREFIX)) {
        onStep(partial.slice(WRAPPER_STEP_PREFIX.length).replace(/\r$/, '').replace(/^\S+Z /, ''));
      }
      partial = '';
      discarding = false;
    }
  };
}

/** Hands the wrapper's own `[migent-wrapper]` trace lines to the debug sink as they arrive. */
export function forwardWrapperSteps(child: ChildProcess, onDebug: (step: string, fromWrapper?: boolean) => void): void {
  const parse = createWrapperStepParser((step) => onDebug(step, true));
  const {stderr} = child;
  if (!stderr) return;
  const decoder = new StringDecoder('utf8');
  stderr.on('data', (chunk: Buffer) => parse(decoder.write(chunk)));
}

const STDERR_EXCERPT_LINES = 3;

function stderrExcerpt(stderrTail: string): string {
  const lines = stderrTail.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  return lines.slice(-STDERR_EXCERPT_LINES).join(' | ');
}

/** The message for a wrapper-reported spawn failure, or null to fall back to the generic one. */
function describeSpawnPhaseFailure(
  failure: Extract<StartFailure, { kind: 'wrapper-reported' }>,
  command: string,
): string | null {
  if (failure.code === 'ENOENT') return `CLI executable not found: ${command}`;
  if (failure.code === UNPASSABLE_ARGUMENT_CODE) return failure.message;
  if (!failure.code) return null;
  const syscall = failure.syscall ? ` (${failure.syscall})` : '';
  return `Provider CLI could not be started: ${command}: ${failure.code}${syscall} ${failure.message}`;
}

/** The user-facing message for a failed start. Pure. */
export function describeStartFailure(
  failure: StartFailure,
  context: { command: string; stderrTail?: string },
): string {
  const excerpt = stderrExcerpt(context.stderrTail ?? '');
  const withExcerpt = (text: string) => (excerpt ? `${text} stderr: ${excerpt}` : text);
  switch (failure.kind) {
    case 'spawn-error': {
      const where = failure.path ?? 'node';
      const cause = [failure.code, failure.syscall ? `(${failure.syscall})` : null].filter(Boolean).join(' ');
      return `Could not launch ${where}: ${cause ? `${cause} ` : ''}${failure.message}`.trim();
    }
    case 'exited': {
      const how = failure.signal ? `signal ${failure.signal}` : `code ${failure.code ?? 'null'}`;
      return withExcerpt(`Provider process wrapper exited before it was ready (${how}).`);
    }
    case 'wrapper-reported': {
      const spawnMessage = failure.phase === 'spawn' ? describeSpawnPhaseFailure(failure, context.command) : null;
      if (spawnMessage !== null) return spawnMessage;
      const early = failure.phase === 'argv' || failure.phase === 'ipc' || failure.phase === 'listen';
      const head = early ? 'Provider wrapper failed to start' : 'Provider wrapper failed';
      return withExcerpt(`${head} (${failure.phase}): ${failure.message}`);
    }
  }
}

export interface CommandSpec {
  argv: string[];
  stdin?: string | null;
}
