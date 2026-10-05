import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureRegistryHome } from "../src/home.ts";

export const TOOL = { name: "migent", version: "0.1.0" };
export const TOKEN = "token-under-test-token-under-test-token-01";
export const INSTANCE = "instance-under-test-instance-under-test-01";

export function makeWorkspace(root: string, name = "demo"): string {
  const workspace = path.join(root, name);
  const config = path.join(workspace, ".migent");
  mkdirSync(config, { recursive: true });
  writeFileSync(path.join(config, "config.yaml"), "schema_version: 1\n");
  return workspace;
}

export function serviceRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    instance_id: "instance-under-test",
    pid: 424242,
    pgid: 424242,
    start_key: "start-key",
    boot_id: "boot-1",
    hostname: "host.example",
    host: "127.0.0.1",
    port: 47321,
    token: "token-under-test",
    started_at: "2026-09-26T08:07:57Z",
    ...overrides,
  };
}

export function writeService(home: string, record: Record<string, unknown>): void {
  ensureRegistryHome(home);
  writeFileSync(path.join(home, "service.json"), `${JSON.stringify(record, null, 2)}\n`);
}

export class ScriptedInspector {
  record: Record<string, unknown>;
  alive = true;
  holdLock = true;
  startKey: string | null;
  boot: string | null;

  constructor(record: Record<string, unknown>) {
    this.record = record;
    this.startKey = typeof record.start_key === "string" ? record.start_key : null;
    this.boot = typeof record.boot_id === "string" ? record.boot_id : null;
  }

  bootId(): string | null {
    return this.boot === null ? null : String(this.boot);
  }

  kernelProcessIdentity(pid: number): string | null {
    if (pid !== this.record.pid) return "other-start";
    if (this.startKey === null) return null;
    return String(this.startKey);
  }

  lockHolder(_lockPath: string): number | null {
    if (!this.holdLock) return null;
    const pid = this.record.pid;
    return typeof pid === "number" ? pid : null;
  }

  pgid(pid: number): number | null {
    if (pid !== this.record.pid) return null;
    const pgid = this.record.pgid;
    return typeof pgid === "number" ? pgid : null;
  }

  hostname(): string | null {
    const host = this.record.hostname;
    return typeof host === "string" && host ? host : null;
  }

  pidAlive(pid: number): boolean {
    return this.alive && pid === this.record.pid;
  }

  markGone(): void {
    this.alive = false;
    this.holdLock = false;
    this.startKey = "gone-start";
  }
}

export class RecordingBackend {
  private readonly supportedFlag: boolean;
  openErrno: number | null;
  sendErrno: number | null;
  log: unknown[] = [];
  private fd = 80;

  constructor(options: { supported?: boolean; openErrno?: number | null; sendErrno?: number | null } = {}) {
    this.supportedFlag = options.supported ?? false;
    this.openErrno = options.openErrno ?? null;
    this.sendErrno = options.sendErrno ?? null;
  }

  supported(): boolean {
    return this.supportedFlag;
  }

  open(pid: number): number {
    this.log.push(["open", pid]);
    if (this.openErrno !== null) {
      const error = new Error("pidfd_open") as NodeJS.ErrnoException;
      error.errno = this.openErrno;
      throw error;
    }
    const fd = this.fd;
    this.fd += 1;
    return fd;
  }

  send(pidfd: number, sig: number): void {
    this.log.push(["send", pidfd, sig]);
    if (this.sendErrno !== null) {
      const error = new Error("pidfd_send_signal") as NodeJS.ErrnoException;
      error.errno = this.sendErrno;
      this.sendErrno = null;
      throw error;
    }
  }

  close(fd: number): void {
    this.log.push(["close", fd]);
  }

  kill(pid: number, sig: number): void {
    this.log.push(["kill", pid, sig]);
  }
}

export function registryBytes(workspaces: unknown[]): Buffer {
  return Buffer.from(`${JSON.stringify({ schema_version: 1, workspaces })}\n`);
}

export async function waitFor(predicate: () => boolean, timeoutSec: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

export function logText(home: string): string {
  const file = path.join(home, "service.log");
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
