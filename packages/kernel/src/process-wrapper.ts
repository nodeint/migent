import { type ChildProcess, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { constants as osConstants, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARGV_USER_OFFSET, EXIT_COMMAND_NOT_FOUND, EXIT_UNPASSABLE_ARGUMENT, EXIT_WRAPPER_FAILURE, MS_PER_SECOND, SHELL_SIGNAL_BASE, SIGNAL_REPORT_FALLBACK_MS, WRAPPER_POLL_MS } from './constants.ts';
// `.ts` so `node process-wrapper.ts` resolves it from source; tsc rewrites it to `.js`.
// `.ts` for the same reason; env.ts imports only types, so it runs from source.
import { debugEnabled } from './env.ts';
import { spawnProvider,UnpassableArgument } from './provider-spawn.ts';
import {
  UNPASSABLE_ARGUMENT_CODE,
  WRAPPER_EXITED,
  WRAPPER_FAILED,
  WRAPPER_READY,
  WRAPPER_START,
  type WrapperFailedMessage,
  type WrapperPhase,
} from './wrapper-protocol.ts';

// The wrapper runs as `node process-wrapper.ts` from source, so it imports only Node built-ins
// and modules that are themselves runnable from source.
//
// Protocol over the IPC channel (fd 3):
//   wrapper -> owner  {type: "ready"}   once the liveness endpoint is listening
//   owner -> wrapper  {type: "start"}   after the owner has recorded the endpoint
//   wrapper -> owner  {type: "failed"}  when the wrapper cannot go on (see wrapper-protocol.ts)
// The wrapper never starts the provider before "start". When the channel closes, the owner
// is gone (including SIGKILL), and the wrapper stops the provider tree and exits. While the
// wrapper is alive its endpoint accepts connections, which is how other processes tell a
// running execution from an orphaned one without trusting pids.

export { WRAPPER_FAILED, WRAPPER_READY, WRAPPER_START };

const FAILURE_SEND_TIMEOUT_MS = 500;
const DEBUG = debugEnabled();

function debug(step: string): void {
  if (DEBUG) process.stderr.write(`[migent-wrapper] ${new Date().toISOString()} ${step}\n`);
}

/**
 * Report a wrapper-owned failure: one line on stderr, then `failed` over IPC when the channel
 * exists. Exits only after the send completes so the message is not lost with the process.
 */
function fail(
  phase: WrapperPhase,
  error: unknown,
  exit: { exitCode: number; extra?: Partial<WrapperFailedMessage> },
): Promise<never> {
  const { exitCode, extra = {} } = exit;
  const err = (error instanceof Error ? error : new Error(String(error))) as NodeJS.ErrnoException;
  const message: WrapperFailedMessage = { type: WRAPPER_FAILED, phase, message: err.message, ...extra };
  if (typeof err.code === 'string' && message.code === undefined) message.code = err.code;
  if (typeof err.errno === 'number' && message.errno === undefined) message.errno = err.errno;
  if (typeof err.syscall === 'string' && message.syscall === undefined) message.syscall = err.syscall;
  if (typeof err.path === 'string' && message.path === undefined) message.path = err.path;
  process.stderr.write(`[migent-wrapper] ${phase}: ${message.message}${message.code ? ` (${message.code})` : ''}\n`);
  if (DEBUG && err.stack) process.stderr.write(`${err.stack}\n`);
  return new Promise<never>(() => {
    const done = () => process.exit(exitCode);
    if (!process.send || !process.connected) return done();
    const timer = setTimeout(done, FAILURE_SEND_TIMEOUT_MS);
    timer.unref();
    try {
      process.send(message, undefined, undefined, () => done());
    } catch {
      done();
    }
  });
}

const POSIX_SOCKET_PATH_MAX = 100;
/** Hex characters of the token hash kept in the endpoint name. */
const ENDPOINT_NAME_HEX_LENGTH = 16;
/** An option and its value (`--name value`) consume this many argv entries. */
const OPTION_PAIR_LENGTH = 2;
/** Length of the `--` option prefix. */
const OPTION_PREFIX_LENGTH = 2;

/** Local endpoint for one execution: a named pipe on Windows, a Unix socket elsewhere. */
export function wrapperEndpoint(token: string): string {
  const name = `migent-${createHash('sha256').update(token).digest('hex').slice(0, ENDPOINT_NAME_HEX_LENGTH)}`;
  if (process.platform === 'win32') return `\\\\.\\pipe\\${name}`;
  const candidate = path.join(tmpdir(), `${name}.sock`);
  if (Buffer.byteLength(candidate) <= POSIX_SOCKET_PATH_MAX) return candidate;
  return path.join('/tmp', `${name}.sock`);
}

/**
 * Signal a process tree. On POSIX the tree is the process group led by `pid` (spawned with
 * `detached: true`). Windows has no signals; `taskkill /T /F` ends the tree whatever `signal` is.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    // 128: no such process.
    if (result.status === SHELL_SIGNAL_BASE) throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    return;
  }
  process.kill(-pid, signal);
}

function removeStaleSocket(endpoint: string): void {
  if (process.platform === 'win32') return;
  try {
    unlinkSync(endpoint);
  } catch {
    // absent
  }
}

function listen(endpoint: string): Promise<Server> {
  removeStaleSocket(endpoint);
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.end());
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runningAsMain(): boolean {
  const [, entry] = process.argv;
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(wrapperEntry());
}

interface WrapperOptions {
  endpoint: string;
  graceSec: number;
  command: string[];
}

function parseArgv(argv: string[]): WrapperOptions | null {
  const options: Record<string, string> = {};
  let index = 0;
  while (index < argv.length) {
    const item = argv[index];
    if (item === '--') {
      const command = argv.slice(index + 1);
      if (command.length === 0 || options.endpoint === undefined || options.grace_sec === undefined) return null;
      const graceSec = Number(options.grace_sec);
      if (!Number.isFinite(graceSec) || graceSec < 0) return null;
      return { endpoint: options.endpoint, graceSec, command };
    }
    if (item === '--endpoint' || item === '--grace-sec') {
      const value = argv[index + 1];
      if (value === undefined) return null;
      options[item.slice(OPTION_PREFIX_LENGTH).replaceAll('-', '_')] = value;
      index += OPTION_PAIR_LENGTH;
      continue;
    }
    return null;
  }
  return null;
}

/** Stops the running provider: SIGTERM to the group, a bounded grace, then SIGKILL to what is left. */
async function stopProviderGroup(
  running: { provider: ChildProcess; pid: number },
  wrapper: { graceSec: number; endpoint: string; server: Server },
  exit: (code: number) => never,
): Promise<void> {
  const { provider } = running;
  if (process.platform === 'win32') {
    try {
      killProcessTree(running.pid, 'SIGKILL');
    } catch {
      // already gone
    }
    exit(1);
  }
  try {
    killProcessTree(process.pid, 'SIGTERM');
  } catch {
    exit(1);
  }
  const deadline = Date.now() + wrapper.graceSec * MS_PER_SECOND;
  while (Date.now() < deadline && provider.exitCode === null && provider.signalCode === null) {
    await sleepMs(WRAPPER_POLL_MS);
  }
  wrapper.server.close();
  removeStaleSocket(wrapper.endpoint);
  // Also reaches anything the provider left in the group, and the wrapper itself.
  try {
    killProcessTree(process.pid, 'SIGKILL');
  } catch {
    // nothing left
  }
  process.exit(1);
}

/** Exits with the provider's status; a signal death is first reported to the owner by name. */
function exitWithProviderStatus(
  code: number | null,
  signal: NodeJS.Signals | null,
  exit: (code: number) => never,
): void {
  // A signal death keeps its identity as the shell's 128 + signal, so the owner can tell it from an exit.
  const number = signal ? osConstants.signals[signal] : undefined;
  const status = signal ? SHELL_SIGNAL_BASE + (number ?? 0) : (code ?? 1);
  if (!signal || !process.send || !process.connected) return exit(status);
  // Say which signal it was, separately from the exit code: a plain `exit 137` is not a SIGKILL.
  const fallback = setTimeout(() => exit(status), SIGNAL_REPORT_FALLBACK_MS);
  try {
    process.send({ type: WRAPPER_EXITED, signal }, () => {
      clearTimeout(fallback);
      exit(status);
    });
  } catch {
    clearTimeout(fallback);
    exit(status);
  }
}

async function main(argv: string[]): Promise<void> {
  const options = parseArgv(argv);
  if (options === null) return fail('argv', new Error('Invalid wrapper arguments.'), { exitCode: 1 });
  if (!process.send || !process.connected) return fail('ipc', new Error('No IPC channel to the owner.'), { exitCode: 1 });
  debug(`started pid=${process.pid} endpoint=${options.endpoint}`);
  // The owner signals the whole group on cancel and timeout; the wrapper outlives the
  // provider so it can report the provider's exit status.
  process.on('SIGTERM', () => undefined);
  process.on('SIGHUP', () => undefined);

  let server: Server;
  try {
    server = await listen(options.endpoint);
  } catch (error) {
    const length = Buffer.byteLength(options.endpoint);
    const cause = error as NodeJS.ErrnoException;
    return fail('listen', new Error(`${cause.message} (endpoint ${options.endpoint}, length ${length})`), {
      exitCode: 1,
      extra: { code: cause.code, errno: cause.errno, syscall: cause.syscall, path: options.endpoint },
    });
  }
  debug('listening');
  superviseProvider(options, server);
  process.send({ type: WRAPPER_READY });
}

/** Spawns the provider on the owner's start message and relays its exit, or stops it on disconnect. */
function superviseProvider(options: WrapperOptions, server: Server): void {
  const exit = (code: number): never => {
    server.close();
    removeStaleSocket(options.endpoint);
    process.exit(code);
  };

  let provider: ChildProcess | null = null;
  let stopping = false;

  const stopProvider = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    const running = provider;
    if (running === null || running.pid === undefined) return exit(1);
    const wrapper = { graceSec: options.graceSec, endpoint: options.endpoint, server };
    await stopProviderGroup({ provider: running, pid: running.pid }, wrapper, exit);
  };

  process.on('disconnect', () => {
    void stopProvider();
  });
  const onProviderError = (error: NodeJS.ErrnoException): void => {
    if (stopping) return;
    server.close();
    removeStaleSocket(options.endpoint);
    const exitCode = error.code === 'ENOENT' ? EXIT_COMMAND_NOT_FOUND : EXIT_WRAPPER_FAILURE;
    void fail('spawn', error, { exitCode, extra: { path: error.path ?? options.command[0] } });
  };
  const onProviderExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (stopping) return;
    debug(`provider exit code=${code} signal=${signal}`);
    exitWithProviderStatus(code, signal, exit);
  };
  process.on('message', (message: unknown) => {
    if (provider !== null || stopping) return;
    if (!message || typeof message !== 'object' || (message as { type?: unknown }).type !== WRAPPER_START) return;
    const {command} = options;
    let started: ChildProcess;
    try {
      started = spawnProvider(command[0] ?? '', command.slice(1), { stdio: 'inherit', windowsHide: true });
    } catch (error) {
      server.close();
      removeStaleSocket(options.endpoint);
      const unpassable = error instanceof UnpassableArgument;
      void fail('spawn', error, { exitCode: unpassable ? EXIT_UNPASSABLE_ARGUMENT : EXIT_WRAPPER_FAILURE, extra: unpassable ? { code: UNPASSABLE_ARGUMENT_CODE } : {} });
      return;
    }
    provider = started;
    debug(`provider spawned pid=${started.pid}`);
    started.on('error', onProviderError);
    started.on('exit', onProviderExit);
  });
}

if (runningAsMain()) {
  main(process.argv.slice(ARGV_USER_OFFSET)).catch((error: unknown) => {
    void fail('runtime', error, { exitCode: 1 });
  });
}

export function wrapperEntry(): string {
  const url = new URL(import.meta.url);
  url.search = '';
  url.hash = '';
  return fileURLToPath(url);
}
