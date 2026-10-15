import { chmodSync, closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { constants as osConstants, hostname as osHostname } from "node:os";
import path from "node:path";
import { currentBootId, identityLockHolder, kernelProcessIdentity as kernelIdentity } from "@nodeint/migent-kernel";
import { LockNotHeld, threadHolds } from "./locks.js";
import { POSIX, fcntlInt, fcntlLock, posixGetpgid, reapChild } from "./posix.js";
import { atomicReplace } from "./store.js";

export const CORRUPT = Symbol("corrupt");

const serviceKeys = new Set([
  "schema_version",
  "instance_id",
  "pid",
  "pgid",
  "start_key",
  "boot_id",
  "hostname",
  "host",
  "port",
  "token",
  "started_at",
]);

export class ServiceCorrupt extends Error {
  constructor() {
    super("service.json is corrupt.");
    this.name = "ServiceCorrupt";
  }
}

export interface IdentityInspector {
  bootId(): string | null;
  kernelProcessIdentity(pid: number): string | null;
  lockHolder(lockPath: string): number | null;
  pgid(pid: number): number | null;
  hostname(): string | null;
  pidAlive(pid: number): boolean;
}

export interface ServiceRecord {
  schema_version: number;
  instance_id: string;
  pid: number;
  pgid: number;
  start_key: string;
  boot_id: string;
  hostname: string;
  host: string;
  port: number;
  token: string;
  started_at: string;
}

export class LiveInspector implements IdentityInspector {
  bootId(): string | null {
    return currentBootId();
  }

  kernelProcessIdentity(pid: number): string | null {
    return kernelIdentity(pid);
  }

  lockHolder(lockPath: string): number | null {
    return identityLockHolder(lockPath);
  }

  pgid(pid: number): number | null {
    return posixGetpgid(pid);
  }

  hostname(): string | null {
    try {
      const name = osHostname();
      return name || null;
    } catch {
      return null;
    }
  }

  pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (reapChild(pid)) return false;
    try {
      process.kill(pid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM") return true;
      return false;
    }
    return true;
  }
}

export function serviceJsonPath(home: string): string {
  return path.join(home, "service.json");
}

export function serviceLockPath(home: string): string {
  return path.join(home, "service.lock");
}

export function startLockPath(home: string): string {
  return path.join(home, "start.lock");
}

function sameKeySet(value: object, expected: Set<string>): boolean {
  const keys = Object.keys(value);
  if (keys.length !== expected.size) return false;
  return keys.every((key) => expected.has(key));
}

export function serviceIdentityMatches(
  record: ServiceRecord | Record<string, unknown>,
  inspector: IdentityInspector,
  lockPath: string,
): boolean {
  const pid = record.pid;
  if (typeof pid !== "number") return false;
  const holder = inspector.lockHolder(lockPath);
  if (holder === null || holder !== pid) return false;
  const boot = inspector.bootId();
  const recordedBoot = record.boot_id;
  if (!boot || typeof recordedBoot !== "string" || boot !== recordedBoot) return false;
  const start = inspector.kernelProcessIdentity(pid);
  const recordedStart = record.start_key;
  if (!start || typeof recordedStart !== "string" || start !== recordedStart) return false;
  const pgid = inspector.pgid(pid);
  if (pgid === null || pgid !== record.pgid) return false;
  const host = inspector.hostname();
  const recordedHost = record.hostname;
  if (!host || typeof recordedHost !== "string" || host !== recordedHost) return false;
  return true;
}

export function recordIsConfirmedGone(
  record: ServiceRecord | Record<string, unknown>,
  inspector: IdentityInspector,
  lockPath: string,
): boolean {
  if (inspector.lockHolder(lockPath) !== null) return false;
  const pid = record.pid;
  if (typeof pid !== "number") return false;
  if (!inspector.pidAlive(pid)) return true;
  const boot = inspector.bootId();
  const recordedBoot = record.boot_id;
  if (boot && typeof recordedBoot === "string" && recordedBoot && boot !== recordedBoot) return true;
  const start = inspector.kernelProcessIdentity(pid);
  const recordedStart = record.start_key;
  if (start && typeof recordedStart === "string" && recordedStart && start !== recordedStart) return true;
  return false;
}

export function writeServiceJson(
  home: string,
  record: ServiceRecord | Record<string, unknown>,
  beforePublish: (home: string, record: ServiceRecord | Record<string, unknown>) => void,
): void {
  if (!threadHolds(startLockPath(home))) throw new LockNotHeld();
  beforePublish(home, record);
  atomicReplace(serviceJsonPath(home), Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8"));
}

export async function removeServiceJsonIfUnchanged(
  home: string,
  instanceId: string,
  pid: number,
  startKey: string,
  beforeUnlink: (home: string, instanceId: string, pid: number, startKey: string) => void | Promise<void>,
): Promise<"absent" | "changed" | "removed"> {
  if (!threadHolds(startLockPath(home))) throw new LockNotHeld();
  await beforeUnlink(home, instanceId, pid, startKey);
  const file = serviceJsonPath(home);
  if (!existsSync(file)) return "absent";
  let record: ServiceRecord;
  try {
    record = parseServiceBytes(readFileSync(file));
  } catch {
    return "changed";
  }
  if (record.instance_id === instanceId && record.pid === pid && record.start_key === startKey) {
    try {
      unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      throw error;
    }
    return "removed";
  }
  return "changed";
}

function errnoOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const err = error as NodeJS.ErrnoException;
  if (typeof err.errno === "number") return Math.abs(err.errno);
  if (err.code && err.code in osConstants.errno) return osConstants.errno[err.code as keyof typeof osConstants.errno];
  return undefined;
}

export async function acquireServiceLock(home: string): Promise<number | null> {
  const file = serviceLockPath(home);
  const flags = fsConstants.O_RDWR | fsConstants.O_CREAT;
  const fd = openSync(file, flags, 0o600);
  try {
    chmodSync(file, 0o600);
    await fcntlLock(fd, POSIX.F_SETLK, POSIX.F_WRLCK);
  } catch (error) {
    closeSync(fd);
    const errno = errnoOf(error);
    if (
      errno === osConstants.errno.EAGAIN ||
      errno === osConstants.errno.EACCES ||
      errno === osConstants.errno.EWOULDBLOCK
    ) {
      return null;
    }
    throw error;
  }
  return fd;
}

export async function authenticatedInstanceId(port: number, token: string, timeoutSec: number): Promise<string | null> {
  try {
    const { status, raw } = await requestLocal(port, "GET", "/v1/health", {
      Authorization: `Bearer ${token}`,
      Connection: "close",
    }, null, timeoutSec);
    if (status !== 200) return null;
    const payload = JSON.parse(raw.toString("utf8")) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const instanceId = (payload as { instance_id?: unknown }).instance_id;
    return typeof instanceId === "string" ? instanceId : null;
  } catch {
    return null;
  }
}

export function readService(home: string): ServiceRecord | typeof CORRUPT | null {
  const file = serviceJsonPath(home);
  if (!existsSync(file)) return null;
  try {
    return parseServiceBytes(readFileSync(file));
  } catch {
    return CORRUPT;
  }
}

export function parseServiceBytes(raw: Buffer): ServiceRecord {
  if (raw.toString("utf8").trim() === "") throw new ServiceCorrupt();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ServiceCorrupt();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !sameKeySet(parsed, serviceKeys)) {
    throw new ServiceCorrupt();
  }
  const record = parsed as Record<string, unknown>;
  if (record.schema_version !== 1 || typeof record.schema_version !== "number") throw new ServiceCorrupt();
  for (const key of ["instance_id", "start_key", "boot_id", "hostname", "host", "token", "started_at"]) {
    if (typeof record[key] !== "string" || record[key] === "") throw new ServiceCorrupt();
  }
  for (const key of ["pid", "pgid", "port"]) {
    if (typeof record[key] !== "number" || !Number.isInteger(record[key])) throw new ServiceCorrupt();
  }
  const port = record.port as number;
  if (port < 1 || port > 65535) throw new ServiceCorrupt();
  return record as unknown as ServiceRecord;
}

export function handshakeOpen(fd: number): boolean {
  try {
    fstatSync(fd);
    fcntlInt(fd, POSIX.F_GETFL);
    return true;
  } catch {
    return false;
  }
}

export async function requestLocal(
  port: number,
  method: string,
  requestPath: string,
  headers: Record<string, string>,
  body: Buffer | null,
  timeoutSec: number,
): Promise<{ status: number; raw: Buffer }> {
  const { request: httpRequest } = await import("node:http");
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path: requestPath,
        headers,
        timeout: Math.max(1, timeoutSec * 1000),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, raw: Buffer.concat(chunks) });
        });
        response.on("error", reject);
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    if (body) req.end(body);
    else req.end();
  });
}
