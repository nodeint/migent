import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { constants as osConstants, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { identityLockHolder } from "@migent/kernel";
import { childInvocation, launchChild, readReadyLine } from "../src/child.ts";
import { holdStartLock, threadHolds } from "../src/locks.ts";
import { reapChild } from "../src/posix.ts";
import { RegistryHTTPServer } from "../src/server.ts";
import {
  LiveSignalBackend,
  ServiceEndpoint,
  ServiceError,
  acquireServiceLock,
  authenticatedInstanceId,
  callService,
  serviceJsonPath,
  serviceLockPath,
  serviceStatus,
  signalVerifiedPid,
  startDetached,
  startLockPath,
  serveForeground,
  stop,
  svc,
} from "../src/service.ts";
import { monotonic, sleep } from "../src/time.ts";
import { RecordingBackend, ScriptedInspector, logText, serviceRecord, waitFor, writeService } from "./support.ts";

const originalSvc = {
  beforeServiceJsonPublish: svc.beforeServiceJsonPublish,
  beforeServiceJsonUnlink: svc.beforeServiceJsonUnlink,
  publishServiceJson: svc.publishServiceJson,
  unlinkServiceJsonIfUnchanged: svc.unlinkServiceJsonIfUnchanged,
  holdStartLock: svc.holdStartLock,
  acquireServiceLock: svc.acquireServiceLock,
  launchChild: svc.launchChild,
  readReadyLine: svc.readReadyLine,
  kernelProcessIdentity: svc.kernelProcessIdentity,
  authenticatedInstanceId: svc.authenticatedInstanceId,
  serviceIdentityMatches: svc.serviceIdentityMatches,
};
const originalGetRequest = RegistryHTTPServer.prototype.getRequest;

function restoreSvc(): void {
  Object.assign(svc, originalSvc);
  RegistryHTTPServer.prototype.getRequest = originalGetRequest;
}

function esrch(): NodeJS.ErrnoException {
  const error = new Error("No such process") as NodeJS.ErrnoException;
  error.code = "ESRCH";
  error.errno = osConstants.errno.ESRCH;
  return error;
}

function pidAlive(pid: number): boolean {
  if (reapChild(pid)) return false;
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

test("unsupported backend kills only after a true recheck", () => {
  const backend = new RecordingBackend({ supported: false });
  const pid = 42;
  signalVerifiedPid(
    pid,
    osConstants.signals.SIGTERM,
    () => {
      backend.log.push("recheck");
      return true;
    },
    backend,
  );
  expect(backend.log[0]).toBe("recheck");
  expect(backend.log[1]).toEqual(["kill", pid, osConstants.signals.SIGTERM]);
});

test("exit after recheck before kill is not an error", () => {
  const backend = new RecordingBackend({ supported: false });
  backend.kill = (pid, sig) => {
    backend.log.push(["kill", pid, sig]);
    throw esrch();
  };
  signalVerifiedPid(42, osConstants.signals.SIGTERM, () => true, backend);
  expect(backend.log).toEqual([["kill", 42, osConstants.signals.SIGTERM]]);
});

test("false recheck sends nothing", () => {
  const backend = new RecordingBackend({ supported: false });
  signalVerifiedPid(
    42,
    osConstants.signals.SIGTERM,
    () => {
      backend.log.push("recheck");
      return false;
    },
    backend,
  );
  expect(backend.log).toEqual(["recheck"]);
});

test("esrch sends nothing", () => {
  const backend = new RecordingBackend({ supported: true, openErrno: osConstants.errno.ESRCH });
  signalVerifiedPid(42, osConstants.signals.SIGTERM, () => true, backend);
  expect(backend.log).toEqual([["open", 42]]);
});

test("open then false recheck closes without sending", () => {
  const backend = new RecordingBackend({ supported: true });
  signalVerifiedPid(
    42,
    osConstants.signals.SIGTERM,
    () => {
      backend.log.push("recheck");
      return false;
    },
    backend,
  );
  expect(backend.log[0]).toEqual(["open", 42]);
  expect(backend.log).toContain("recheck");
  expect(backend.log).toContainEqual(["close", 80]);
  expect(backend.log.some((item) => Array.isArray(item) && item[0] === "send")).toBe(false);
  expect(backend.log.some((item) => Array.isArray(item) && item[0] === "kill")).toBe(false);
});

test("true recheck sends on that pidfd", () => {
  const backend = new RecordingBackend({ supported: true });
  signalVerifiedPid(
    42,
    osConstants.signals.SIGTERM,
    () => {
      backend.log.push("recheck");
      return true;
    },
    backend,
  );
  expect(backend.log).toContainEqual(["send", 80, osConstants.signals.SIGTERM]);
  expect(backend.log.indexOf(["open", 42] as unknown as string)).toBeLessThan(backend.log.indexOf("recheck"));
  const openAt = backend.log.findIndex((item) => Array.isArray(item) && item[0] === "open");
  const sendAt = backend.log.findIndex((item) => Array.isArray(item) && item[0] === "send");
  expect(openAt).toBeLessThan(backend.log.indexOf("recheck"));
  expect(backend.log.indexOf("recheck")).toBeLessThan(sendAt);
});

test("enosys from open uses the recheck fallback", () => {
  const backend = new RecordingBackend({ supported: true, openErrno: osConstants.errno.ENOSYS });
  signalVerifiedPid(
    42,
    osConstants.signals.SIGTERM,
    () => {
      backend.log.push("recheck");
      return true;
    },
    backend,
  );
  expect(backend.log[0]).toEqual(["open", 42]);
  expect(backend.log).toContain("recheck");
  expect(backend.log).toContainEqual(["kill", 42, osConstants.signals.SIGTERM]);
});

test("sigkill opens a new pidfd", () => {
  const backend = new RecordingBackend({ supported: true });
  signalVerifiedPid(42, osConstants.signals.SIGTERM, () => true, backend);
  signalVerifiedPid(42, osConstants.signals.SIGKILL, () => true, backend);
  const opens = backend.log.filter((item) => Array.isArray(item) && item[0] === "open");
  const sends = backend.log.filter((item) => Array.isArray(item) && item[0] === "send");
  expect(opens).toEqual([
    ["open", 42],
    ["open", 42],
  ]);
  expect(sends[0]?.[1]).toBe(80);
  expect(sends[1]?.[1]).toBe(81);
  expect(sends[0]?.[1]).not.toBe(sends[1]?.[1]);
});

test("unsupported sigkill rechecks again", () => {
  const backend = new RecordingBackend({ supported: false });
  const checks: number[] = [];
  const still = (): boolean => {
    checks.push(checks.length === 0 ? osConstants.signals.SIGTERM : osConstants.signals.SIGKILL);
    return true;
  };
  signalVerifiedPid(42, osConstants.signals.SIGTERM, still, backend);
  signalVerifiedPid(42, osConstants.signals.SIGKILL, still, backend);
  expect(checks).toEqual([osConstants.signals.SIGTERM, osConstants.signals.SIGKILL]);
  expect(backend.log.filter((item) => Array.isArray(item))).toEqual([
    ["kill", 42, osConstants.signals.SIGTERM],
    ["kill", 42, osConstants.signals.SIGKILL],
  ]);
});

test.skipIf(!new LiveSignalBackend().supported())("production send is pidfd_send_signal", () => {
  expect(new LiveSignalBackend().supported()).toBe(true);
});

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

afterEach(() => {
  restoreSvc();
  for (const pid of children.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    reapChild(pid);
  }
  if (envHome === undefined) delete process.env.MIGENT_HOME;
  else process.env.MIGENT_HOME = envHome;
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

test("start adopts a verified instance and status requires auth", async () => {
  const home = freshHome();
  const published: Record<string, unknown>[] = [];
  svc.beforeServiceJsonPublish = (directory, record) => {
    expect(threadHolds(startLockPath(directory))).toBe(true);
    const file = serviceJsonPath(directory);
    let current = "";
    try {
      current = readFileSync(file, "utf8");
    } catch {
      current = "";
    }
    expect(current.includes(String(record.instance_id))).toBe(false);
    published.push(record);
  };
  const endpoint = await startDetached(home, 0, { termGraceSec: 0.3, killGraceSec: 0.3 });
  children.push(endpoint.pid);
  const file = serviceJsonPath(home);
  const text = readFileSync(file, "utf8");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(text).toContain(String(endpoint.pid));
  expect(text).toContain(endpoint.instanceId);
  expect(published.length).toBeGreaterThan(0);
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
  expect(identityLockHolder(serviceLockPath(home))).toBe(endpoint.pid);
  const unauth = await unauthenticatedInstance(endpoint.port);
  expect(unauth).toBeNull();
  const stopped = await stop(home, 0.4, 0.4);
  expect(stopped.outcome).toBe("stopped");
  children.splice(children.indexOf(endpoint.pid), 1);
  reapChild(endpoint.pid);
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
    const record = serviceRecord({ port, pid: process.pid, pgid: process.pid });
    writeService(home, record);
    const inspector = new ScriptedInspector(record);
    expect(await authenticatedInstanceId(port, String(record.token), 1)).toBeNull();
    expect((await serviceStatus(home, inspector)).state).toBe("stopped");
  } finally {
    server.close();
  }
});

test("foreground order and shutdown keeps service json", async () => {
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
  svc.acquireServiceLock = async (directory) => {
    events.push("acquire-service");
    return realServiceLock(directory);
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
  expect(statSync(serviceJsonPath(home)).isFile()).toBe(true);
  expect(holder[0]).toBeInstanceOf(ServiceEndpoint);
}, 20000);

test("module without child or handshake exits 2", async () => {
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

test("child exits when service lock is held and leaves the file", async () => {
  const home = freshHome();
  const original = Buffer.from('{"untouched": true}\n');
  writeFileSync(serviceJsonPath(home), original);
  const lockFd = await acquireServiceLock(home);
  expect(lockFd).not.toBeNull();
  const [proc, parent] = await launchChild(home, 0);
  children.push(proc.pid);
  try {
    const started = monotonic();
    const line = await readReadyLine(parent, monotonic() + 2);
    await proc.wait(1);
    expect(monotonic() - started).toBeLessThan(1);
    expect(line).toBeNull();
    expect(proc.returncode).not.toBe(0);
  } finally {
    closeSync(parent);
    if (lockFd !== null) closeSync(lockFd);
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
  reapChild(endpoint.pid);
  children.splice(children.indexOf(endpoint.pid), 1);
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
    expect(await waitFor(() => !pidAlive(childPid), 1)).toBe(true);
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
  expect(statExists(serviceJsonPath(home))).toBe(false);
  const called: unknown[] = [];
  svc.beforeServiceJsonUnlink = () => {
    called.push(true);
  };
  const result = await stop(home, 0.2, 0.2);
  expect(result.outcome).toBe("absent");
  expect(called).toEqual([]);
  expect(statExists(serviceJsonPath(home))).toBe(false);
  expect(identityLockHolder(serviceLockPath(home))).toBeNull();
  if (childPid) {
    reapChild(childPid);
    const index = children.indexOf(childPid);
    if (index >= 0) children.splice(index, 1);
  }
}, 20000);

test("stop sends term then kill only after the identity stays", async () => {
  const home = freshHome();
  const record = serviceRecord();
  writeService(home, record);
  const before = readFileSync(serviceJsonPath(home));
  const inspector = new ScriptedInspector(record);
  const backend = new RecordingBackend({ supported: false });
  const mismatched = new ScriptedInspector(record);
  mismatched.startKey = "other-start";
  const quiet = new RecordingBackend({ supported: false });
  const mismatch = await stop(home, 0.2, 0.2, { inspector: mismatched, backend: quiet });
  expect(mismatch.outcome).toBe("error");
  expect(quiet.log).toEqual([]);
  expect(readFileSync(serviceJsonPath(home))).toEqual(before);
  const checks: string[] = [];
  const real = svc.serviceIdentityMatches;
  svc.serviceIdentityMatches = (loaded, checker, lockPath) => {
    checks.push("match");
    return real(loaded, checker, lockPath);
  };
  const result = await stop(home, 0.2, 0.2, { inspector, backend });
  expect(result.outcome).toBe("error");
  expect(["absent", "stopped"]).not.toContain(result.outcome);
  expect(backend.log.filter((item) => Array.isArray(item))).toEqual([
    ["kill", record.pid, osConstants.signals.SIGTERM],
    ["kill", record.pid, osConstants.signals.SIGKILL],
  ]);
  expect(checks.filter((item) => item === "match").length).toBeGreaterThanOrEqual(3);
  expect(readFileSync(serviceJsonPath(home))).toEqual(before);
});

test("stop unlinks when the process disappears during term grace", async () => {
  const home = freshHome();
  const record = serviceRecord();
  writeService(home, record);
  const inspector = new ScriptedInspector(record);
  const backend = new RecordingBackend({ supported: false });
  backend.kill = (pid, sig) => {
    backend.log.push(["kill", pid, sig]);
    inspector.markGone();
  };
  const result = await stop(home, 0.2, 0.2, { inspector, backend });
  expect(result.outcome).toBe("stopped");
  expect(backend.log).toEqual([["kill", record.pid, osConstants.signals.SIGTERM]]);
  expect(statExists(serviceJsonPath(home))).toBe(false);
});

test("stop confirms gone when the process exits before kill", async () => {
  const home = freshHome();
  const record = serviceRecord();
  writeService(home, record);
  const inspector = new ScriptedInspector(record);
  const backend = new RecordingBackend({ supported: false });
  backend.kill = (pid, sig) => {
    backend.log.push(["kill", pid, sig]);
    inspector.markGone();
    throw esrch();
  };
  const result = await stop(home, 0.2, 0.2, { inspector, backend });
  expect(result.outcome).toBe("stopped");
  expect(backend.log).toEqual([["kill", record.pid, osConstants.signals.SIGTERM]]);
  expect(statExists(serviceJsonPath(home))).toBe(false);
});

test("stop still alive after sigkill keeps the file", async () => {
  const home = freshHome();
  const record = serviceRecord();
  writeService(home, record);
  const before = readFileSync(serviceJsonPath(home));
  const inspector = new ScriptedInspector(record);
  const backend = new RecordingBackend({ supported: false });
  const called: unknown[] = [];
  svc.beforeServiceJsonUnlink = () => {
    called.push(true);
  };
  const started = monotonic();
  const result = await stop(home, 0.2, 0.2, { inspector, backend });
  const elapsed = monotonic() - started;
  expect(result.outcome).toBe("error");
  expect(["absent", "stopped"]).not.toContain(result.outcome);
  expect(result.message).toContain("still alive");
  expect(readFileSync(serviceJsonPath(home))).toEqual(before);
  expect(called).toEqual([]);
  expect(elapsed).toBeGreaterThanOrEqual(0.2);
  expect(elapsed).toBeLessThan(1.2);
  expect(backend.log).toContainEqual(["kill", record.pid, osConstants.signals.SIGKILL]);
});

test("stop unlinks after sigkill once the process is gone", async () => {
  const home = freshHome();
  const record = serviceRecord();
  writeService(home, record);
  const inspector = new ScriptedInspector(record);
  const backend = new RecordingBackend({ supported: false });
  backend.kill = (pid, sig) => {
    backend.log.push(["kill", pid, sig]);
    if (sig === osConstants.signals.SIGKILL) inspector.markGone();
  };
  const result = await stop(home, 0.2, 0.2, { inspector, backend });
  expect(result.outcome).toBe("stopped");
  expect(backend.log).toContainEqual(["kill", record.pid, osConstants.signals.SIGKILL]);
  expect(statExists(serviceJsonPath(home))).toBe(false);
});

test("stop holds start lock across the unlink", async () => {
  const home = freshHome();
  const record = serviceRecord();
  writeService(home, record);
  const original = readFileSync(serviceJsonPath(home));
  const inspector = new ScriptedInspector(record);
  inspector.alive = false;
  inspector.holdLock = false;
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
  const stopper = stop(home, 0.2, 0.2, { inspector, backend: new RecordingBackend() }).then((result) => {
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
  expect(startedResult.length).toBeGreaterThan(0);
  const endpoint = startedResult[0];
  expect(endpoint, `${String(endpoint)}\n${logText(home)}`).toBeInstanceOf(ServiceEndpoint);
  const adopted = endpoint as ServiceEndpoint;
  children.push(adopted.pid);
  const document = JSON.parse(readFileSync(serviceJsonPath(home), "utf8")) as { instance_id: string };
  expect(document.instance_id).toBe(adopted.instanceId);
  expect(document.instance_id).not.toBe(record.instance_id);
  expect(published).toEqual([adopted.instanceId]);
  await stop(home, 0.4, 0.4);
  reapChild(adopted.pid);
  children.splice(children.indexOf(adopted.pid), 1);
}, 20000);

test("unlink reread keeps a replaced document", async () => {
  const home = freshHome();
  const record = serviceRecord();
  writeService(home, record);
  const inspector = new ScriptedInspector(record);
  const backend = new RecordingBackend({ supported: false });
  const replacementPid = 999111;
  backend.kill = (pid, sig) => {
    backend.log.push(["kill", pid, sig]);
    inspector.markGone();
  };
  svc.beforeServiceJsonUnlink = (directory) => {
    const replacement = serviceRecord({
      instance_id: "replacement-instance",
      pid: replacementPid,
      pgid: replacementPid,
      start_key: "replacement-start",
    });
    writeFileSync(serviceJsonPath(directory), `${JSON.stringify(replacement)}\n`);
  };
  const result = await stop(home, 0.2, 0.2, { inspector, backend });
  const text = readFileSync(serviceJsonPath(home), "utf8");
  expect(text).toContain("replacement-instance");
  expect(result.outcome).toBe("stopped");
  expect(result.message).toBe("");
  const signaled = backend.log.filter((item) => Array.isArray(item) && item[0] === "kill").map((item) => item[1]);
  expect(signaled).toContain(record.pid);
  expect(signaled).not.toContain(replacementPid);
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
    const errors: unknown[] = [];
    try {
      await startDetached(home, 0, { startLockTimeout: 0.3 });
    } catch (error) {
      if (error instanceof ServiceError) errors.push(error);
      else throw error;
    }
    expect(spawned).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
    expect(readFileSync(serviceJsonPath(home))).toEqual(original);
  });
  restoreSvc();
  const inspector = new ScriptedInspector(record);
  svc.launchChild = forbid;
  svc.authenticatedInstanceId = async () => String(record.instance_id);
  const adopted = await startDetached(home, 0, { inspector, identityTimeout: 0.2 });
  expect(adopted.token).toBe(record.token);
  expect(spawned).toEqual([]);
  svc.authenticatedInstanceId = async () => null;
  await expect(startDetached(home, 0, { inspector, identityTimeout: 0.2 })).rejects.toBeInstanceOf(ServiceError);
  expect(readFileSync(serviceJsonPath(home))).toEqual(original);
});

test("stale pid with a different start key is replaced without a signal", async () => {
  const home = freshHome();
  const record = serviceRecord({ pid: 424242, pgid: 424242, start_key: "old-start" });
  writeService(home, record);
  const inspector = new ScriptedInspector(record);
  inspector.holdLock = false;
  inspector.startKey = "live-start";
  const backend = new RecordingBackend({ supported: false });
  const endpoint = await startDetached(home, 0, {
    inspector,
    backend,
    termGraceSec: 0.3,
    killGraceSec: 0.3,
  });
  children.push(endpoint.pid);
  const document = JSON.parse(readFileSync(serviceJsonPath(home), "utf8")) as { pid: number };
  expect(document.pid).toBe(endpoint.pid);
  expect(document.pid).not.toBe(424242);
  const killed = backend.log.filter((item) => Array.isArray(item) && item[0] === "kill").map((item) => item[1]);
  expect(killed).not.toContain(424242);
  expect(threadHolds(startLockPath(home))).toBe(false);
  await stop(home, 0.4, 0.4);
  reapChild(endpoint.pid);
  children.splice(children.indexOf(endpoint.pid), 1);
}, 20000);

test("failed start does not signal when identity is unavailable", async () => {
  const home = freshHome();
  const backend = new RecordingBackend({ supported: false });
  const spawned: number[] = [];
  const kills: number[] = [];
  const realLaunch = svc.launchChild;
  svc.launchChild = async (directory, port) => {
    const [proc, parent] = await realLaunch(directory, port);
    spawned.push(proc.pid);
    const original = proc.kill.bind(proc);
    proc.kill = (signal) => {
      kills.push(proc.pid);
      original(signal);
    };
    return [proc, parent];
  };
  svc.kernelProcessIdentity = () => null;
  try {
    await expect(
      startDetached(home, 0, { backend, readyTimeout: 2, termGraceSec: 0.2, killGraceSec: 0.2 }),
    ).rejects.toBeInstanceOf(ServiceError);
  } finally {
    for (const pid of spawned) children.push(pid);
  }
  expect(spawned.length).toBeGreaterThan(0);
  expect(kills).toEqual([]);
  expect(backend.log).toEqual([]);
  expect(statExists(serviceJsonPath(home))).toBe(false);
}, 15000);

test("failed start signals only the identity captured after popen", async () => {
  const home = freshHome();
  const backend = new RecordingBackend({ supported: false });
  const spawned: number[] = [];
  const kills: number[] = [];
  const childPid: { pid?: number } = {};
  const lookups: string[] = [];
  const realLaunch = svc.launchChild;
  svc.kernelProcessIdentity = (pid) => {
    if (pid !== childPid.pid) return null;
    lookups.push("hit");
    if (lookups.length === 1) return "captured-start";
    return "reused-start";
  };
  svc.launchChild = async (directory, port) => {
    const [proc, parent] = await realLaunch(directory, port);
    childPid.pid = proc.pid;
    spawned.push(proc.pid);
    const original = proc.kill.bind(proc);
    proc.kill = (signal) => {
      kills.push(proc.pid);
      original(signal);
    };
    return [proc, parent];
  };
  svc.readReadyLine = async () => null;
  try {
    await expect(
      startDetached(home, 0, { backend, readyTimeout: 0.3, termGraceSec: 0.2, killGraceSec: 0.2 }),
    ).rejects.toBeInstanceOf(ServiceError);
  } finally {
    for (const pid of spawned) children.push(pid);
  }
  expect(spawned.length).toBeGreaterThan(0);
  expect(lookups.length).toBeGreaterThanOrEqual(2);
  expect(kills).toEqual([]);
  expect(backend.log.some((item) => Array.isArray(item) && item[0] === "kill")).toBe(false);
  expect(statExists(serviceJsonPath(home))).toBe(false);
}, 15000);

test("same start key without the service lock blocks start", async () => {
  const home = freshHome();
  const record = serviceRecord();
  writeService(home, record);
  const original = readFileSync(serviceJsonPath(home));
  const inspector = new ScriptedInspector(record);
  inspector.holdLock = false;
  const backend = new RecordingBackend({ supported: false });
  svc.launchChild = async () => {
    throw new Error("start spawned");
  };
  await expect(
    startDetached(home, 0, { inspector, backend, identityTimeout: 0.2 }),
  ).rejects.toBeInstanceOf(ServiceError);
  expect(backend.log).toEqual([]);
  expect(readFileSync(serviceJsonPath(home))).toEqual(original);
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


