import { randomBytes } from "node:crypto";
import { closeSync } from "node:fs";
import { constants as osConstants, hostname as osHostname } from "node:os";
import { currentBootId, identityLockHolder, kernelProcessIdentity as kernelIdentity } from "@nodeint/migent-kernel";
import {
  type SpawnedChild,
  launchChild as launchChildImpl,
  readReadyLine as readReadyLineImpl,
  writeFd,
} from "./child.js";
import { ensureRegistryHome } from "./home.js";
import {
  CORRUPT,
  LiveInspector,
  acquireServiceLock as acquireServiceLockImpl,
  authenticatedInstanceId as authenticatedInstanceIdImpl,
  readService,
  recordIsConfirmedGone,
  removeServiceJsonIfUnchanged,
  requestLocal,
  serviceIdentityMatches as serviceIdentityMatchesImpl,
  serviceJsonPath,
  serviceLockPath,
  startLockPath,
  writeServiceJson,
  type IdentityInspector,
  type ServiceRecord,
} from "./identity.js";
import { StartLockBusy, holdStartLock as holdStartLockImpl } from "./locks.js";
import { posixGetpgid } from "./posix.js";
import { RegistryHTTPServer } from "./server.js";
import { RegistryStore, utcTimestamp } from "./store.js";
import { monotonic, sleep } from "./time.js";

const ACK = Buffer.from("published\n");
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const READY_KEYS = new Set(["pid", "port", "instance_id", "token"]);

export const START_LOCK_TIMEOUT_SEC = 8;
export const IDENTITY_TIMEOUT_SEC = 5;
export const READY_TIMEOUT_SEC = 5;
export const HEALTH_TIMEOUT_SEC = 5;
export const TERM_GRACE_SEC = 5;
export const KILL_GRACE_SEC = 5;

export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceError";
  }
}

export class SignalBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignalBackendError";
  }
}

export class ServiceEndpoint {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly instanceId: string;
  readonly pid: number;

  constructor(host: string, port: number, token: string, instanceId: string, pid: number) {
    this.host = host;
    this.port = port;
    this.token = token;
    this.instanceId = instanceId;
    this.pid = pid;
  }
}

export class StopResult {
  readonly outcome: string;
  readonly message: string;

  constructor(outcome: string, message = "") {
    this.outcome = outcome;
    this.message = message;
  }
}

export interface SignalBackend {
  supported(): boolean;
  open(pid: number): number;
  send(pidfd: number, sig: number): void;
  close(fd: number): void;
  kill(pid: number, sig: number): void;
}

export interface StopEvent {
  isSet(): boolean;
}

export class LiveSignalBackend implements SignalBackend {
  private readonly openImpl: ((pid: number) => number) | null = null;
  private readonly sendImpl: ((pidfd: number, sig: number) => void) | null = null;

  supported(): boolean {
    return this.openImpl !== null && this.sendImpl !== null;
  }

  open(pid: number): number {
    if (!this.openImpl) {
      const error = new Error("pidfd_open") as NodeJS.ErrnoException;
      error.errno = osConstants.errno.ENOSYS;
      throw error;
    }
    return this.openImpl(pid);
  }

  send(pidfd: number, sig: number): void {
    if (!this.sendImpl) {
      const error = new Error("pidfd_send_signal") as NodeJS.ErrnoException;
      error.errno = osConstants.errno.ENOSYS;
      throw error;
    }
    this.sendImpl(pidfd, sig);
  }

  close(fd: number): void {
    closeSync(fd);
  }

  kill(pid: number, sig: number): void {
    process.kill(pid, sig);
  }
}

export function beforeServiceJsonPublish(_home: string, _record: ServiceRecord | Record<string, unknown>): void {
  return undefined;
}

export function beforeServiceJsonUnlink(
  _home: string,
  _instanceId: string,
  _pid: number,
  _startKey: string,
): void | Promise<void> {
  return undefined;
}

function publishServiceJsonImpl(home: string, record: ServiceRecord | Record<string, unknown>): void {
  writeServiceJson(home, record, (directory, payload) => svc.beforeServiceJsonPublish(directory, payload));
}

async function unlinkServiceJsonIfUnchangedImpl(
  home: string,
  instanceId: string,
  pid: number,
  startKey: string,
): Promise<string> {
  return removeServiceJsonIfUnchanged(home, instanceId, pid, startKey, (directory, id, processId, key) =>
    svc.beforeServiceJsonUnlink(directory, id, processId, key),
  );
}

export const svc = {
  beforeServiceJsonPublish,
  beforeServiceJsonUnlink,
  publishServiceJson: publishServiceJsonImpl,
  unlinkServiceJsonIfUnchanged: unlinkServiceJsonIfUnchangedImpl,
  holdStartLock: holdStartLockImpl,
  acquireServiceLock: acquireServiceLockImpl,
  launchChild: launchChildImpl,
  readReadyLine: readReadyLineImpl,
  kernelProcessIdentity: kernelIdentity,
  authenticatedInstanceId: authenticatedInstanceIdImpl,
  serviceIdentityMatches: serviceIdentityMatchesImpl,
};

export function publishServiceJson(home: string, record: ServiceRecord | Record<string, unknown>): void {
  svc.publishServiceJson(home, record);
}

export function unlinkServiceJsonIfUnchanged(
  home: string,
  instanceId: string,
  pid: number,
  startKey: string,
): Promise<string> {
  return Promise.resolve(svc.unlinkServiceJsonIfUnchanged(home, instanceId, pid, startKey));
}

export function holdStartLock<T>(home: string, timeoutSec: number, body: () => Promise<T> | T): Promise<T> {
  return svc.holdStartLock(home, timeoutSec, body);
}

export function acquireServiceLock(home: string): Promise<number | null> {
  return svc.acquireServiceLock(home);
}

export function launchChild(home: string, port: number): Promise<[SpawnedChild, number]> {
  return svc.launchChild(home, port);
}

export function readReadyLine(source: number | { fd?: number }, deadline: number): Promise<Buffer | null> {
  return svc.readReadyLine(source, deadline);
}

export function kernelProcessIdentity(pid: number): string | null {
  return svc.kernelProcessIdentity(pid);
}

export function authenticatedInstanceId(port: number, token: string, timeoutSec: number): Promise<string | null> {
  return svc.authenticatedInstanceId(port, token, timeoutSec);
}

export function serviceIdentityMatches(
  record: ServiceRecord | Record<string, unknown>,
  inspector: IdentityInspector,
  lockPath: string,
): boolean {
  return svc.serviceIdentityMatches(record, inspector, lockPath);
}

export function endpointFromHome(home: string): ServiceEndpoint | null {
  const loaded = readService(home);
  if (!loaded || loaded === CORRUPT) return null;
  return new ServiceEndpoint(loaded.host, loaded.port, loaded.token, loaded.instance_id, loaded.pid);
}

export async function callService(
  host: string,
  port: number,
  token: string,
  method: string,
  requestPath: string,
  body: Record<string, unknown> | null = null,
  timeout = 5,
): Promise<[number, Record<string, unknown>]> {
  void host;
  const data = body === null ? null : Buffer.from(JSON.stringify(body));
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Connection: "close",
  };
  if (data) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(data.length);
  }
  const response = await requestLocal(port, method, requestPath, headers, data, timeout);
  let payload: unknown;
  try {
    payload = JSON.parse(response.raw.toString("utf8"));
  } catch {
    payload = {};
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) payload = {};
  return [response.status, payload as Record<string, unknown>];
}

export async function serviceStatus(
  home: string,
  inspector?: IdentityInspector | null,
): Promise<Record<string, unknown>> {
  const loaded = readService(home);
  if (!loaded || loaded === CORRUPT) return { state: "stopped" };
  const checker = inspector ?? new LiveInspector();
  if (!svc.serviceIdentityMatches(loaded, checker, serviceLockPath(home))) return { state: "stopped" };
  const found = await svc.authenticatedInstanceId(loaded.port, loaded.token, 2);
  if (found !== loaded.instance_id) return { state: "stopped" };
  return { state: "running", host: loaded.host, port: loaded.port, pid: loaded.pid };
}

export async function startDetached(
  home: string,
  port = 47321,
  options: {
    inspector?: IdentityInspector | null;
    backend?: SignalBackend | null;
    startLockTimeout?: number;
    readyTimeout?: number;
    healthTimeout?: number;
    identityTimeout?: number;
    termGraceSec?: number;
    killGraceSec?: number;
  } = {},
): Promise<ServiceEndpoint> {
  const directory = ensureRegistryHome(home);
  const checker = options.inspector ?? new LiveInspector();
  const signalBackend = options.backend ?? new LiveSignalBackend();
  try {
    return await svc.holdStartLock(directory, options.startLockTimeout ?? START_LOCK_TIMEOUT_SEC, async () => {
      const decision = await decide(directory, checker, options.identityTimeout ?? IDENTITY_TIMEOUT_SEC);
      if (decision.kind === "adopt") return decision.endpoint;
      if (decision.kind === "error") throw new ServiceError(decision.message);
      return spawnAndPublish(directory, port, signalBackend, {
        readyTimeout: options.readyTimeout ?? READY_TIMEOUT_SEC,
        healthTimeout: options.healthTimeout ?? HEALTH_TIMEOUT_SEC,
        termGraceSec: options.termGraceSec ?? TERM_GRACE_SEC,
        killGraceSec: options.killGraceSec ?? KILL_GRACE_SEC,
      });
    });
  } catch (error) {
    if (error instanceof StartLockBusy) throw new ServiceError(error.message);
    throw error;
  }
}

export async function serveForeground(
  home: string,
  port = 47321,
  options: {
    inspector?: IdentityInspector | null;
    startLockTimeout?: number;
    identityTimeout?: number;
    stopEvent?: StopEvent | null;
  } = {},
): Promise<ServiceEndpoint> {
  const directory = ensureRegistryHome(home);
  const checker = options.inspector ?? new LiveInspector();
  let server: RegistryHTTPServer | null = null;
  let lockFd: number | null = null;
  let endpoint: ServiceEndpoint;
  try {
    endpoint = await svc.holdStartLock(directory, options.startLockTimeout ?? START_LOCK_TIMEOUT_SEC, async () => {
      const decision = await decide(directory, checker, options.identityTimeout ?? IDENTITY_TIMEOUT_SEC);
      if (decision.kind === "adopt") return decision.endpoint;
      if (decision.kind === "error") throw new ServiceError(decision.message);
      lockFd = await svc.acquireServiceLock(directory);
      if (lockFd === null) throw new ServiceError("service.lock is held.");
      try {
        const listening = await listeningServer(directory, port);
        server = listening.server;
        svc.publishServiceJson(directory, recordFromEndpoint(listening.endpoint));
        return listening.endpoint;
      } catch (error) {
        server?.close();
        server = null;
        if (lockFd !== null) closeQuiet(lockFd);
        lockFd = null;
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof StartLockBusy) throw new ServiceError(error.message);
    throw error;
  }
  if (!server || lockFd === null) return endpoint;
  process.stderr.write(`${endpoint.host}:${endpoint.port}\n`);
  await serveUntilSignal(server, lockFd, options.stopEvent ?? null);
  return endpoint;
}

export async function stop(
  home: string,
  termGraceSec = TERM_GRACE_SEC,
  killGraceSec = KILL_GRACE_SEC,
  options: {
    inspector?: IdentityInspector | null;
    backend?: SignalBackend | null;
    startLockTimeout?: number;
  } = {},
): Promise<StopResult> {
  const directory = ensureRegistryHome(home);
  const checker = options.inspector ?? new LiveInspector();
  const signalBackend = options.backend ?? new LiveSignalBackend();
  try {
    return await svc.holdStartLock(directory, options.startLockTimeout ?? START_LOCK_TIMEOUT_SEC, () =>
      stopLocked(directory, checker, signalBackend, termGraceSec, killGraceSec),
    );
  } catch (error) {
    if (error instanceof StartLockBusy) return new StopResult("error", error.message);
    throw error;
  }
}

export async function serveUntilSignal(
  server: RegistryHTTPServer,
  lockFd: number,
  stopEvent: StopEvent | null = null,
): Promise<void> {
  const stop = { flag: false };
  const onSignal = (): void => {
    stop.flag = true;
    try {
      server.close();
    } catch {
      // already closed
    }
  };
  const install = stopEvent === null;
  if (install) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
  try {
    server.timeout = 0.2;
    while (!stop.flag && !(stopEvent?.isSet() ?? false)) {
      try {
        await server.handleRequest();
      } catch (error) {
        if (stop.flag || (stopEvent?.isSet() ?? false)) break;
        if ((error as NodeJS.ErrnoException).code === "EINTR") continue;
        throw error;
      }
    }
  } finally {
    if (install) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
    server.close();
    if (lockFd >= 0) closeQuiet(lockFd);
  }
}

export function signalVerifiedPid(pid: number, sig: number, stillMatches: () => boolean, backend: SignalBackend): void {
  if (!backend.supported()) {
    killIfStill(pid, sig, stillMatches, backend);
    return;
  }
  let pidfd = -1;
  try {
    try {
      pidfd = backend.open(pid);
    } catch (error) {
      const errno = errnoOf(error);
      if (errno === osConstants.errno.ENOSYS) {
        killIfStill(pid, sig, stillMatches, backend);
        return;
      }
      if (errno === osConstants.errno.ESRCH) return;
      throw new SignalBackendError(`pidfd_open failed with errno ${errno ?? "unknown"}.`);
    }
    if (!stillMatches()) return;
    try {
      backend.send(pidfd, sig);
    } catch (error) {
      const errno = errnoOf(error);
      if (errno === osConstants.errno.ENOSYS) {
        backend.close(pidfd);
        pidfd = -1;
        killIfStill(pid, sig, stillMatches, backend);
        return;
      }
      throw new SignalBackendError(`pidfd_send_signal failed with errno ${errno ?? "unknown"}.`);
    }
  } finally {
    if (pidfd >= 0) backend.close(pidfd);
  }
}

function killIfStill(pid: number, sig: number, stillMatches: () => boolean, backend: SignalBackend): void {
  if (!stillMatches()) return;
  try {
    backend.kill(pid, sig);
  } catch (error) {
    if (isEsrch(error)) return;
    throw error;
  }
}

type Decision =
  | { kind: "adopt"; endpoint: ServiceEndpoint }
  | { kind: "error"; message: string }
  | { kind: "serve" };

async function decide(home: string, inspector: IdentityInspector, identityTimeout: number): Promise<Decision> {
  const lockPath = serviceLockPath(home);
  const holder = inspector.lockHolder(lockPath);
  if (holder !== null) {
    const deadline = monotonic() + identityTimeout;
    for (;;) {
      const loaded = readService(home);
      if (loaded && loaded !== CORRUPT && svc.serviceIdentityMatches(loaded, inspector, lockPath)) {
        const remaining = Math.max(0.05, deadline - monotonic());
        const found = await svc.authenticatedInstanceId(Number(loaded.port), String(loaded.token), Math.min(0.5, remaining));
        if (found === loaded.instance_id) return { kind: "adopt", endpoint: endpointFrom(loaded) };
      }
      if (monotonic() >= deadline) return { kind: "error", message: "Service identity is unverified." };
      await sleep(Math.min(0.05, Math.max(0, deadline - monotonic())));
    }
  }
  const loaded = readService(home);
  if (
    loaded === null ||
    loaded === CORRUPT ||
    (loaded !== null && recordIsConfirmedGone(loaded, inspector, lockPath))
  ) {
    return { kind: "serve" };
  }
  if (aliveWithoutLock(loaded, inspector, lockPath)) {
    return { kind: "error", message: "Service process is alive but does not hold service.lock." };
  }
  return { kind: "error", message: "Service identity is unverified." };
}

function aliveWithoutLock(record: ServiceRecord, inspector: IdentityInspector, lockPath: string): boolean {
  const pid = record.pid;
  if (typeof pid !== "number" || !inspector.pidAlive(pid)) return false;
  const start = inspector.kernelProcessIdentity(pid);
  const boot = inspector.bootId();
  if (!start || start !== record.start_key) return false;
  if (!boot || boot !== record.boot_id) return false;
  return inspector.lockHolder(lockPath) !== pid;
}

async function spawnAndPublish(
  home: string,
  port: number,
  backend: SignalBackend,
  limits: { readyTimeout: number; healthTimeout: number; termGraceSec: number; killGraceSec: number },
): Promise<ServiceEndpoint> {
  const [proc, parent] = await svc.launchChild(home, port);
  const measured = measureChild(proc.pid);
  let published: ServiceRecord | null = null;
  let outcome: ServiceEndpoint | null = null;
  let error: unknown = null;
  try {
    try {
      const line = await svc.readReadyLine(parent, monotonic() + limits.readyTimeout);
      const ready = validateReady(line, proc.pid, port, measured);
      if (!ready || !measured) throw new ServiceError("Registry service did not become ready.");
      const record = serviceRecord(measured, ready);
      svc.publishServiceJson(home, record);
      published = record;
      if (!writeFd(parent, ACK)) throw new ServiceError("Registry service did not become ready.");
      if (!(await waitUntilHealthy(home, record, monotonic() + limits.healthTimeout))) {
        throw new ServiceError("Registry service did not become ready.");
      }
      outcome = endpointFrom(record);
      proc.returncode = 0;
    } catch (caught) {
      error = caught;
    }
  } finally {
    if (outcome === null) {
      let gone = false;
      try {
        gone = await stopSpawnedChild(home, proc, measured, backend, limits.termGraceSec, limits.killGraceSec);
      } catch {
        gone = false;
      }
      if (published && gone) {
        try {
          await svc.unlinkServiceJsonIfUnchanged(home, published.instance_id, published.pid, published.start_key);
        } catch (unlinkError) {
          if (error === null) error = unlinkError;
        }
      }
    }
    closeQuiet(parent);
    if (proc.returncode === null) await proc.wait(limits.killGraceSec);
  }
  if (error) throw error;
  if (!outcome) throw new ServiceError("The process is still alive.");
  return outcome;
}

async function waitUntilHealthy(home: string, record: ServiceRecord, deadline: number): Promise<boolean> {
  const inspector = new LiveInspector();
  for (;;) {
    const holder = identityLockHolder(serviceLockPath(home));
    const matches = svc.serviceIdentityMatches(record, inspector, serviceLockPath(home));
    const found = await svc.authenticatedInstanceId(record.port, record.token, 0.5);
    if (holder === record.pid && matches && found === record.instance_id) {
      const onDisk = readService(home);
      if (onDisk && onDisk !== CORRUPT && onDisk.instance_id === record.instance_id) return true;
    }
    if (monotonic() >= deadline) return false;
    await sleep(Math.min(0.05, Math.max(0, deadline - monotonic())));
  }
}

async function stopSpawnedChild(
  home: string,
  proc: SpawnedChild,
  measured: Measured | null,
  backend: SignalBackend,
  termGraceSec: number,
  killGraceSec: number,
): Promise<boolean> {
  if (!measured?.start_key) return false;
  const pid = measured.pid;
  const startKey = measured.start_key;
  const record = {
    pid,
    start_key: startKey,
    boot_id: measured.boot_id || "",
    pgid: measured.pgid,
    hostname: measured.hostname || "",
  };
  const still = (): boolean => {
    const ident = svc.kernelProcessIdentity(pid);
    return Boolean(ident) && ident === startKey;
  };
  const lockPath = serviceLockPath(home);
  try {
    signalVerifiedPid(pid, osConstants.signals.SIGTERM, still, backend);
  } catch (error) {
    if (!(error instanceof SignalBackendError)) throw error;
  }
  if (await waitGone(lockPath, record, termGraceSec)) {
    await proc.wait(0.2);
    return true;
  }
  try {
    signalVerifiedPid(pid, osConstants.signals.SIGKILL, still, backend);
  } catch (error) {
    if (error instanceof SignalBackendError) {
      await proc.wait(0.2);
      return waitGone(lockPath, record, 0);
    }
    throw error;
  }
  const gone = await waitGone(lockPath, record, killGraceSec);
  await proc.wait(0.2);
  return gone;
}

async function waitGone(lockPath: string, record: Record<string, unknown>, grace: number): Promise<boolean> {
  const inspector = new LiveInspector();
  const deadline = monotonic() + grace;
  for (;;) {
    if (recordIsConfirmedGone(record, inspector, lockPath)) return true;
    if (monotonic() >= deadline) return false;
    await sleep(Math.min(0.05, Math.max(0, deadline - monotonic())));
  }
}

async function stopLocked(
  home: string,
  inspector: IdentityInspector,
  backend: SignalBackend,
  termGraceSec: number,
  killGraceSec: number,
): Promise<StopResult> {
  const loaded = readService(home);
  if (loaded === null) return new StopResult("absent");
  if (loaded === CORRUPT) return new StopResult("error", "service.json is corrupt.");
  const record = loaded;
  const lockPath = serviceLockPath(home);
  if (!svc.serviceIdentityMatches(record, inspector, lockPath)) {
    if (recordIsConfirmedGone(record, inspector, lockPath)) return unlinkConfirmed(home, record);
    return new StopResult("error", "Service identity is unverified.");
  }
  const still = (): boolean => svc.serviceIdentityMatches(record, inspector, lockPath);
  try {
    signalVerifiedPid(record.pid, osConstants.signals.SIGTERM, still, backend);
  } catch (error) {
    if (error instanceof SignalBackendError) {
      if (recordIsConfirmedGone(record, inspector, lockPath)) return unlinkConfirmed(home, record);
      return new StopResult("error", error.message);
    }
    throw error;
  }
  if (await pollGone(record, inspector, lockPath, termGraceSec)) return unlinkConfirmed(home, record);
  try {
    signalVerifiedPid(record.pid, osConstants.signals.SIGKILL, still, backend);
  } catch (error) {
    if (error instanceof SignalBackendError) {
      if (recordIsConfirmedGone(record, inspector, lockPath)) return unlinkConfirmed(home, record);
      return new StopResult("error", error.message);
    }
    throw error;
  }
  if (await pollGone(record, inspector, lockPath, killGraceSec)) return unlinkConfirmed(home, record);
  return new StopResult("error", "The process is still alive.");
}

async function pollGone(
  record: ServiceRecord,
  inspector: IdentityInspector,
  lockPath: string,
  grace: number,
): Promise<boolean> {
  const deadline = monotonic() + grace;
  for (;;) {
    if (recordIsConfirmedGone(record, inspector, lockPath)) return true;
    const remaining = deadline - monotonic();
    if (remaining <= 0) return false;
    await sleep(Math.min(0.05, remaining));
  }
}

async function unlinkConfirmed(home: string, record: ServiceRecord): Promise<StopResult> {
  const result = await svc.unlinkServiceJsonIfUnchanged(home, record.instance_id, record.pid, record.start_key);
  if (result === "removed" || result === "absent" || result === "changed") return new StopResult("stopped");
  return new StopResult("error", "service.json changed before it could be removed.");
}

async function listeningServer(
  home: string,
  port: number,
): Promise<{ server: RegistryHTTPServer; endpoint: ServiceEndpoint }> {
  const instanceId = randomBytes(32).toString("base64url");
  const token = randomBytes(32).toString("base64url");
  let server: RegistryHTTPServer | null = null;
  try {
    server = await RegistryHTTPServer.open(new RegistryStore(home), token, instanceId, "127.0.0.1", port);
    const endpoint = selfEndpoint(server.port, instanceId, token);
    if (!endpoint) throw new ServiceError("Process identity is unavailable.");
    return { server, endpoint };
  } catch (error) {
    server?.close();
    throw error;
  }
}

function selfEndpoint(port: number, instanceId: string, token: string): ServiceEndpoint | null {
  const startKey = svc.kernelProcessIdentity(process.pid);
  const bootId = currentBootId();
  if (!startKey || !bootId) return null;
  const pgid = posixGetpgid(process.pid);
  let host: string;
  try {
    host = osHostname();
  } catch {
    return null;
  }
  if (pgid === null || !host) return null;
  return new ServiceEndpoint("127.0.0.1", port, token, instanceId, process.pid);
}

function recordFromEndpoint(endpoint: ServiceEndpoint): ServiceRecord {
  const startKey = svc.kernelProcessIdentity(process.pid);
  const bootId = currentBootId();
  if (!startKey || !bootId) throw new ServiceError("Process identity is unavailable.");
  const pgid = posixGetpgid(process.pid);
  if (pgid === null) throw new ServiceError("Process identity is unavailable.");
  return {
    schema_version: 1,
    instance_id: endpoint.instanceId,
    pid: process.pid,
    pgid,
    start_key: startKey,
    boot_id: bootId,
    hostname: osHostname(),
    host: "127.0.0.1",
    port: endpoint.port,
    token: endpoint.token,
    started_at: utcTimestamp(),
  };
}

interface Measured {
  pid: number;
  pgid: number;
  start_key: string;
  boot_id: string;
  hostname: string;
}

interface ReadyLine {
  pid: number;
  port: number;
  instance_id: string;
  token: string;
}

function serviceRecord(measured: Measured, ready: ReadyLine): ServiceRecord {
  return {
    schema_version: 1,
    instance_id: ready.instance_id,
    pid: measured.pid,
    pgid: measured.pgid,
    start_key: measured.start_key,
    boot_id: measured.boot_id,
    hostname: measured.hostname,
    host: "127.0.0.1",
    port: ready.port,
    token: ready.token,
    started_at: utcTimestamp(),
  };
}

function measureChild(pid: number): Measured | null {
  const pgid = posixGetpgid(pid);
  let host = "";
  try {
    host = osHostname();
  } catch {
    return null;
  }
  const startKey = svc.kernelProcessIdentity(pid);
  const bootId = currentBootId();
  if (pgid === null || !startKey || !bootId || !host) return null;
  return { pid, pgid, start_key: startKey, boot_id: bootId, hostname: host };
}

function validateReady(
  line: Buffer | null,
  procPid: number,
  requestedPort: number,
  measured: Measured | null,
): ReadyLine | null {
  if (line === null || measured === null) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(line.toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (new Set(Object.keys(record)).size !== READY_KEYS.size || ![...READY_KEYS].every((key) => Object.hasOwn(record, key))) {
    return null;
  }
  const pid = record.pid;
  const port = record.port;
  const instanceId = record.instance_id;
  const token = record.token;
  if (typeof pid !== "number" || pid !== procPid) return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (requestedPort !== 0 && port !== requestedPort) return null;
  if (typeof instanceId !== "string" || !SECRET.test(instanceId)) return null;
  if (typeof token !== "string" || !SECRET.test(token)) return null;
  return { pid, port, instance_id: instanceId, token };
}

function endpointFrom(record: ServiceRecord): ServiceEndpoint {
  return new ServiceEndpoint(String(record.host), Number(record.port), String(record.token), String(record.instance_id), Number(record.pid));
}

function closeQuiet(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // already closed
  }
}

function errnoOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const err = error as NodeJS.ErrnoException;
  if (typeof err.errno === "number") return Math.abs(err.errno);
  if (err.code && err.code in osConstants.errno) return osConstants.errno[err.code as keyof typeof osConstants.errno];
  return undefined;
}

function isEsrch(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as NodeJS.ErrnoException;
  return err.code === "ESRCH" || errnoOf(error) === osConstants.errno.ESRCH;
}

export {
  CORRUPT,
  LiveInspector,
  readService,
  recordIsConfirmedGone,
  serviceJsonPath,
  serviceLockPath,
  startLockPath,
  writeServiceJson,
};
