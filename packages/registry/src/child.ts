import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, openSync, readSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureRegistryHome } from "./home.js";
import { acquireServiceLock, handshakeOpen } from "./identity.js";
import { setNonBlocking, socketpair } from "./posix.js";
import { RegistryHTTPServer } from "./server.js";
import { RegistryStore } from "./store.js";
import { monotonic, sleep } from "./time.js";

const ACK = Buffer.from("published\n");
const ACK_TIMEOUT_SEC = 5;

export interface SpawnedChild {
  pid: number;
  returncode: number | null;
  kill(signal?: NodeJS.Signals | number): void;
  wait(timeoutSec: number): Promise<void>;
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

export async function launchChild(home: string, port: number): Promise<[SpawnedChild, number]> {
  const directory = ensureRegistryHome(home);
  const [parentFd, childFd] = socketpair();
  setNonBlocking(parentFd);
  const logPath = path.join(directory, "service.log");
  const logFd = openSync(logPath, fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY, 0o600);
  const entry = childEntryScript();
  const invocation = childInvocation(entry);
  let child: ChildProcess | null = null;
  try {
    child = spawn(
      invocation.execPath,
      [...invocation.args, invocation.script, "--child", "--home", directory, "--port", String(port), "--handshake-fd", "3"],
      {
        cwd: directory,
        detached: true,
        stdio: ["ignore", logFd, logFd, childFd],
        env: process.env,
      },
    );
  } catch (error) {
    closeQuiet(parentFd);
    closeQuiet(childFd);
    closeQuiet(logFd);
    throw error;
  }
  closeQuiet(childFd);
  closeQuiet(logFd);
  const proc = child;
  if (proc.pid === undefined) {
    closeQuiet(parentFd);
    throw new Error("child pid is unavailable");
  }
  const spawned = trackChild(proc);
  proc.unref();
  return [spawned, parentFd];
}

function trackChild(proc: ChildProcess): SpawnedChild {
  const state: SpawnedChild = {
    pid: proc.pid ?? -1,
    returncode: null,
    kill(signal = "SIGTERM") {
      proc.kill(signal);
    },
    wait(timeoutSec: number) {
      if (state.returncode !== null) return Promise.resolve();
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
  };
  proc.on("exit", (code) => {
    state.returncode = code;
  });
  return state;
}

export async function readReadyLine(source: number | { fd?: number }, deadline: number): Promise<Buffer | null> {
  const fd = typeof source === "number" ? source : source.fd;
  if (fd === undefined) return null;
  return readLineFd(fd, deadline);
}

export async function serveChild(home: string, port: number, handshakeFd: number): Promise<number> {
  if (!handshakeOpen(handshakeFd)) return 2;
  setNonBlocking(handshakeFd);
  const directory = ensureRegistryHome(home);
  const lockFd = await acquireServiceLock(directory);
  if (lockFd === null) return 1;
  let server: RegistryHTTPServer | null = null;
  let active: RegistryHTTPServer | null = null;
  const stop = { flag: false };
  const onSignal = (): void => {
    stop.flag = true;
    try {
      active?.close();
    } catch {
      // socket already closed
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    try {
      server = await RegistryHTTPServer.open(new RegistryStore(directory), "pending", "pending", "127.0.0.1", port);
      active = server;
    } catch {
      closeQuiet(lockFd);
      return 1;
    }
    const instanceId = randomBytes(32).toString("base64url");
    const token = randomBytes(32).toString("base64url");
    const ready = Buffer.from(
      `${JSON.stringify({ pid: process.pid, port: server.port, instance_id: instanceId, token })}\n`,
    );
    try {
      if (!writeAllFd(handshakeFd, ready)) return 1;
    } catch {
      return 1;
    }
    if (!(await readAck(handshakeFd, monotonic() + ACK_TIMEOUT_SEC, stop))) return stop.flag ? 0 : 1;
    closeQuiet(handshakeFd);
    const published = server;
    server = null;
    active = published;
    published.token = token;
    published.instanceId = instanceId;
    await serveLoop(published, stop);
    return 0;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (server) server.close();
    closeQuiet(lockFd);
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
  if (!argv.includes("--child")) return 2;
  const parsed = parseChildArgs(argv);
  if (!parsed) return 2;
  return serveChild(parsed.home, parsed.port, parsed.handshakeFd);
}

function parseChildArgs(argv: string[]): { home: string; port: number; handshakeFd: number } | null {
  let home: string | null = null;
  let port: number | null = null;
  let handshakeFd: number | null = null;
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
    if (arg === "--handshake-fd" && next !== undefined && /^-?\d+$/.test(next)) {
      if (handshakeFd !== null) return null;
      handshakeFd = Number(next);
      index += 1;
      continue;
    }
    return null;
  }
  if (!sawChild || home === null || port === null || handshakeFd === null || handshakeFd < 0) return null;
  return { home, port, handshakeFd };
}

async function readAck(fd: number, deadline: number, stop: { flag: boolean }): Promise<boolean> {
  const chunks: Buffer[] = [];
  while (Buffer.concat(chunks).length < ACK.length) {
    if (stop.flag) return false;
    const remaining = deadline - monotonic();
    if (remaining <= 0) return false;
    const data = await readSome(fd, ACK.length - Buffer.concat(chunks).length, Math.min(remaining, 0.1));
    if (stop.flag) return false;
    if (data === undefined) continue;
    if (data === null || data.length === 0) return false;
    chunks.push(data);
    const got = Buffer.concat(chunks);
    if (!got.equals(ACK.subarray(0, got.length))) return false;
  }
  return Buffer.concat(chunks).equals(ACK);
}

async function readLineFd(fd: number, deadline: number, limit = 65536): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const joined = Buffer.concat(chunks);
    const newline = joined.indexOf(0x0a);
    if (newline !== -1) {
      const rest = joined.subarray(newline + 1);
      if (rest.length > 0) return null;
      return joined.subarray(0, newline);
    }
    if (total >= limit) return null;
    const remaining = deadline - monotonic();
    if (remaining <= 0) return null;
    const data = await readSome(fd, 4096, remaining);
    if (data === undefined) continue;
    if (data === null || data.length === 0) return null;
    chunks.push(data);
    total += data.length;
  }
}

async function readSome(fd: number, length: number, timeoutSec: number): Promise<Buffer | null | undefined> {
  const buffer = Buffer.alloc(length);
  try {
    const count = readSync(fd, buffer, 0, length, null);
    if (count === 0) return Buffer.alloc(0);
    return buffer.subarray(0, count);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EAGAIN" || code === "EWOULDBLOCK") {
      await sleep(Math.min(0.01, timeoutSec));
      if (timeoutSec <= 0) return undefined;
      return undefined;
    }
    if (code === "EINTR") return undefined;
    return null;
  }
}

export function writeFd(fd: number, payload: Buffer): boolean {
  return writeAllFd(fd, payload);
}

function writeAllFd(fd: number, payload: Buffer): boolean {
  let offset = 0;
  while (offset < payload.length) {
    try {
      const written = writeSync(fd, payload, offset, payload.length - offset);
      if (written <= 0) return false;
      offset += written;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK" || code === "EINTR") continue;
      throw error;
    }
  }
  return true;
}

export function isDirectChildEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}
