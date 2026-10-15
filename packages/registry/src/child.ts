import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ServiceEndpointServer } from "./endpoint.js";
import { ensureRegistryHome } from "./home.js";
import { RegistryHTTPServer } from "./server.js";
import { RegistryStore } from "./store.js";
import { monotonic } from "./time.js";

// Handshake over the IPC channel:
//   child -> parent  {type: "ready", pid, port, instance_id, token}  endpoint and HTTP are listening
//   parent -> child  {type: "published"}                           service.json names this child
// The child serves only after "published". If the channel closes first, the parent died before
// publishing and the child exits without ever being reachable through service.json.

export const READY = "ready";
export const PUBLISHED = "published";
const ACK_TIMEOUT_SEC = 5;

export interface SpawnedChild {
  pid: number;
  returncode: number | null;
  kill(signal?: NodeJS.Signals | number): void;
  wait(timeoutSec: number): Promise<void>;
  /** The ready payload, or null if the child exits, disconnects, or misses the deadline. */
  readReady(deadline: number): Promise<Record<string, unknown> | null>;
  /** Tell the child it was published. False when the channel is already closed. */
  acknowledge(): boolean;
  /** Drop the IPC channel so neither process keeps the other alive. */
  release(): void;
}

export function childInvocation(script: string): { execPath: string; args: string[]; script: string } {
  const tsSibling = script.endsWith(".ts");
  if (tsSibling) {
    const register = path.join(path.dirname(script), "..", "hooks", "register.mjs");
    return {
      execPath: process.execPath,
      args: ["--experimental-strip-types", "--import", path.resolve(register)],
      script,
    };
  }
  return { execPath: process.execPath, args: [], script };
}

export function childEntryScript(): string {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  if (import.meta.url.includes(".ts")) return path.join(directory, "main.ts");
  return path.join(directory, "main.js");
}

function closeQuiet(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // already closed
  }
}

export async function launchChild(home: string, port: number): Promise<SpawnedChild> {
  const directory = ensureRegistryHome(home);
  const logPath = path.join(directory, "service.log");
  const logFd = openSync(logPath, fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY, 0o600);
  const invocation = childInvocation(childEntryScript());
  let proc: ChildProcess;
  try {
    proc = spawn(
      invocation.execPath,
      [...invocation.args, invocation.script, "--child", "--home", directory, "--port", String(port)],
      {
        cwd: directory,
        detached: true,
        stdio: ["ignore", logFd, logFd, "ipc"],
        env: process.env,
        windowsHide: true,
      },
    );
  } finally {
    closeQuiet(logFd);
  }
  if (proc.pid === undefined) {
    proc.kill();
    throw new Error("child pid is unavailable");
  }
  proc.on("error", () => undefined);
  proc.unref();
  return trackChild(proc);
}

function trackChild(proc: ChildProcess): SpawnedChild {
  let ready: Record<string, unknown> | null = null;
  const readyWaiters = new Set<() => void>();
  const wake = (): void => {
    for (const waiter of readyWaiters) waiter();
  };
  proc.on("message", (message: unknown) => {
    if (ready !== null || !message || typeof message !== "object") return;
    const payload = message as Record<string, unknown>;
    if (payload.type !== READY) return;
    const { type: _type, ...rest } = payload;
    ready = rest;
    wake();
  });
  proc.on("disconnect", wake);
  const state: SpawnedChild = {
    pid: proc.pid ?? -1,
    returncode: null,
    kill(signal = "SIGTERM") {
      proc.kill(signal);
    },
    wait(timeoutSec: number) {
      if (state.returncode !== null || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          proc.off("exit", onExit);
          resolve();
        }, Math.max(0, timeoutSec) * 1000);
        const onExit = (): void => {
          clearTimeout(timer);
          resolve();
        };
        proc.once("exit", onExit);
      });
    },
    readReady(deadline: number) {
      return new Promise((resolve) => {
        const check = (): void => {
          if (ready !== null) return done(ready);
          if (!proc.connected || monotonic() >= deadline) return done(null);
        };
        const done = (value: Record<string, unknown> | null): void => {
          clearTimeout(timer);
          readyWaiters.delete(check);
          resolve(value);
        };
        const timer = setTimeout(check, Math.max(0, deadline - monotonic()) * 1000);
        readyWaiters.add(check);
        check();
      });
    },
    acknowledge() {
      if (!proc.connected) return false;
      try {
        proc.send({ type: PUBLISHED });
        return true;
      } catch {
        return false;
      }
    },
    release() {
      if (proc.connected) proc.disconnect();
    },
  };
  proc.on("exit", (code) => {
    state.returncode = code ?? 1;
    wake();
  });
  return state;
}

export async function readReadyLine(child: SpawnedChild, deadline: number): Promise<Record<string, unknown> | null> {
  return child.readReady(deadline);
}

function waitForAck(deadline: number, stop: { flag: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (ok: boolean): void => {
      clearTimeout(timer);
      clearInterval(poll);
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      resolve(ok);
    };
    const onMessage = (message: unknown): void => {
      if (message && typeof message === "object" && (message as { type?: unknown }).type === PUBLISHED) finish(true);
    };
    const onDisconnect = (): void => finish(false);
    const timer = setTimeout(() => finish(false), Math.max(0, deadline - monotonic()) * 1000);
    const poll = setInterval(() => {
      if (stop.flag) finish(false);
    }, 50);
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    if (!process.connected) finish(false);
  });
}

export async function serveChild(home: string, port: number): Promise<number> {
  if (!process.send || !process.connected) return 2;
  const send = process.send.bind(process);
  const directory = ensureRegistryHome(home);
  const instanceId = randomBytes(32).toString("base64url");
  const token = randomBytes(32).toString("base64url");
  let server: RegistryHTTPServer | null = null;
  const stop = { flag: false };
  const onSignal = (): void => {
    stop.flag = true;
    try {
      server?.close();
    } catch {
      // socket already closed
    }
  };
  const lifetime = await ServiceEndpointServer.listen(directory, { instance_id: instanceId, pid: process.pid }, token, onSignal);
  if (lifetime === null) {
    process.stderr.write("Another registry service holds the service endpoint.\n");
    return 1;
  }
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    try {
      server = await RegistryHTTPServer.open(new RegistryStore(directory), token, instanceId, "127.0.0.1", port);
    } catch (error) {
      process.stderr.write(`Cannot listen on 127.0.0.1:${port}: ${(error as Error).message}\n`);
      return 1;
    }
    try {
      send({ type: READY, pid: process.pid, port: server.port, instance_id: instanceId, token });
    } catch {
      return 1;
    }
    if (!(await waitForAck(monotonic() + ACK_TIMEOUT_SEC, stop))) return stop.flag ? 0 : 1;
    process.disconnect?.();
    await serveLoop(server, stop);
    return 0;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    server?.close();
    lifetime.close();
  }
}

async function serveLoop(server: RegistryHTTPServer, stop: { flag: boolean }): Promise<void> {
  server.timeout = 0.2;
  while (!stop.flag) {
    try {
      await server.handleRequest();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EINTR") continue;
      if (stop.flag) break;
      throw error;
    }
  }
  server.close();
}

export async function childMain(argv: string[]): Promise<number> {
  const parsed = parseChildArgs(argv);
  if (!parsed) return 2;
  return serveChild(parsed.home, parsed.port);
}

function parseChildArgs(argv: string[]): { home: string; port: number } | null {
  let home: string | null = null;
  let port: number | null = null;
  let sawChild = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--child") {
      if (sawChild) return null;
      sawChild = true;
      continue;
    }
    const next = argv[index + 1];
    if (arg === "--home" && next !== undefined && !next.startsWith("--")) {
      if (home !== null) return null;
      home = next;
      index += 1;
      continue;
    }
    if (arg === "--port" && next !== undefined && /^-?\d+$/.test(next)) {
      if (port !== null) return null;
      port = Number(next);
      index += 1;
      continue;
    }
    return null;
  }
  if (!sawChild || home === null || port === null) return null;
  return { home, port };
}

export function isDirectChildEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}
