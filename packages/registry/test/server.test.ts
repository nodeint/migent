import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { MAX_BODY_BYTES, RegistryHTTPServer } from "../src/server.ts";
import { RegistryStore } from "../src/store.ts";
import { monotonic, sleep } from "../src/time.ts";
import { TOOL, makeWorkspace } from "./support.ts";

const TOKEN = "token-under-test-token-under-test-token-01";
const INSTANCE = "instance-under-test-instance-under-test-01";

class ServerFixture {
  readonly root: string;
  readonly home: string;
  readonly store: RegistryStore;
  server!: RegistryHTTPServer;
  port = 0;
  stop = false;
  private loop: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.root = root;
    this.home = path.join(root, "registry");
    mkdirSync(this.home);
    this.store = new RegistryStore(this.home);
  }

  async open(readDeadlineSec = 5): Promise<void> {
    this.server = await RegistryHTTPServer.open(this.store, TOKEN, INSTANCE, "127.0.0.1", 0, { readDeadlineSec });
    this.port = this.server.port;
    this.server.timeout = 0.2;
    this.loop = this.serve();
  }

  private async serve(): Promise<void> {
    while (!this.stop) {
      try {
        await this.server.handleRequest();
      } catch {
        break;
      }
    }
  }

  async close(): Promise<void> {
    this.stop = true;
    try {
      this.server.close();
    } catch {
      // already closed
    }
    await Promise.race([this.loop, sleep(2)]);
  }

  request(
    method: string,
    requestPath: string,
    body?: Buffer,
    token: string | null = TOKEN,
    headers: Record<string, string> = {},
  ): Promise<[number, Record<string, unknown>]> {
    const payloadHeaders: Record<string, string> = { Connection: "close", ...headers };
    if (token !== null) payloadHeaders.Authorization = `Bearer ${token}`;
    if (body !== undefined) {
      payloadHeaders["Content-Type"] = "application/json";
      payloadHeaders["Content-Length"] = String(body.length);
    }
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: this.port, method, path: requestPath, headers: payloadHeaders, timeout: 2000 },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            let parsed: unknown = {};
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              parsed = {};
            }
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) parsed = {};
            resolve([response.statusCode ?? 0, parsed as Record<string, unknown>]);
          });
        },
      );
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }
}

async function post(fixture: ServerFixture, workspace: string): Promise<[number, Record<string, unknown>]> {
  return fixture.request("POST", "/v1/workspaces", Buffer.from(JSON.stringify({ path: workspace, tool: TOOL })));
}

function readHttpMessage(socket: net.Socket): Promise<Buffer> {
  socket.setTimeout(2000);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (piece: Buffer): void => {
      chunks.push(piece);
      const joined = Buffer.concat(chunks);
      const headerEnd = joined.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = joined.subarray(0, headerEnd);
      const rest = joined.subarray(headerEnd + 4);
      const length = contentLength(header);
      if (length === null || rest.length >= length) {
        cleanup();
        resolve(Buffer.concat([header, Buffer.from("\r\n\r\n"), rest.subarray(0, length ?? rest.length)]));
      }
    };
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("error", reject);
      socket.off("timeout", onTimeout);
    };
    const onTimeout = (): void => {
      cleanup();
      reject(new Error("response timeout"));
    };
    socket.on("data", onData);
    socket.on("error", reject);
    socket.on("timeout", onTimeout);
  });
}

function contentLength(header: Buffer): number | null {
  for (const line of header.toString("utf8").split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    if (line.slice(0, separator).toLowerCase() === "content-length") {
      const value = Number(line.slice(separator + 1).trim());
      return Number.isInteger(value) ? value : null;
    }
  }
  return null;
}

async function waitUntil(predicate: () => boolean, timeoutSec: number): Promise<void> {
  const deadline = monotonic() + timeoutSec;
  while (monotonic() < deadline) {
    if (predicate()) return;
    await sleep(0.01);
  }
  throw new Error("condition was not met");
}

let envHome = process.env.MIGENT_HOME;
let homeDir = "";
let cwd = process.cwd();

afterEach(() => {
  process.chdir(cwd);
  if (envHome === undefined) delete process.env.MIGENT_HOME;
  else process.env.MIGENT_HOME = envHome;
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
});

function freshRoot(): string {
  cwd = process.cwd();
  envHome = process.env.MIGENT_HOME;
  homeDir = mkdtempSync(path.join(tmpdir(), "registry-agent-home-"));
  process.env.MIGENT_HOME = homeDir;
  return mkdtempSync(path.join(tmpdir(), "registry-server-"));
}

test("daemon threads is set on the subclass body", () => {
  expect(Object.hasOwn(RegistryHTTPServer, "daemonThreads")).toBe(true);
  expect(RegistryHTTPServer.daemonThreads).toBe(true);
});

test("health auth and workspace routes", async () => {
  const fixture = new ServerFixture(freshRoot());
  await fixture.open();
  try {
    expect(fixture.server.store).toBe(fixture.store);
    const [healthStatus, health] = await fixture.request("GET", "/v1/health", undefined, null);
    expect(healthStatus).toBe(200);
    expect(health).toEqual({ ok: true });
    const [authedStatus, authed] = await fixture.request("GET", "/v1/health");
    expect(authedStatus).toBe(200);
    expect(authed.instance_id).toBe(fixture.server.instanceId);
    expect((await fixture.request("GET", "/v1/health", undefined, "nope"))[0]).toBe(401);
    expect((await fixture.request("GET", "/v1/workspaces", undefined, "nope"))[0]).toBe(401);
    const workspace = makeWorkspace(fixture.root, "demo");
    const created = await post(fixture, workspace);
    expect(created[0]).toBe(201);
    const refreshed = await post(fixture, workspace);
    expect(refreshed[0]).toBe(200);
    expect(refreshed[1].id).toBe(created[1].id);
    const [listStatus, listing] = await fixture.request("GET", "/v1/workspaces");
    expect(listStatus).toBe(200);
    expect((listing.workspaces as Array<{ available: boolean }>)[0]?.available).toBe(true);
    const [fetchedStatus, fetched] = await fixture.request("GET", `/v1/workspaces/${String(created[1].id)}`);
    expect(fetchedStatus).toBe(200);
    expect(fetched.available).toBe(true);
    expect((await fixture.request("DELETE", `/v1/workspaces/${String(created[1].id)}`))[0]).toBe(200);
    const [missingStatus, missing] = await fixture.request("GET", `/v1/workspaces/${String(created[1].id)}`);
    expect(missingStatus).toBe(404);
    expect(missing.error).toBe("workspace_not_found");
    expect((await fixture.request("POST", "/v1/workspaces", Buffer.from("not-json")))[0]).toBe(400);
    expect(
      (
        await fixture.request(
          "POST",
          "/v1/workspaces",
          Buffer.from(JSON.stringify({ path: workspace, tool: TOOL, extra: 1 })),
        )
      )[0],
    ).toBe(400);
    const registry = path.join(fixture.home, "registry.json");
    writeFileSync(registry, "{");
    const [corruptStatus, corrupt] = await fixture.request(
      "POST",
      "/v1/workspaces",
      Buffer.from(JSON.stringify({ path: workspace, tool: TOOL })),
    );
    expect(corruptStatus).toBe(409);
    expect(corrupt.error).toBe("registry_corrupt");
    expect(readFileSync(registry)).toEqual(Buffer.from("{"));
  } finally {
    await fixture.close();
  }
});

test("relative path is rejected even when cwd contains the workspace", async () => {
  const fixture = new ServerFixture(freshRoot());
  await fixture.open();
  try {
    const workspace = makeWorkspace(fixture.root, "demo");
    process.chdir(fixture.root);
    expect((await post(fixture, path.basename(workspace)))[0]).toBe(400);
    expect(existsSync(path.join(fixture.home, "registry.json"))).toBe(false);
    const [status, created] = await post(fixture, workspace);
    expect(status).toBe(201);
    expect(created.path).toBe(realpathSync(workspace));
    for (const relative of ["~/somewhere", "../escape"]) {
      expect((await post(fixture, relative))[0]).toBe(400);
    }
    const listing = await fixture.store.list();
    expect(listing.map((row) => row.path)).toEqual([realpathSync(workspace)]);
  } finally {
    await fixture.close();
  }
});

test("body cap rejects before the body arrives", async () => {
  const fixture = new ServerFixture(freshRoot());
  await fixture.open();
  try {
    const registry = path.join(fixture.home, "registry.json");
    const header = Buffer.concat([
      Buffer.from("POST /v1/workspaces HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: "),
      Buffer.from(String(MAX_BODY_BYTES + 1)),
      Buffer.from("\r\n\r\n"),
    ]);
    const started = monotonic();
    const sock = net.connect({ host: "127.0.0.1", port: fixture.port });
    await new Promise((resolve) => sock.once("connect", resolve));
    sock.write(header);
    const raw = await readHttpMessage(sock);
    sock.destroy();
    expect(monotonic() - started).toBeLessThan(0.5);
    expect(raw.includes(" 413 ")).toBe(true);
    expect(existsSync(registry)).toBe(false);
    const missing = net.connect({ host: "127.0.0.1", port: fixture.port });
    await new Promise((resolve) => missing.once("connect", resolve));
    missing.write(Buffer.from("POST /v1/workspaces HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"));
    const missingRaw = await readHttpMessage(missing);
    missing.destroy();
    expect(missingRaw.includes(" 400 ")).toBe(true);
    expect(missingRaw.includes("Content-Length")).toBe(true);
  } finally {
    await fixture.close();
  }
});

test("keepalive answers a second request on the same connection", async () => {
  const fixture = new ServerFixture(freshRoot());
  await fixture.open();
  try {
    const sock = net.connect({ host: "127.0.0.1", port: fixture.port });
    await new Promise((resolve) => sock.once("connect", resolve));
    sock.write(Buffer.from("GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"));
    const first = await readHttpMessage(sock);
    expect(first.includes("HTTP/1.1 200 ")).toBe(true);
    expect(first.includes("Connection: close")).toBe(false);
    expect(first.includes('"ok":true')).toBe(true);
    sock.write(Buffer.from("GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"));
    const second = await readHttpMessage(sock);
    sock.destroy();
    expect(second.includes("HTTP/1.1 200 ")).toBe(true);
    expect(second.includes('"ok":true')).toBe(true);
  } finally {
    await fixture.close();
  }
});

test("oversized digit content length returns 413 without reading the body", async () => {
  const fixture = new ServerFixture(freshRoot());
  await fixture.open();
  try {
    const registry = path.join(fixture.home, "registry.json");
    const header = Buffer.concat([
      Buffer.from("POST /v1/workspaces HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: "),
      Buffer.from("9".repeat(4301)),
      Buffer.from("\r\n\r\n"),
    ]);
    const started = monotonic();
    const sock = net.connect({ host: "127.0.0.1", port: fixture.port });
    await new Promise((resolve) => sock.once("connect", resolve));
    sock.write(header);
    const raw = await readHttpMessage(sock);
    sock.destroy();
    expect(monotonic() - started).toBeLessThan(0.5);
    expect(raw.includes(" 413 ")).toBe(true);
    expect(raw.includes("payload_too_large")).toBe(true);
    expect(existsSync(registry)).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("stalled body returns 408 and a later post succeeds", async () => {
  const fixture = new ServerFixture(freshRoot());
  await fixture.open(0.2);
  try {
    const previous = fixture.server.inFlight;
    const sock = net.connect({ host: "127.0.0.1", port: fixture.port });
    await new Promise((resolve) => sock.once("connect", resolve));
    await waitUntil(() => fixture.server.inFlight === previous + 1, 1);
    const started = monotonic();
    sock.write(Buffer.from("POST /v1/workspaces HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 20\r\n\r\nx"));
    const raw = await readHttpMessage(sock);
    await waitUntil(() => fixture.server.inFlight === previous, 1);
    sock.destroy();
    expect(monotonic() - started).toBeLessThan(1);
    expect(raw.includes(" 408 ")).toBe(true);
    const workspace = makeWorkspace(fixture.root, "later");
    expect((await post(fixture, workspace))[0]).toBe(201);
  } finally {
    await fixture.close();
  }
});

test("slow drip releases the handler before a restarted timeout would", async () => {
  const fixture = new ServerFixture(freshRoot());
  await fixture.open(0.4);
  try {
    const previous = fixture.server.inFlight;
    const payload = Buffer.from("POST /v1/workspaces HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\n\r\n{}");
    expect(payload.subarray(0, payload.indexOf("\r\n")).length).toBeGreaterThan(15);
    const sock = net.connect({ host: "127.0.0.1", port: fixture.port });
    await new Promise((resolve) => sock.once("connect", resolve));
    await waitUntil(() => fixture.server.inFlight === previous + 1, 1);
    const started = monotonic();
    for (let index = 0; index < payload.length; index += 1) {
      try {
        sock.write(payload.subarray(index, index + 1));
      } catch {
        break;
      }
      if (fixture.server.inFlight === previous) break;
      if (index + 1 < payload.length) await sleep(0.1);
    }
    await waitUntil(() => fixture.server.inFlight === previous, 2);
    const elapsed = monotonic() - started;
    sock.destroy();
    expect(elapsed).toBeLessThan(0.9);
    expect(existsSync(path.join(fixture.home, "registry.json"))).toBe(false);
    const workspace = makeWorkspace(fixture.root, "later");
    expect((await post(fixture, workspace))[0]).toBe(201);
  } finally {
    await fixture.close();
  }
});

test("overlapping posts both remain", async () => {
  const fixture = new ServerFixture(freshRoot());
  await fixture.open();
  try {
    const first = makeWorkspace(fixture.root, "one");
    const second = makeWorkspace(fixture.root, "two");
    let entered = false;
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.store.lockedHook = async () => {
      entered = true;
      await Promise.race([released, sleep(3)]);
    };
    const results: Array<[number, Record<string, unknown>]> = [];
    const left = post(fixture, first).then((result) => results.push(result));
    const started = Date.now();
    while (!entered && Date.now() - started < 2000) await sleep(0.02);
    expect(entered).toBe(true);
    let rightDone = false;
    const right = post(fixture, second).then((result) => {
      rightDone = true;
      results.push(result);
    });
    await sleep(0.3);
    expect(rightDone).toBe(false);
    release();
    await left;
    await right;
    expect(results.map((item) => item[0]).sort()).toEqual([201, 201]);
    const listing = await fixture.store.list();
    expect(new Set(listing.map((row) => row.path))).toEqual(new Set([realpathSync(first), realpathSync(second)]));
  } finally {
    await fixture.close();
  }
});
