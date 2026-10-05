import { readFileSync, statSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import path from "node:path";
import { isRecord } from "./record.js";
import {
  currentBootId,
  identityLockHolder,
  kernelProcessIdentity,
  posixGetpgid,
  wrapperEntry,
} from "./process-wrapper.js";

export const IDENTITY_FILENAME = "process.identity";
export const IDENTITY_LOCK_WAIT_SEC = 2;
export const PID_PRESENT = "present";
export const PID_GONE = "gone";
export const PID_UNVERIFIED = "unverified";
export const REAP_STILL_RUNNING = "still-running";
export const REAP_ALREADY_EXITED = "already-exited";
export const REAP_BOOT_MISMATCH = "boot-mismatch";
export const REAP_REAPED = "reaped";
export const REAP_UNVERIFIED = "unverified";
export const REAP_NOOP = "noop";
export const ERROR_REAPED = "Owner process is not running; provider process group reaped.";
export const ERROR_ALREADY_EXITED =
  "Owner process is not running; provider process already exited.";
export const ERROR_BOOT_MISMATCH =
  "Owner process is not running; recorded boot id does not match this boot.";

const SIGTERM = 15;
const SIGKILL = 9;

export interface ProcessStartInfo {
  hostname: string;
  bootId: string | null;
  ownerPid: number;
  ownerStartKey: string | null;
  providerPid: number;
  providerPgid: number;
  providerStartKey: string | null;
  identityPath: string;
  identityToken: string;
}

export interface ReapDecision {
  action: string;
  sessionId: string;
  executionId: string;
  ownerPid?: number | null;
  error?: string | null;
}

export interface ProcessInspector {
  hostname(): string;
  bootId(): string | null;
  probePid(pid: number): string;
  kernelProcessIdentity(pid: number): string | null;
  getpgid(pid: number): number | null;
  identityLockHolder(filePath: string): number | null;
  readIdentityFile(filePath: string): Record<string, unknown> | null;
  killpg(pgid: number, sig: number): void;
}

export class PosixProcessInspector implements ProcessInspector {
  hostname(): string {
    return osHostname();
  }

  bootId(): string | null {
    return currentBootId();
  }

  probePid(pid: number): string {
    return probePid(pid);
  }

  kernelProcessIdentity(pid: number): string | null {
    return kernelProcessIdentity(pid);
  }

  getpgid(pid: number): number | null {
    return posixGetpgid(pid);
  }

  identityLockHolder(filePath: string): number | null {
    return identityLockHolder(filePath);
  }

  readIdentityFile(filePath: string): Record<string, unknown> | null {
    try {
      const payload: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (!isRecord(payload)) return null;
      return payload;
    } catch {
      return null;
    }
  }

  killpg(pgid: number, sig: number): void {
    process.kill(-pgid, sig);
  }
}

export function probePid(pid: number): string {
  try {
    process.kill(pid, 0);
    return PID_PRESENT;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return PID_PRESENT;
    if (code === "ESRCH") return PID_GONE;
    return PID_UNVERIFIED;
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sleepMsSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export async function waitForIdentityLock(
  filePath: string,
  pid: number,
  timeoutSec: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (true) {
    if (identityLockHolder(filePath) === pid) return true;
    if (probePid(pid) === PID_GONE) return false;
    if (Date.now() >= deadline) return identityLockHolder(filePath) === pid;
    await sleepMs(10);
  }
}

export function wrapperArgv(
  specArgv: readonly string[],
  options: {
    deathFd: number;
    identityPath: string;
    token: string;
    graceSec: number;
    executable?: string;
  },
): string[] {
  return [
    options.executable ?? process.execPath,
    wrapperEntry(),
    "--death-fd",
    String(options.deathFd),
    "--identity-path",
    options.identityPath,
    "--token",
    options.token,
    "--grace-sec",
    String(options.graceSec),
    "--",
    ...specArgv,
  ];
}

export function collectProcessStartInfo(
  processPid: number,
  identityPath: string,
  identityToken: string,
): ProcessStartInfo {
  const providerPgid = posixGetpgid(processPid) ?? processPid;
  const ownerPid = process.pid;
  return {
    hostname: osHostname(),
    bootId: currentBootId(),
    ownerPid,
    ownerStartKey: kernelProcessIdentity(ownerPid),
    providerPid: processPid,
    providerPgid,
    providerStartKey: kernelProcessIdentity(processPid),
    identityPath,
    identityToken,
  };
}

export function stillRunningMessage(
  sessionId: string,
  executionId: string,
  ownerPid: number,
): string {
  return `Session ${sessionId} execution ${executionId} is still running under owner pid ${ownerPid}.`;
}

export function unverifiedProcessMessage(sessionId: string, executionId: string): string {
  return `Session ${sessionId} execution ${executionId} has an unverified live provider process.`;
}

export function raiseReapDecision(decision: ReapDecision): void {
  if (decision.action === REAP_STILL_RUNNING) {
    const ownerPid = decision.ownerPid ?? 0;
    throw new Error(stillRunningMessage(decision.sessionId, decision.executionId, ownerPid));
  }
  if (decision.action === REAP_UNVERIFIED) {
    throw new Error(unverifiedProcessMessage(decision.sessionId, decision.executionId));
  }
}

export function classifyOrphanedExecution(
  metadata: Record<string, unknown>,
  executionDirectory: string,
  inspector: ProcessInspector,
): ReapDecision {
  const sessionId = metadata.session_id ? String(metadata.session_id) : "";
  const executionId = metadata.execution_id
    ? String(metadata.execution_id)
    : path.basename(executionDirectory);
  if (metadata.status !== "running") {
    return { action: REAP_NOOP, sessionId, executionId };
  }
  const recordedHost = metadata.hostname;
  if (typeof recordedHost === "string" && recordedHost !== inspector.hostname()) {
    return { action: REAP_UNVERIFIED, sessionId, executionId };
  }
  const ownerPid = optionalInt(metadata.owner_pid);
  const ownerState = ownerStateOf(metadata, ownerPid, inspector);
  if (ownerState === "alive") {
    return { action: REAP_STILL_RUNNING, sessionId, executionId, ownerPid };
  }
  if (ownerState === "unreadable" || ownerState === "unverified" || ownerState === "missing") {
    return { action: REAP_UNVERIFIED, sessionId, executionId, ownerPid };
  }
  const providerPid = optionalInt(metadata.provider_pid);
  if (providerPid === null) {
    return { action: REAP_UNVERIFIED, sessionId, executionId, ownerPid };
  }
  const providerProbe = inspector.probePid(providerPid);
  if (providerProbe === PID_GONE) {
    return {
      action: REAP_ALREADY_EXITED,
      sessionId,
      executionId,
      ownerPid,
      error: ERROR_ALREADY_EXITED,
    };
  }
  if (providerProbe !== PID_PRESENT) {
    return { action: REAP_UNVERIFIED, sessionId, executionId, ownerPid };
  }
  const storedBoot = metadata.boot_id;
  const currentBoot = inspector.bootId();
  if (
    typeof storedBoot === "string" &&
    storedBoot &&
    currentBoot !== null &&
    storedBoot !== currentBoot
  ) {
    return {
      action: REAP_BOOT_MISMATCH,
      sessionId,
      executionId,
      ownerPid,
      error: ERROR_BOOT_MISMATCH,
    };
  }
  if (processIdentityMatches(metadata, executionDirectory, inspector)) {
    return {
      action: REAP_REAPED,
      sessionId,
      executionId,
      ownerPid,
      error: ERROR_REAPED,
    };
  }
  return { action: REAP_UNVERIFIED, sessionId, executionId, ownerPid };
}

export function processIdentityMatches(
  metadata: Record<string, unknown>,
  executionDirectory: string,
  inspector: ProcessInspector,
): boolean {
  if (metadata.hostname !== inspector.hostname()) return false;
  const storedBoot = presentStr(metadata.boot_id);
  const currentBoot = presentStr(inspector.bootId());
  if (storedBoot === null || storedBoot !== currentBoot) return false;
  return identityKillChecksMatch(metadata, executionDirectory, inspector);
}

export function identityKillChecksMatch(
  metadata: Record<string, unknown>,
  executionDirectory: string,
  inspector: ProcessInspector,
): boolean {
  const identityFile = resolveIdentityPath(metadata, executionDirectory);
  try {
    if (!statSync(identityFile).isFile()) return false;
  } catch {
    return false;
  }
  const holder = inspector.identityLockHolder(identityFile);
  const providerPid = optionalInt(metadata.provider_pid);
  const providerPgid = optionalInt(metadata.provider_pgid);
  const providerStartKey = presentStr(metadata.provider_start_key);
  const token = metadata.identity_token;
  if (holder === null || providerPid === null || holder !== providerPid) return false;
  if (providerStartKey === null) return false;
  const payload = inspector.readIdentityFile(identityFile);
  if (payload === null) return false;
  const payloadStartKey = presentStr(payload.start_key);
  const liveStartKey = presentStr(inspector.kernelProcessIdentity(holder));
  if (
    payload.token !== token ||
    optionalInt(payload.pid) !== providerPid ||
    optionalInt(payload.pgid) !== providerPgid ||
    payloadStartKey !== providerStartKey ||
    liveStartKey !== providerStartKey
  ) {
    return false;
  }
  if (inspector.getpgid(holder) !== providerPgid) return false;
  return true;
}

export function stopVerifiedProcessGroup(
  metadata: Record<string, unknown>,
  executionDirectory: string,
  inspector: ProcessInspector,
  graceSec: number,
): boolean {
  if (!identityKillChecksMatch(metadata, executionDirectory, inspector)) return false;
  const providerPid = optionalInt(metadata.provider_pid);
  const providerPgid = optionalInt(metadata.provider_pgid);
  const identityFile = resolveIdentityPath(metadata, executionDirectory);
  if (providerPid === null || providerPgid === null) return false;
  try {
    inspector.killpg(providerPgid, SIGTERM);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
  const deadline = Date.now() + graceSec * 1000;
  while (Date.now() < deadline) {
    if (inspector.probePid(providerPid) === PID_GONE) return true;
    if (inspector.identityLockHolder(identityFile) === null) return true;
    sleepMsSync(50);
  }
  if (!identityKillChecksMatch(metadata, executionDirectory, inspector)) return false;
  try {
    inspector.killpg(providerPgid, SIGKILL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
  return true;
}

export function processMetadataPayload(info: ProcessStartInfo): Record<string, unknown> {
  return {
    hostname: info.hostname,
    boot_id: info.bootId,
    owner_pid: info.ownerPid,
    owner_start_key: info.ownerStartKey,
    provider_pid: info.providerPid,
    provider_pgid: info.providerPgid,
    provider_start_key: info.providerStartKey,
    identity_path: IDENTITY_FILENAME,
    identity_token: info.identityToken,
  };
}

function ownerStateOf(
  metadata: Record<string, unknown>,
  ownerPid: number | null,
  inspector: ProcessInspector,
): string {
  if (ownerPid === null) return "missing";
  const probe = inspector.probePid(ownerPid);
  if (probe === PID_GONE) return "dead";
  if (probe !== PID_PRESENT) return "unverified";
  const storedKey = presentStr(metadata.owner_start_key);
  const currentKey = presentStr(inspector.kernelProcessIdentity(ownerPid));
  if (storedKey === null || currentKey === null) return "unreadable";
  if (storedKey === currentKey) return "alive";
  return "dead";
}

function resolveIdentityPath(metadata: Record<string, unknown>, executionDirectory: string): string {
  const recorded = metadata.identity_path;
  if (typeof recorded === "string" && recorded) {
    return path.isAbsolute(recorded) ? recorded : path.join(executionDirectory, recorded);
  }
  return path.join(executionDirectory, IDENTITY_FILENAME);
}

function optionalInt(value: unknown): number | null {
  if (typeof value === "boolean" || typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

function presentStr(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  return null;
}
