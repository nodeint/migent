import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { childInvocation, launchChild, readReadyLine } from "../src/child.ts";
import { type EndpointStatus, ServiceEndpointServer, queryEndpoint } from "../src/endpoint.ts";
import { holdStartLock, threadHolds } from "../src/locks.ts";
import { RegistryHTTPServer } from "../src/server.ts";
import {
  ServiceEndpoint,
  ServiceError,
  authenticatedInstanceId,
  callService,
  serviceJsonPath,
  serviceStatus,
  startDetached,
  startLockPath,
  serveForeground,
  stop,
  svc,
} from "../src/service.ts";
import { monotonic, sleep } from "../src/time.ts";
import { logText, serviceRecord, waitFor, writeService } from "./support.ts";

const originalSvc = { ...svc };
const originalGetRequest = RegistryHTTPServer.prototype.getRequest;

function restoreSvc(): void {
  Object.assign(svc, originalSvc);
  RegistryHTTPServer.prototype.getRequest = originalGetRequest;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

class Flag {
  private flag = false;
  set(): void {
    this.flag = true;
  }
  isSet(): boolean {
    return this.flag;
  }
}

/** Scripted endpoint for stop tests: `alive` until `gone()` is called. */
class ScriptedEndpoint {
  state: EndpointStatus;
  stopRequests = 0;
  acceptStop = true;
  goneOnStop = false;
  goneOnKill = true;
  killed: number[] = [];

  constructor(record: Record<string, unknown>) {
    this.state = { state: "alive", hello: { instance_id: String(record.instance_id), pid: Number(record.pid) } };
  }

  install(): void {
    svc.queryEndpoint = async () => this.state;
    svc.requestStop = async () => {
      this.stopRequests += 1;
      if (this.goneOnStop) this.gone();
      return this.acceptStop;
    };
    svc.killPid = (pid) => {
      this.killed.push(pid);
      if (this.goneOnKill) this.gone();
    };
  }

  gone(): void {
    this.state = { state: "gone" };
  }
}

const children: number[] = [];
let envHome = process.env.MIGENT_HOME;
let root = "";

function freshHome(): string {
  envHome = process.env.MIGENT_HOME;
  root = mkdtempSync(path.join(tmpdir(), "registry-svc-"));
  process.env.MIGENT_HOME = root;
  const home = path.join(root, "registry");
  mkdirSync(home);
  return home;
}

function forget(pid: number): void {
  const index = children.indexOf(pid);
  if (index >= 0) children.splice(index, 1);
}

afterEach(() => {
  restoreSvc();
  for (const pid of children.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  if (envHome === undefined) delete process.env.MIGENT_HOME;
  else process.env.MIGENT_HOME = envHome;
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

test("start adopts a verified instance, status requires auth, and stop asks the service to exit", async () => {
  const home = freshHome();
  const published: Record<string, unknown>[] = [];
  svc.beforeServiceJsonPublish = (directory, record) => {
    expect(threadHolds(startLockPath(directory))).toBe(true);
    published.push(record);
  };
  const endpoint = await startDetached(home, 0, { termGraceSec: 0.3, killGraceSec: 0.3 });
  children.push(endpoint.pid);
  const file = serviceJsonPath(home);
  const text = readFileSync(file, "utf8");
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(text).toContain(String(endpoint.pid));
  expect(text).toContain(endpoint.instanceId);
  expect(published.length).toBe(1);
  expect(threadHolds(startLockPath(home))).toBe(false);
  expect(await authenticatedInstanceId(endpoint.port, endpoint.token, 2)).toBe(endpoint.instanceId);
  const report = await serviceStatus(home);
  expect(report).toEqual({ state: "running", host: "127.0.0.1", port: endpoint.port, pid: endpoint.pid });
  expect(report).not.toHaveProperty("token");
  const again = await startDetached(home, 0);
  expect(again.token).toBe(endpoint.token);
  expect(again.instanceId).toBe(endpoint.instanceId);
  expect(again.pid).toBe(endpoint.pid);
  await callService(endpoint.host, endpoint.port, endpoint.token, "GET", "/v1/health");
  expect(await queryEndpoint(home)).toEqual({
    state: "alive",
    hello: { instance_id: endpoint.instanceId, pid: endpoint.pid },
  });
  expect(await unauthenticatedInstance(endpoint.port)).toBeNull();
  const killed: number[] = [];
  svc.killPid = (pid) => killed.push(pid);
  const stopped = await stop(home, 2, 0.4);
  expect(stopped.outcome).toBe("stopped");
  expect(killed).toEqual([]);
  expect(await waitFor(() => !pidAlive(endpoint.pid), 2)).toBe(true);
  expect(await queryEndpoint(home)).toEqual({ state: "gone" });
  expect(statExists(serviceJsonPath(home))).toBe(false);
  expect((await serviceStatus(home)).state).toBe("stopped");
  forget(endpoint.pid);
}, 30000);

test("unauthenticated ok does not count as running", async () => {
  const home = freshHome();
  const server = net.createServer((socket) => {
    socket.on("data", () => {
      const body = Buffer.from('{"ok": true}');
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body.toString("utf8")}`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const record = serviceRecord({ port, pid: process.pid });
    writeService(home, record);
    new ScriptedEndpoint(record).install();
    expect(await authenticatedInstanceId(port, String(record.token), 1)).toBeNull();
    expect((await serviceStatus(home)).state).toBe("stopped");
  } finally {
    server.close();
  }
});

test("foreground order, stop request, and shutdown keeping service json", async () => {
  const home = freshHome();
  const events: string[] = [];
  const realHold = svc.holdStartLock;
  const realServiceLock = svc.acquireServiceLock;
  const stopEvent = new Flag();
  svc.holdStartLock = async (directory, timeout, body) => {
    events.push("acquire-start");
    try {
      return await realHold(directory, timeout, body);
    } finally {
      events.push("release-start");
    }
  };
  svc.acquireServiceLock = async (...args) => {
    events.push("acquire-service");
    return realServiceLock(...args);
  };
  svc.beforeServiceJsonPublish = () => {
    events.push("publish");
  };
  RegistryHTTPServer.prototype.getRequest = async function patched() {
    const result = await originalGetRequest.call(this);
    if (result) {
      events.push("accept");
      stopEvent.set();
    }
    return result;
  };
  const holder: unknown[] = [];
  const worker = serveForeground(home, 0, { stopEvent }).then(
    (endpoint) => holder.push(endpoint),
    (error: unknown) => holder.push(error),
  );
  expect(await waitFor(() => events.includes("release-start"), 5)).toBe(true);
  const document = JSON.parse(readFileSync(serviceJsonPath(home), "utf8")) as { port: number };
  const probe = net.connect({ host: "127.0.0.1", port: document.port });
  probe.on("error", () => undefined);
  await new Promise((resolve) => probe.once("connect", resolve));
  probe.write(Buffer.from("GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"));
  probe.end();
  await Promise.race([worker, sleep(5).then(() => Promise.reject(new Error(`foreground hung ${events.join(",")}`)))]);
  expect(events.slice(0, 5)).toEqual(["acquire-start", "acquire-service", "publish", "release-start", "accept"]);
  expect(statExists(serviceJsonPath(home))).toBe(true);
  expect(holder[0]).toBeInstanceOf(ServiceEndpoint);
  expect(await queryEndpoint(home)).toEqual({ state: "gone" });
}, 20000);

test("stop ends a foreground service through its endpoint", async () => {
  const home = freshHome();
  const worker = serveForeground(home, 0);
  expect(await waitFor(() => statExists(serviceJsonPath(home)), 5)).toBe(true);
  const killed: number[] = [];
  svc.killPid = (pid) => killed.push(pid);
  const result = await stop(home, 2, 0.2);
  expect(result.outcome).toBe("stopped");
  expect(killed).toEqual([]);
  await Promise.race([worker, sleep(5).then(() => Promise.reject(new Error("foreground did not stop")))]);
  expect(statExists(serviceJsonPath(home))).toBe(false);
}, 20000);

test("module without child args or an IPC channel exits 2", async () => {
  const home = freshHome();
  const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const invocation = childInvocation(main);
  const run = (args: string[]): Promise<number | null> =>
    new Promise((resolve) => {
      const proc = spawn(invocation.execPath, [...invocation.args, invocation.script, ...args], {
        cwd: home,
        env: { ...process.env, MIGENT_HOME: path.dirname(home) },
        stdio: "ignore",
      });
      proc.on("exit", (code) => resolve(code));
    });
  expect(await run([])).toBe(2);
  expect(await run(["--child", "--home", home, "--port", "9"])).toBe(2);
  expect(statExists(serviceJsonPath(home))).toBe(false);
  expect(statExists(startLockPath(home))).toBe(false);
});

test("child exits when the service endpoint is held and leaves the file", async () => {
  const home = freshHome();
  const original = Buffer.from('{"untouched": true}\n');
  writeFileSync(serviceJsonPath(home), original);
  const held = await ServiceEndpointServer.listen(home, { instance_id: "holder", pid: process.pid }, "t", () => undefined);
  expect(held).not.toBeNull();
  const child = await launchChild(home, 0);
  children.push(child.pid);
  try {
    const started = monotonic();
    const ready = await readReadyLine(child, monotonic() + 3);
    await child.wait(1);
    // A hung child would hit the ready deadline; a slow cold start must not fail.
    expect(monotonic() - started).toBeLessThan(3);
    expect(ready).toBeNull();
    expect(child.returncode).not.toBe(0);
  } finally {
    child.release();
    held?.close();
  }
  expect(readFileSync(serviceJsonPath(home))).toEqual(original);
  expect(statExists(startLockPath(home))).toBe(false);
}, 15000);

test("sigterm leaves service json bytes unchanged", async () => {
  const home = freshHome();
  const endpoint = await startDetached(home, 0, { termGraceSec: 0.3, killGraceSec: 0.3 });
  children.push(endpoint.pid);
  const before = readFileSync(serviceJsonPath(home));
  process.kill(endpoint.pid, "SIGTERM");
  expect(await waitFor(() => !pidAlive(endpoint.pid), 2)).toBe(true);
  expect(readFileSync(serviceJsonPath(home))).toEqual(before);
  // A Windows named pipe can take a moment to disappear after its process dies.
  let state = "";
  const deadline = monotonic() + 2;
  while (state !== "gone" && monotonic() < deadline) {
    state = (await queryEndpoint(home)).state;
    if (state !== "gone") await sleep(0.05);
  }
  expect(state).toBe("gone");
  forget(endpoint.pid);
}, 20000);

test("parent death before publish leaves service json absent", async () => {
  const home = freshHome();
  const sentinel = path.join(home, "sentinel");
  const script = fileURLToPath(new URL("../src/hold-ready.ts", import.meta.url));
  const invocation = childInvocation(script);
  const support = spawn(invocation.execPath, [...invocation.args, invocation.script, home, "0", sentinel], {
    cwd: home,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  support.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  let childPid = 0;
  try {
    expect(await waitFor(() => statExists(sentinel), 5), `${stderr}\n${logText(home)}`).toBe(true);
    expect(statExists(serviceJsonPath(home))).toBe(false);
    childPid = Number(readFileSync(sentinel, "utf8"));
    children.push(childPid);
    process.kill(support.pid ?? -1, "SIGKILL");
    await new Promise((resolve) => support.once("exit", resolve));
    expect(await waitFor(() => !pidAlive(childPid), 2)).toBe(true);
    const deadline = monotonic() + 0.5;
    while (monotonic() < deadline) {
      expect(statExists(serviceJsonPath(home))).toBe(false);
      await sleep(0.05);
    }
  } finally {
    if (support.exitCode === null && !support.killed) {
      try {
        process.kill(support.pid ?? -1, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  const called: unknown[] = [];
  svc.beforeServiceJsonUnlink = () => {
    called.push(true);
  };
  const result = await stop(home, 0.2, 0.2);
  expect(result.outcome).toBe("absent");
  expect(called).toEqual([]);
  expect(statExists(serviceJsonPath(home))).toBe(false);
  expect(await queryEndpoint(home)).toEqual({ state: "gone" });
  if (childPid) forget(childPid);
}, 20000);

test("stop refuses an endpoint that names another instance", async () => {
  const home = freshHome();
  const record = serviceRecord();
  writeService(home, record);
  const before = readFileSync(serviceJsonPath(home));
  const endpoint = new ScriptedEndpoint(record);
  endpoint.state = { state: "alive", hello: { instance_id: "someone-else", pid: 7 } };
  endpoint.install();
  const result = await stop(home, 0.2, 0.2);
  expect(result.outcome).toBe("error");
  expect(endpoint.stopRequests).toBe(0);
  expect(endpoint.killed).toEqual([]);
  expect(readFileSync(serviceJsonPath(home))).toEqual(before);
  endpoint.state = { state: "unknown" };
  expect((await stop(home, 0.2, 0.2)).outcome).toBe("error");
  expect(readFileSync(serviceJsonPath(home))).toEqual(before);
});

test("stop unlinks when the service exits on request", async () => {
  const home = freshHome();
  const record = serviceRecord();
  writeService(home, record);
  const endpoint = new ScriptedEndpoint(record);
  endpoint.goneOnStop = true;
  endpoint.install();
  const result = await stop(home, 0.2, 0.2);
  expect(result.outcome).toBe("stopped");
  expect(endpoint.stopRequests).toBe(1);
  expect(endpoint.killed).toEqual([]);
  expect(statExists(serviceJsonPath(home))).toBe(false);
});

test("stop kills the endpoint's own pid when the request does not end it", async () => {
  const home = freshHome();
  const record = serviceRecord();
  writeService(home, record);
  const endpoint = new ScriptedEndpoint(record);
  endpoint.install();
  const result = await stop(home, 0.2, 0.2);
  expect(result.outcome).toBe("stopped");
  expect(endpoint.stopRequests).toBe(1);
  expect(endpoint.killed).toEqual([record.pid]);
  expect(statExists(serviceJsonPath(home))).toBe(false);
});

test("stop still alive after kill keeps the file", async () => {
  const home = freshHome();
  const record = serviceRecord();
  writeService(home, record);
  const before = readFileSync(serviceJsonPath(home));
  const endpoint = new ScriptedEndpoint(record);
  endpoint.goneOnKill = false;
  endpoint.install();
  const called: unknown[] = [];
  svc.beforeServiceJsonUnlink = () => {
    called.push(true);
  };
  const started = monotonic();
  const result = await stop(home, 0.2, 0.2);
  const elapsed = monotonic() - started;
  expect(result.outcome).toBe("error");
  expect(result.message).toContain("still alive");
  expect(readFileSync(serviceJsonPath(home))).toEqual(before);
  expect(called).toEqual([]);
  expect(elapsed).toBeGreaterThanOrEqual(0.4);
  expect(elapsed).toBeLessThan(1.5);
  expect(endpoint.killed).toEqual([record.pid]);
});

test("stop holds start lock across the unlink", async () => {
  const home = freshHome();
  const record = serviceRecord();
  writeService(home, record);
  const original = readFileSync(serviceJsonPath(home));
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const published: string[] = [];
  svc.beforeServiceJsonUnlink = async () => {
    entered = true;
    await Promise.race([released, sleep(5)]);
  };
  svc.beforeServiceJsonPublish = (_directory, replacement) => {
    published.push(String(replacement.instance_id));
  };
  const stopped: Array<{ outcome: string }> = [];
  const startedResult: unknown[] = [];
  // No endpoint is listening, so the record is stale.
  const stopper = stop(home, 0.2, 0.2).then((result) => {
    stopped.push(result);
  });
  expect(await waitFor(() => entered, 2)).toBe(true);
  const starter = startDetached(home, 0, { termGraceSec: 0.3, killGraceSec: 0.3 }).then(
    (endpoint) => startedResult.push(endpoint),
    (error: unknown) => startedResult.push(error),
  );
  await sleep(0.3);
  expect(published).toEqual([]);
  expect(readFileSync(serviceJsonPath(home))).toEqual(original);
  release();
  await stopper;
  await Promise.race([
    starter,
    sleep(8).then(() => Promise.reject(new Error(`start hung\n${logText(home)}`))),
  ]);
  expect(stopped[0]?.outcome).toBe("stopped");
  const endpoint = startedResult[0];
  expect(endpoint, `${String(endpoint)}\n${logText(home)}`).toBeInstanceOf(ServiceEndpoint);
  const adopted = endpoint as ServiceEndpoint;
  children.push(adopted.pid);
  const document = JSON.parse(readFileSync(serviceJsonPath(home), "utf8")) as { instance_id: string };
  expect(document.instance_id).toBe(adopted.instanceId);
  expect(document.instance_id).not.toBe(record.instance_id);
  expect(published).toEqual([adopted.instanceId]);
  await stop(home, 2, 0.4);
  forget(adopted.pid);
}, 20000);

test("unlink reread keeps a replaced document", async () => {
  const home = freshHome();
  const record = serviceRecord();
  writeService(home, record);
  const endpoint = new ScriptedEndpoint(record);
  endpoint.goneOnStop = true;
  endpoint.install();
  svc.beforeServiceJsonUnlink = (directory) => {
    const replacement = serviceRecord({ instance_id: "replacement-instance", pid: 999111 });
    writeFileSync(serviceJsonPath(directory), `${JSON.stringify(replacement)}\n`);
  };
  const result = await stop(home, 0.2, 0.2);
  expect(readFileSync(serviceJsonPath(home), "utf8")).toContain("replacement-instance");
  expect(result.outcome).toBe("stopped");
  expect(result.message).toBe("");
});

test("second start waits for the lock and adopts only authenticated health", async () => {
  const home = freshHome();
  const record = serviceRecord();
  writeService(home, record);
  const original = readFileSync(serviceJsonPath(home));
  const spawned: unknown[] = [];
  const forbid = async (): Promise<never> => {
    spawned.push(true);
    throw new Error("start spawned");
  };
  await holdStartLock(home, 2, async () => {
    svc.launchChild = forbid;
    await expect(startDetached(home, 0, { startLockTimeout: 0.3 })).rejects.toBeInstanceOf(ServiceError);
    expect(spawned).toEqual([]);
    expect(readFileSync(serviceJsonPath(home))).toEqual(original);
  });
  restoreSvc();
  new ScriptedEndpoint(record).install();
  svc.launchChild = forbid;
  svc.authenticatedInstanceId = async () => String(record.instance_id);
  const adopted = await startDetached(home, 0, { identityTimeout: 0.2 });
  expect(adopted.token).toBe(record.token);
  expect(spawned).toEqual([]);
  svc.authenticatedInstanceId = async () => null;
  await expect(startDetached(home, 0, { identityTimeout: 0.2 })).rejects.toBeInstanceOf(ServiceError);
  expect(readFileSync(serviceJsonPath(home))).toEqual(original);
});

test("a record whose endpoint is gone is replaced without a kill", async () => {
  const home = freshHome();
  // pid 1 is alive but is not the service; only the endpoint decides.
  writeService(home, serviceRecord({ pid: 1 }));
  const killed: number[] = [];
  svc.killPid = (pid) => killed.push(pid);
  const endpoint = await startDetached(home, 0, { termGraceSec: 0.3, killGraceSec: 0.3 });
  children.push(endpoint.pid);
  const document = JSON.parse(readFileSync(serviceJsonPath(home), "utf8")) as { pid: number };
  expect(document.pid).toBe(endpoint.pid);
  expect(killed).toEqual([]);
  expect(threadHolds(startLockPath(home))).toBe(false);
  await stop(home, 2, 0.4);
  forget(endpoint.pid);
}, 20000);

test("failed start stops its own child and publishes nothing", async () => {
  const home = freshHome();
  const spawned: number[] = [];
  const realLaunch = svc.launchChild;
  svc.launchChild = async (directory, port) => {
    const child = await realLaunch(directory, port);
    spawned.push(child.pid);
    return child;
  };
  svc.readReadyLine = async () => null;
  const killed: number[] = [];
  svc.killPid = (pid) => killed.push(pid);
  try {
    await expect(
      startDetached(home, 0, { readyTimeout: 0.3, termGraceSec: 0.5, killGraceSec: 0.5 }),
    ).rejects.toBeInstanceOf(ServiceError);
  } finally {
    for (const pid of spawned) children.push(pid);
  }
  expect(spawned.length).toBe(1);
  expect(await waitFor(() => !pidAlive(spawned[0] ?? -1), 2)).toBe(true);
  expect(killed).toEqual([]);
  expect(statExists(serviceJsonPath(home))).toBe(false);
}, 15000);

test("a live Migent 0.1 service blocks start and stop; a dead one is replaced", async () => {
  const home = freshHome();
  const legacy = serviceRecord({
    schema_version: 1,
    pid: process.pid,
    pgid: process.pid,
    start_key: "start-key",
    boot_id: "boot-1",
    hostname: "host.example",
  });
  writeService(home, legacy);
  const before = readFileSync(serviceJsonPath(home));
  svc.launchChild = async () => {
    throw new Error("start spawned");
  };
  await expect(startDetached(home, 0, { identityTimeout: 0.2 })).rejects.toThrow(/Migent 0\.1/);
  const stopped = await stop(home, 0.2, 0.2);
  expect(stopped.outcome).toBe("error");
  expect(stopped.message).toMatch(/Migent 0\.1/);
  expect(readFileSync(serviceJsonPath(home))).toEqual(before);
  svc.pidAlive = () => false;
  expect((await stop(home, 0.2, 0.2)).outcome).toBe("stopped");
  expect(statExists(serviceJsonPath(home))).toBe(false);
});

function statExists(file: string): boolean {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}

async function unauthenticatedInstance(port: number): Promise<string | null> {
  const payload = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.write(Buffer.from("GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"));
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw.split("\r\n\r\n")[1] ?? "";
      resolve(JSON.parse(body) as Record<string, unknown>);
    });
    socket.on("error", reject);
  });
  expect(payload.ok).toBe(true);
  expect(payload).not.toHaveProperty("instance_id");
  return typeof payload.instance_id === "string" ? payload.instance_id : null;
}
