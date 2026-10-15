import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  type SpawnedChild,
  launchChild as launchChildImpl,
  readReadyLine as readReadyLineImpl,
} from "./child.js";
import {
  type EndpointHello,
  type EndpointStatus,
  ServiceEndpointServer,
  queryEndpoint as queryEndpointImpl,
  requestStop as requestStopImpl,
} from "./endpoint.js";
import { ensureRegistryHome } from "./home.js";
import {
  CORRUPT,
  SERVICE_SCHEMA_VERSION,
  authenticatedInstanceId as authenticatedInstanceIdImpl,
  readService,
  removeServiceJsonIfUnchanged,
  requestLocal,
  serviceJsonPath,
  startLockPath,
  writeServiceJson,
  type ServiceRecord,
} from "./identity.js";
import { StartLockBusy, holdStartLock as holdStartLockImpl } from "./locks.js";
import { RegistryHTTPServer } from "./server.js";
import { RegistryStore, utcTimestamp } from "./store.js";
import { monotonic, sleep } from "./time.js";

const SECRET = /^[A-Za-z0-9_-]{43}$/;
const READY_KEYS = new Set(["pid", "port", "instance_id", "token"]);

export const START_LOCK_TIMEOUT_SEC = 8;
export const IDENTITY_TIMEOUT_SEC = 5;
export const READY_TIMEOUT_SEC = 5;
export const HEALTH_TIMEOUT_SEC = 5;
export const TERM_GRACE_SEC = 5;
export const KILL_GRACE_SEC = 5;

const UNVERIFIED = "Service identity is unverified.";

export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceError";
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

export interface StopEvent {
  isSet(): boolean;
}

export function beforeServiceJsonPublish(_home: string, _record: ServiceRecord | Record<string, unknown>): void {
  return undefined;
}

export function beforeServiceJsonUnlink(_home: string, _instanceId: string): void | Promise<void> {
  return undefined;
}

function publishServiceJsonImpl(home: string, record: ServiceRecord | Record<string, unknown>): void {
  writeServiceJson(home, record, (directory, payload) => svc.beforeServiceJsonPublish(directory, payload));
}

async function unlinkServiceJsonIfUnchangedImpl(home: string, instanceId: string): Promise<string> {
  return removeServiceJsonIfUnchanged(home, instanceId, (directory, id) => svc.beforeServiceJsonUnlink(directory, id));
}

function pidAliveImpl(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killPidImpl(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** Seams for tests. Production code calls through this object so a test can replace one step. */
export const svc = {
  beforeServiceJsonPublish,
  beforeServiceJsonUnlink,
  publishServiceJson: publishServiceJsonImpl,
  unlinkServiceJsonIfUnchanged: unlinkServiceJsonIfUnchangedImpl,
  holdStartLock: holdStartLockImpl,
  acquireServiceLock: ServiceEndpointServer.listen,
  launchChild: launchChildImpl,
  readReadyLine: readReadyLineImpl,
  authenticatedInstanceId: authenticatedInstanceIdImpl,
  queryEndpoint: queryEndpointImpl,
  requestStop: requestStopImpl,
  pidAlive: pidAliveImpl,
  killPid: killPidImpl,
};

export function publishServiceJson(home: string, record: ServiceRecord | Record<string, unknown>): void {
  svc.publishServiceJson(home, record);
}

export function unlinkServiceJsonIfUnchanged(home: string, instanceId: string): Promise<string> {
  return Promise.resolve(svc.unlinkServiceJsonIfUnchanged(home, instanceId));
}

export function holdStartLock<T>(home: string, timeoutSec: number, body: () => Promise<T> | T): Promise<T> {
  return svc.holdStartLock(home, timeoutSec, body);
}

export function launchChild(home: string, port: number): Promise<SpawnedChild> {
  return svc.launchChild(home, port);
}

export function authenticatedInstanceId(port: number, token: string, timeoutSec: number): Promise<string | null> {
  return svc.authenticatedInstanceId(port, token, timeoutSec);
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

function names(status: EndpointStatus, record: ServiceRecord): status is { state: "alive"; hello: EndpointHello } {
  return status.state === "alive" && status.hello.instance_id === record.instance_id && status.hello.pid === record.pid;
}

function isLegacy(record: ServiceRecord): boolean {
  return record.schema_version !== SERVICE_SCHEMA_VERSION;
}

function legacyMessage(record: ServiceRecord): string {
  return (
    `A registry service started by Migent 0.1 may still be running as pid ${record.pid}. ` +
    "Stop it with that version or end the process, then retry."
  );
}

export async function serviceStatus(home: string): Promise<Record<string, unknown>> {
  const loaded = readService(home);
  if (!loaded || loaded === CORRUPT || isLegacy(loaded)) return { state: "stopped" };
  if (!names(await svc.queryEndpoint(home, 1), loaded)) return { state: "stopped" };
  const found = await svc.authenticatedInstanceId(loaded.port, loaded.token, 2);
  if (found !== loaded.instance_id) return { state: "stopped" };
  return { state: "running", host: loaded.host, port: loaded.port, pid: loaded.pid };
}

export async function startDetached(
  home: string,
  port = 47321,
  options: {
    startLockTimeout?: number;
    readyTimeout?: number;
    healthTimeout?: number;
    identityTimeout?: number;
    termGraceSec?: number;
    killGraceSec?: number;
  } = {},
): Promise<ServiceEndpoint> {
  const directory = ensureRegistryHome(home);
  try {
    return await svc.holdStartLock(directory, options.startLockTimeout ?? START_LOCK_TIMEOUT_SEC, async () => {
      const decision = await decide(directory, options.identityTimeout ?? IDENTITY_TIMEOUT_SEC);
      if (decision.kind === "adopt") return decision.endpoint;
      if (decision.kind === "error") throw new ServiceError(decision.message);
      return spawnAndPublish(directory, port, {
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
    startLockTimeout?: number;
    identityTimeout?: number;
    stopEvent?: StopEvent | null;
  } = {},
): Promise<ServiceEndpoint> {
  const directory = ensureRegistryHome(home);
  const stopRequested = { flag: false };
  let server: RegistryHTTPServer | null = null;
  let lifetime: ServiceEndpointServer | null = null;
  let endpoint: ServiceEndpoint;
  try {
    endpoint = await svc.holdStartLock(directory, options.startLockTimeout ?? START_LOCK_TIMEOUT_SEC, async () => {
      const decision = await decide(directory, options.identityTimeout ?? IDENTITY_TIMEOUT_SEC);
      if (decision.kind === "adopt") return decision.endpoint;
      if (decision.kind === "error") throw new ServiceError(decision.message);
      const instanceId = randomBytes(32).toString("base64url");
      const token = randomBytes(32).toString("base64url");
      lifetime = await svc.acquireServiceLock(directory, { instance_id: instanceId, pid: process.pid }, token, () => {
        stopRequested.flag = true;
        server?.close();
      });
      if (lifetime === null) throw new ServiceError("Another registry service holds the service endpoint.");
      try {
        server = await RegistryHTTPServer.open(new RegistryStore(directory), token, instanceId, "127.0.0.1", port);
        const record = recordFor(instanceId, token, server.port);
        svc.publishServiceJson(directory, record);
        return endpointFrom(record);
      } catch (error) {
        server?.close();
        server = null;
        lifetime.close();
        lifetime = null;
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof StartLockBusy) throw new ServiceError(error.message);
    throw error;
  }
  if (!server || !lifetime) return endpoint;
  process.stderr.write(`${endpoint.host}:${endpoint.port}\n`);
  await serveUntilSignal(server, lifetime, options.stopEvent ?? null, stopRequested);
  return endpoint;
}

export async function stop(
  home: string,
  termGraceSec = TERM_GRACE_SEC,
  killGraceSec = KILL_GRACE_SEC,
  options: { startLockTimeout?: number } = {},
): Promise<StopResult> {
  const directory = ensureRegistryHome(home);
  try {
    return await svc.holdStartLock(directory, options.startLockTimeout ?? START_LOCK_TIMEOUT_SEC, () =>
      stopLocked(directory, termGraceSec, killGraceSec),
    );
  } catch (error) {
    if (error instanceof StartLockBusy) return new StopResult("error", error.message);
    throw error;
  }
}

export async function serveUntilSignal(
  server: RegistryHTTPServer,
  lifetime: ServiceEndpointServer,
  stopEvent: StopEvent | null = null,
  stopRequested: { flag: boolean } = { flag: false },
): Promise<void> {
  const onSignal = (): void => {
    stopRequested.flag = true;
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
  const stopping = (): boolean => stopRequested.flag || (stopEvent?.isSet() ?? false);
  try {
    server.timeout = 0.2;
    while (!stopping()) {
      try {
        await server.handleRequest();
      } catch (error) {
        if (stopping()) break;
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
    lifetime.close();
  }
}

type Decision =
  | { kind: "adopt"; endpoint: ServiceEndpoint }
  | { kind: "error"; message: string }
  | { kind: "serve" };

async function decide(home: string, identityTimeout: number): Promise<Decision> {
  const deadline = monotonic() + identityTimeout;
  for (;;) {
    const remaining = Math.max(0.05, deadline - monotonic());
    const loaded = readService(home);
    const status = await svc.queryEndpoint(home, Math.min(1, remaining));
    if (status.state === "gone") {
      if (loaded && loaded !== CORRUPT && isLegacy(loaded) && svc.pidAlive(loaded.pid)) {
        return { kind: "error", message: legacyMessage(loaded) };
      }
      return { kind: "serve" };
    }
    if (loaded && loaded !== CORRUPT && names(status, loaded)) {
      const found = await svc.authenticatedInstanceId(loaded.port, loaded.token, Math.min(0.5, remaining));
      if (found === loaded.instance_id) return { kind: "adopt", endpoint: endpointFrom(loaded) };
    }
    if (monotonic() >= deadline) return { kind: "error", message: UNVERIFIED };
    await sleep(Math.min(0.05, Math.max(0, deadline - monotonic())));
  }
}

async function spawnAndPublish(
  home: string,
  port: number,
  limits: { readyTimeout: number; healthTimeout: number; termGraceSec: number; killGraceSec: number },
): Promise<ServiceEndpoint> {
  const proc = await svc.launchChild(home, port);
  let published: ServiceRecord | null = null;
  let outcome: ServiceEndpoint | null = null;
  let error: unknown = null;
  try {
    const payload = await svc.readReadyLine(proc, monotonic() + limits.readyTimeout);
    const ready = validateReady(payload, proc.pid, port);
    if (!ready) {
      throw new ServiceError(`Registry service did not become ready. See ${path.join(home, "service.log")}.`);
    }
    const record = recordFor(ready.instance_id, ready.token, ready.port, ready.pid);
    svc.publishServiceJson(home, record);
    published = record;
    if (!proc.acknowledge()) throw new ServiceError("Registry service did not become ready.");
    if (!(await waitUntilHealthy(home, record, monotonic() + limits.healthTimeout))) {
      throw new ServiceError("Registry service did not become ready.");
    }
    outcome = endpointFrom(record);
  } catch (caught) {
    error = caught;
  } finally {
    if (outcome === null) {
      // The handle is our own child, so signals cannot reach a reused pid.
      const gone = await stopSpawnedChild(proc, limits.termGraceSec, limits.killGraceSec);
      if (published && gone) {
        try {
          await svc.unlinkServiceJsonIfUnchanged(home, published.instance_id);
        } catch (unlinkError) {
          if (error === null) error = unlinkError;
        }
      }
    }
    proc.release();
  }
  if (error) throw error;
  if (!outcome) throw new ServiceError("The process is still alive.");
  return outcome;
}

async function waitUntilHealthy(home: string, record: ServiceRecord, deadline: number): Promise<boolean> {
  for (;;) {
    const listening = names(await svc.queryEndpoint(home, 0.5), record);
    const found = listening ? await svc.authenticatedInstanceId(record.port, record.token, 0.5) : null;
    if (found === record.instance_id) {
      const onDisk = readService(home);
      if (onDisk && onDisk !== CORRUPT && onDisk.instance_id === record.instance_id) return true;
    }
    if (monotonic() >= deadline) return false;
    await sleep(Math.min(0.05, Math.max(0, deadline - monotonic())));
  }
}

async function stopSpawnedChild(proc: SpawnedChild, termGraceSec: number, killGraceSec: number): Promise<boolean> {
  if (proc.returncode !== null) return true;
  proc.kill("SIGTERM");
  await proc.wait(termGraceSec);
  if (proc.returncode !== null) return true;
  proc.kill("SIGKILL");
  await proc.wait(killGraceSec);
  return proc.returncode !== null;
}

async function stopLocked(home: string, termGraceSec: number, killGraceSec: number): Promise<StopResult> {
  const loaded = readService(home);
  if (loaded === null) return new StopResult("absent");
  if (loaded === CORRUPT) return new StopResult("error", "service.json is corrupt.");
  const record = loaded;
  if (isLegacy(record)) {
    if (svc.pidAlive(record.pid)) return new StopResult("error", legacyMessage(record));
    return unlinkConfirmed(home, record);
  }
  const status = await svc.queryEndpoint(home, 1);
  if (status.state === "gone") return unlinkConfirmed(home, record);
  if (!names(status, record)) return new StopResult("error", UNVERIFIED);
  if (await svc.requestStop(home, record.instance_id, record.token, 1)) {
    if (await pollGone(home, termGraceSec)) return unlinkConfirmed(home, record);
  }
  // Kill only the pid the live endpoint itself reports for this instance.
  const again = await svc.queryEndpoint(home, 1);
  if (again.state === "gone") return unlinkConfirmed(home, record);
  if (!names(again, record)) return new StopResult("error", UNVERIFIED);
  svc.killPid(again.hello.pid);
  if (await pollGone(home, killGraceSec)) return unlinkConfirmed(home, record);
  return new StopResult("error", "The process is still alive.");
}

async function pollGone(home: string, grace: number): Promise<boolean> {
  const deadline = monotonic() + grace;
  for (;;) {
    const remaining = deadline - monotonic();
    if ((await svc.queryEndpoint(home, Math.max(0.05, Math.min(0.5, remaining)))).state === "gone") return true;
    if (deadline - monotonic() <= 0) return false;
    await sleep(Math.min(0.05, Math.max(0, deadline - monotonic())));
  }
}

async function unlinkConfirmed(home: string, record: ServiceRecord): Promise<StopResult> {
  const result = await svc.unlinkServiceJsonIfUnchanged(home, record.instance_id);
  if (result === "removed" || result === "absent" || result === "changed") return new StopResult("stopped");
  return new StopResult("error", "service.json changed before it could be removed.");
}

function recordFor(instanceId: string, token: string, port: number, pid = process.pid): ServiceRecord {
  return {
    schema_version: SERVICE_SCHEMA_VERSION,
    instance_id: instanceId,
    pid,
    host: "127.0.0.1",
    port,
    token,
    started_at: utcTimestamp(),
  };
}

interface ReadyLine {
  pid: number;
  port: number;
  instance_id: string;
  token: string;
}

function validateReady(payload: Record<string, unknown> | null, procPid: number, requestedPort: number): ReadyLine | null {
  if (payload === null) return null;
  if (new Set(Object.keys(payload)).size !== READY_KEYS.size || ![...READY_KEYS].every((key) => Object.hasOwn(payload, key))) {
    return null;
  }
  const { pid, port, instance_id: instanceId, token } = payload;
  if (typeof pid !== "number" || pid !== procPid) return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (requestedPort !== 0 && port !== requestedPort) return null;
  if (typeof instanceId !== "string" || !SECRET.test(instanceId)) return null;
  if (typeof token !== "string" || !SECRET.test(token)) return null;
  return { pid, port, instance_id: instanceId, token };
}

function endpointFrom(record: ServiceRecord): ServiceEndpoint {
  return new ServiceEndpoint(record.host, record.port, record.token, record.instance_id, record.pid);
}

export { CORRUPT, readService, serviceJsonPath, startLockPath, writeServiceJson };
