import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  ENDPOINT_ALIVE,
  ENDPOINT_GONE,
  ENDPOINT_UNKNOWN,
  ERROR_ALREADY_EXITED,
  type EndpointState,
  PID_GONE,
  PID_PRESENT,
  PID_UNVERIFIED,
  REAP_ALREADY_EXITED,
  REAP_NOOP,
  REAP_STILL_RUNNING,
  REAP_UNVERIFIED,
  classifyOrphanedExecution,
  probeEndpointSync,
  probePid,
  type ProcessInspector,
  wrapperArgv,
} from "../src/process-ownership.ts";
import { WRAPPER_READY, WRAPPER_START, killProcessTree, wrapperEndpoint } from "../src/process-wrapper.ts";

// Writes its own pid to argv[1], then waits until argv[2] exists.
const SENTINEL_SCRIPT = `
const fs = require("fs");
fs.writeFileSync(process.argv[1], String(process.pid));
while (!fs.existsSync(process.argv[2])) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
`;

class FakeInspector implements ProcessInspector {
  hostnameValue = "host.example";
  probes = new Map<number, string>();
  endpointState: EndpointState = ENDPOINT_GONE;
  probedEndpoints: string[] = [];

  hostname(): string {
    return this.hostnameValue;
  }

  probePid(pid: number): string {
    return this.probes.get(pid) ?? PID_UNVERIFIED;
  }

  probeEndpoint(endpoint: string): EndpointState {
    this.probedEndpoints.push(endpoint);
    return this.endpointState;
  }
}

function metadata(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "run-1",
    execution_id: "0001-implement--attempt-01",
    status: "running",
    hostname: "host.example",
    owner_pid: 111,
    provider_pid: 4242,
    provider_endpoint: "/tmp/migent-test.sock",
    ...extra,
  };
}

async function waitUntil(predicate: () => boolean, timeoutSec: number): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`condition not met within ${timeoutSec}s`);
}

const strays: number[] = [];

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      killProcessTree(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

function startWrapper(command: string[], endpoint: string, graceSec: number): ChildProcess {
  const argv = wrapperArgv(command, { endpoint, graceSec });
  const child = spawn(argv[0] ?? "", argv.slice(1), {
    detached: process.platform !== "win32",
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  if (child.pid !== undefined) strays.push(child.pid);
  return child;
}

function nextMessage(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve) => child.once("message", resolve));
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function sentinelCommand(directory: string): { command: string[]; sentinel: string; release: string } {
  const sentinel = path.join(directory, "sentinel");
  const release = path.join(directory, "release");
  return { command: [process.execPath, "-e", SENTINEL_SCRIPT, sentinel, release], sentinel, release };
}

test("owner gone before start does not start provider", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "migent-own-"));
  const { command, sentinel } = sentinelCommand(directory);
  try {
    const child = startWrapper(command, wrapperEndpoint(randomBytes(8).toString("hex")), 0.5);
    expect(await nextMessage(child)).toEqual({ type: WRAPPER_READY });
    child.disconnect();
    await waitUntil(() => exited(child), 5);
    expect(child.exitCode).toBe(1);
    expect(existsSync(sentinel)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("owner death after start stops the provider and frees the endpoint", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "migent-own-"));
  const { command, sentinel } = sentinelCommand(directory);
  const endpoint = wrapperEndpoint(randomBytes(8).toString("hex"));
  try {
    const child = startWrapper(command, endpoint, 0.5);
    expect(await nextMessage(child)).toEqual({ type: WRAPPER_READY });
    expect(probeEndpointSync(endpoint, 1000)).toBe(ENDPOINT_ALIVE);
    child.send({ type: WRAPPER_START });
    await waitUntil(() => existsSync(sentinel) && readFileSync(sentinel, "utf8") !== "", 5);
    const providerPid = Number(readFileSync(sentinel, "utf8"));
    expect(probePid(providerPid)).toBe(PID_PRESENT);
    child.disconnect();
    await waitUntil(() => exited(child), 5);
    await waitUntil(() => probePid(providerPid) === PID_GONE, 5);
    expect(probeEndpointSync(endpoint, 1000)).toBe(ENDPOINT_GONE);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Owner that starts the wrapper (its argv) and then waits to be killed.
const OWNER_SCRIPT = `
const { spawn } = require("child_process");
const argv = process.argv.slice(1);
const child = spawn(argv[0], argv.slice(1), {
  detached: process.platform !== "win32",
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});
child.on("message", (message) => {
  if (message.type === "ready") child.send({ type: "start" });
});
setInterval(() => undefined, 1000);
`;

test("killed owner process stops the provider", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "migent-own-"));
  const { command, sentinel } = sentinelCommand(directory);
  const endpoint = wrapperEndpoint(randomBytes(8).toString("hex"));
  const owner = spawn(
    process.execPath,
    ["-e", OWNER_SCRIPT, "--", ...wrapperArgv(command, { endpoint, graceSec: 0.5 })],
    { stdio: "inherit" },
  );
  try {
    await waitUntil(() => existsSync(sentinel) && readFileSync(sentinel, "utf8") !== "", 5);
    const providerPid = Number(readFileSync(sentinel, "utf8"));
    strays.push(providerPid);
    owner.kill("SIGKILL");
    await waitUntil(() => probePid(providerPid) === PID_GONE, 5);
    await waitUntil(() => probeEndpointSync(endpoint, 1000) === ENDPOINT_GONE, 5);
  } finally {
    owner.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wrapper reports the provider exit code", async () => {
  const child = startWrapper([process.execPath, "-e", "process.exit(7)"], wrapperEndpoint(randomBytes(8).toString("hex")), 0.5);
  expect(await nextMessage(child)).toEqual({ type: WRAPPER_READY });
  child.send({ type: WRAPPER_START });
  await waitUntil(() => exited(child), 5);
  expect(child.exitCode).toBe(7);
});

test("missing provider executable exits 127", async () => {
  const child = startWrapper(["migent-no-such-binary"], wrapperEndpoint(randomBytes(8).toString("hex")), 0.5);
  expect(await nextMessage(child)).toEqual({ type: WRAPPER_READY });
  child.send({ type: WRAPPER_START });
  await waitUntil(() => exited(child), 5);
  expect(child.exitCode).toBe(127);
});

test("reachable endpoint is still running", () => {
  const fake = new FakeInspector();
  fake.endpointState = ENDPOINT_ALIVE;
  const decision = classifyOrphanedExecution(metadata(), "/x", fake);
  expect(decision.action).toBe(REAP_STILL_RUNNING);
  expect(decision.ownerPid).toBe(111);
  expect(fake.probedEndpoints).toEqual(["/tmp/migent-test.sock"]);
});

test("refused endpoint already exited", () => {
  const fake = new FakeInspector();
  fake.endpointState = ENDPOINT_GONE;
  // A reused owner pid does not matter once the endpoint is gone.
  fake.probes.set(111, PID_PRESENT);
  const decision = classifyOrphanedExecution(metadata(), "/x", fake);
  expect(decision.action).toBe(REAP_ALREADY_EXITED);
  expect(decision.error).toBe(ERROR_ALREADY_EXITED);
});

test("unknown endpoint state is unverified", () => {
  const fake = new FakeInspector();
  fake.endpointState = ENDPOINT_UNKNOWN;
  expect(classifyOrphanedExecution(metadata(), "/x", fake).action).toBe(REAP_UNVERIFIED);
});

test("other host, missing owner, or finished execution is not probed", () => {
  const fake = new FakeInspector();
  expect(classifyOrphanedExecution(metadata({ hostname: "elsewhere" }), "/x", fake).action).toBe(REAP_UNVERIFIED);
  expect(classifyOrphanedExecution(metadata({ owner_pid: undefined }), "/x", fake).action).toBe(REAP_UNVERIFIED);
  expect(classifyOrphanedExecution(metadata({ status: "complete" }), "/x", fake).action).toBe(REAP_NOOP);
  expect(fake.probedEndpoints).toEqual([]);
});

test("legacy record without endpoint trusts only a vanished owner", () => {
  const fake = new FakeInspector();
  fake.probes.set(111, PID_GONE);
  expect(classifyOrphanedExecution(metadata({ provider_endpoint: undefined }), "/x", fake).action).toBe(
    REAP_ALREADY_EXITED,
  );
  fake.probes.set(111, PID_PRESENT);
  expect(classifyOrphanedExecution(metadata({ provider_endpoint: undefined }), "/x", fake).action).toBe(
    REAP_UNVERIFIED,
  );
});
