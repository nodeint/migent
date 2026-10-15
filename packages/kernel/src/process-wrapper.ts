import { type ChildProcess, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// `.ts` so `node process-wrapper.ts` resolves it from source; tsc rewrites it to `.js`.
import { UnpassableArgument, spawnProvider } from "./provider-spawn.ts";

// The wrapper runs as `node process-wrapper.ts` from source, so it imports only Node built-ins
// and modules that are themselves runnable from source.
//
// Protocol over the IPC channel (fd 3):
//   wrapper -> owner  {type: "ready"}   once the liveness endpoint is listening
//   owner -> wrapper  {type: "start"}   after the owner has recorded the endpoint
// The wrapper never starts the provider before "start". When the channel closes, the owner
// is gone (including SIGKILL), and the wrapper stops the provider tree and exits. While the
// wrapper is alive its endpoint accepts connections, which is how other processes tell a
// running execution from an orphaned one without trusting pids.

export const WRAPPER_READY = "ready";
export const WRAPPER_START = "start";

const POSIX_SOCKET_PATH_MAX = 100;

/** Local endpoint for one execution: a named pipe on Windows, a Unix socket elsewhere. */
export function wrapperEndpoint(token: string): string {
  const name = `migent-${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
  if (process.platform === "win32") return `\\\\.\\pipe\\${name}`;
  const candidate = path.join(tmpdir(), `${name}.sock`);
  if (Buffer.byteLength(candidate) <= POSIX_SOCKET_PATH_MAX) return candidate;
  return path.join("/tmp", `${name}.sock`);
}

/**
 * Signal a process tree. On POSIX the tree is the process group led by `pid` (spawned with
 * `detached: true`). Windows has no signals; `taskkill /T /F` ends the tree whatever `signal` is.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    // 128: no such process.
    if (result.status === 128) throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    return;
  }
  process.kill(-pid, signal);
}

function removeStaleSocket(endpoint: string): void {
  if (process.platform === "win32") return;
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
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runningAsMain(): boolean {
  const entry = process.argv[1];
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
    if (item === "--") {
      const command = argv.slice(index + 1);
      if (command.length === 0 || options.endpoint === undefined || options.grace_sec === undefined) return null;
      const graceSec = Number(options.grace_sec);
      if (!Number.isFinite(graceSec) || graceSec < 0) return null;
      return { endpoint: options.endpoint, graceSec, command };
    }
    if (item === "--endpoint" || item === "--grace-sec") {
      const value = argv[index + 1];
      if (value === undefined) return null;
      options[item.slice(2).replaceAll("-", "_")] = value;
      index += 2;
      continue;
    }
    return null;
  }
  return null;
}

async function main(argv: string[]): Promise<void> {
  const options = parseArgv(argv);
  if (options === null || !process.send || !process.connected) process.exit(1);
  // The owner signals the whole group on cancel and timeout; the wrapper outlives the
  // provider so it can report the provider's exit status.
  process.on("SIGTERM", () => undefined);
  process.on("SIGHUP", () => undefined);

  let server: Server;
  try {
    server = await listen(options.endpoint);
  } catch {
    process.exit(1);
  }
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
    if (process.platform === "win32") {
      try {
        killProcessTree(running.pid, "SIGKILL");
      } catch {
        // already gone
      }
      exit(1);
    }
    try {
      killProcessTree(process.pid, "SIGTERM");
    } catch {
      exit(1);
    }
    const deadline = Date.now() + options.graceSec * 1000;
    while (Date.now() < deadline && running.exitCode === null && running.signalCode === null) {
      await sleepMs(50);
    }
    server.close();
    removeStaleSocket(options.endpoint);
    // Also reaches anything the provider left in the group, and the wrapper itself.
    try {
      killProcessTree(process.pid, "SIGKILL");
    } catch {
      // nothing left
    }
    process.exit(1);
  };

  process.on("disconnect", () => {
    void stopProvider();
  });
  process.on("message", (message: unknown) => {
    if (provider !== null || stopping) return;
    if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== WRAPPER_START) return;
    const command = options.command;
    let started: ChildProcess;
    try {
      started = spawnProvider(command[0] ?? "", command.slice(1), { stdio: "inherit", windowsHide: true });
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`);
      return exit(error instanceof UnpassableArgument ? 2 : 1);
    }
    provider = started;
    started.on("error", (error: NodeJS.ErrnoException) => {
      if (stopping) return;
      if (error.code === "ENOENT") {
        process.stderr.write(`CLI executable not found: ${command[0]}\n`);
        exit(127);
      }
      exit(1);
    });
    started.on("exit", (code, signal) => {
      if (stopping) return;
      exit(signal ? 1 : (code ?? 1));
    });
  });
  process.send({ type: WRAPPER_READY });
}

if (runningAsMain()) {
  main(process.argv.slice(2)).catch(() => {
    process.exit(1);
  });
}

export function wrapperEntry(): string {
  const url = new URL(import.meta.url);
  url.search = "";
  url.hash = "";
  return fileURLToPath(url);
}
