import { hostname as osHostname } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { INT32_BYTES, PROBE_SLACK_MS } from './constants.js';
import { wrapperEndpoint, wrapperEntry } from './process-wrapper.js';

export const PID_PRESENT = 'present';
export const PID_GONE = 'gone';
export const PID_UNVERIFIED = 'unverified';
export const ENDPOINT_ALIVE = 'alive';
export const ENDPOINT_GONE = 'gone';
export const ENDPOINT_UNKNOWN = 'unknown';
export const REAP_STILL_RUNNING = 'still-running';
export const REAP_ALREADY_EXITED = 'already-exited';
export const REAP_UNVERIFIED = 'unverified';
export const REAP_NOOP = 'noop';
export const ERROR_ALREADY_EXITED =
  'Owner process is not running; provider process already exited.';

const ENDPOINT_PROBE_TIMEOUT_MS = 2000;

export type EndpointState = typeof ENDPOINT_ALIVE | typeof ENDPOINT_GONE | typeof ENDPOINT_UNKNOWN;

export interface ProcessStartInfo {
  hostname: string;
  ownerPid: number;
  providerPid: number;
  endpoint: string;
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
  probePid(pid: number): string;
  probeEndpoint(endpoint: string): EndpointState;
}

export class SystemProcessInspector implements ProcessInspector {
  public hostname(): string {
    return osHostname();
  }

  public probePid(pid: number): string {
    return probePid(pid);
  }

  public probeEndpoint(endpoint: string): EndpointState {
    return probeEndpointSync(endpoint, ENDPOINT_PROBE_TIMEOUT_MS);
  }
}

export function probePid(pid: number): string {
  try {
    process.kill(pid, 0);
    return PID_PRESENT;
  } catch (error) {
    const {code} = (error as NodeJS.ErrnoException);
    if (code === 'EPERM') return PID_PRESENT;
    if (code === 'ESRCH') return PID_GONE;
    return PID_UNVERIFIED;
  }
}

/** Result codes the probe worker stores in the shared flag. */
const PROBE_CONNECTED = 1;
const PROBE_REFUSED = 2;
const PROBE_UNKNOWN = 3;

const PROBE_SOURCE = `
const { workerData } = require("node:worker_threads");
const net = require("node:net");
const flag = new Int32Array(workerData.shared);
const done = (value) => {
  Atomics.store(flag, 0, value);
  Atomics.notify(flag, 0);
};
const socket = net.connect(workerData.endpoint);
socket.setTimeout(workerData.timeoutMs, () => {
  socket.destroy();
  done(${PROBE_UNKNOWN});
});
socket.once("connect", () => {
  socket.destroy();
  done(${PROBE_CONNECTED});
});
socket.once("error", (error) => {
  done(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? ${PROBE_REFUSED} : ${PROBE_UNKNOWN});
});
`;

/**
 * Whether a wrapper endpoint accepts connections. Callers are synchronous, so the connect runs
 * on a worker thread while this thread blocks on a shared flag.
 */
export function probeEndpointSync(endpoint: string, timeoutMs: number): EndpointState {
  const shared = new SharedArrayBuffer(INT32_BYTES);
  const flag = new Int32Array(shared);
  const worker = new Worker(PROBE_SOURCE, { eval: true, workerData: { endpoint, timeoutMs, shared } });
  worker.unref();
  try {
    Atomics.wait(flag, 0, 0, timeoutMs + PROBE_SLACK_MS);
  } finally {
    void worker.terminate();
  }
  const result = Atomics.load(flag, 0);
  if (result === PROBE_CONNECTED) return ENDPOINT_ALIVE;
  if (result === PROBE_REFUSED) return ENDPOINT_GONE;
  return ENDPOINT_UNKNOWN;
}

export function wrapperArgv(
  specArgv: readonly string[],
  options: { endpoint: string; graceSec: number; executable?: string },
): string[] {
  return [
    options.executable ?? process.execPath,
    wrapperEntry(),
    '--endpoint',
    options.endpoint,
    '--grace-sec',
    String(options.graceSec),
    '--',
    ...specArgv,
  ];
}

export { wrapperEndpoint };

export function collectProcessStartInfo(providerPid: number, endpoint: string): ProcessStartInfo {
  return {
    hostname: osHostname(),
    ownerPid: process.pid,
    providerPid,
    endpoint,
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

/**
 * Decide what a "running" execution left behind really is. The wrapper stops the provider tree
 * as soon as its owner dies and only then releases its endpoint, so a reachable endpoint means a
 * live execution and a refused one means nothing is left to stop.
 */
export function classifyOrphanedExecution(
  metadata: Record<string, unknown>,
  executionDirectory: string,
  inspector: ProcessInspector,
): ReapDecision {
  const sessionId = metadata.session_id ? String(metadata.session_id) : '';
  const executionId = metadata.execution_id
    ? String(metadata.execution_id)
    : path.basename(executionDirectory);
  if (metadata.status !== 'running') {
    return { action: REAP_NOOP, sessionId, executionId };
  }
  const recordedHost = metadata.hostname;
  if (typeof recordedHost === 'string' && recordedHost !== inspector.hostname()) {
    return { action: REAP_UNVERIFIED, sessionId, executionId };
  }
  const ownerPid = optionalInt(metadata.owner_pid);
  if (ownerPid === null) {
    return { action: REAP_UNVERIFIED, sessionId, executionId, ownerPid };
  }
  const endpoint = presentStr(metadata.provider_endpoint);
  return classifyOwnedExecution(endpoint, inspector, { sessionId, executionId, ownerPid });
}

/** Classifies a running execution whose owner pid is known, by probing its endpoint or owner. */
function classifyOwnedExecution(
  endpoint: string | null,
  inspector: ProcessInspector,
  ids: { sessionId: string; executionId: string; ownerPid: number },
): ReapDecision {
  if (endpoint === null) {
    // Recorded before provider endpoints existed: trust only a vanished owner.
    if (inspector.probePid(ids.ownerPid) !== PID_GONE) return { action: REAP_UNVERIFIED, ...ids };
    return { action: REAP_ALREADY_EXITED, ...ids, error: ERROR_ALREADY_EXITED };
  }
  const state = inspector.probeEndpoint(endpoint);
  if (state === ENDPOINT_ALIVE) return { action: REAP_STILL_RUNNING, ...ids };
  if (state === ENDPOINT_GONE) return { action: REAP_ALREADY_EXITED, ...ids, error: ERROR_ALREADY_EXITED };
  return { action: REAP_UNVERIFIED, ...ids };
}

/** Owner fields recorded when an execution is created, before any provider process exists. */
export function ownerMetadataPayload(
  hostname: string = osHostname(),
  ownerPid: number = process.pid,
): Record<string, unknown> {
  return { hostname, owner_pid: ownerPid };
}

export function processMetadataPayload(info: ProcessStartInfo): Record<string, unknown> {
  return {
    ...ownerMetadataPayload(info.hostname, info.ownerPid),
    provider_pid: info.providerPid,
    provider_endpoint: info.endpoint,
  };
}

function optionalInt(value: unknown): number | null {
  if (typeof value === 'boolean' || typeof value !== 'number' || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

function presentStr(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  return null;
}
