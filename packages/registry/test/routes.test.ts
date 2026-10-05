import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { Call, Result, ValueError, buildRouter, type Router } from "../src/routes.ts";
import { RegistryBusy, RegistryStore } from "../src/store.ts";
import { INSTANCE, TOKEN, TOOL, makeWorkspace } from "./support.ts";

let cwd = process.cwd();

afterEach(() => {
  process.chdir(cwd);
});

function setup(): { root: string; home: string; store: RegistryStore; router: Router } {
  cwd = process.cwd();
  const root = mkdtempSync(path.join(tmpdir(), "registry-routes-"));
  const home = path.join(root, "registry");
  mkdirSync(home);
  return { root, home, store: new RegistryStore(home), router: buildRouter() };
}

async function dispatch(
  router: Router,
  store: RegistryStore,
  method: string,
  requestPath: string,
  options: { body?: Buffer | null; authorization?: string | null; beforeStore?: () => void } = {},
): Promise<Result> {
  const call = new Call({
    method,
    path: requestPath,
    store,
    token: TOKEN,
    instanceId: INSTANCE,
    authorization: Object.hasOwn(options, "authorization") ? options.authorization ?? null : `Bearer ${TOKEN}`,
    body: options.body ?? null,
    beforeStore: options.beforeStore,
  });
  return router.dispatch(call);
}

async function post(router: Router, store: RegistryStore, filePath: string): Promise<Result> {
  const body = Buffer.from(JSON.stringify({ path: filePath, tool: TOOL }));
  return dispatch(router, store, "POST", "/v1/workspaces", { body });
}

test("health reports the instance only to the bearer", async () => {
  const { store, router } = setup();
  const absent = await dispatch(router, store, "GET", "/v1/health", { authorization: null });
  expect(absent.status).toBe(200);
  expect(absent.payload).toEqual({ ok: true });
  const authed = await dispatch(router, store, "GET", "/v1/health");
  expect(authed.status).toBe(200);
  expect(authed.payload.instance_id).toBe(INSTANCE);
  const denied = await dispatch(router, store, "GET", "/v1/health", { authorization: "Bearer nope" });
  expect(denied.status).toBe(401);
  expect(denied.payload.error).toBe("unauthorized");
});

test("health rejects another method before the body", async () => {
  const { store, router } = setup();
  expect(router.shouldReadBody("POST", "/v1/health")).toBe(false);
  expect(router.shouldReadBody("POST", "/v1/workspaces")).toBe(true);
  expect(router.shouldReadBody("GET", "/v1/workspaces")).toBe(false);
  const denied = await dispatch(router, store, "POST", "/v1/health", { authorization: null });
  expect(denied.status).toBe(401);
  const rejected = await dispatch(router, store, "POST", "/v1/health");
  expect(rejected.status).toBe(405);
  expect(rejected.payload.error).toBe("method_not_allowed");
});

test("a protected route requires a bearer before it runs", async () => {
  const { store, router } = setup();
  const missing = await dispatch(router, store, "GET", "/v1/workspaces", { authorization: null });
  expect(missing.status).toBe(401);
  const spaced = await dispatch(router, store, "GET", "/v1/workspaces", { authorization: "Bearer one two" });
  expect(spaced.status).toBe(401);
  const unknown = await dispatch(router, store, "GET", "/v1/missing");
  expect(unknown.status).toBe(404);
  expect(unknown.payload.error).toBe("workspace_not_found");
  expect(unknown.payload.message).toBe("Not found.");
  const hidden = await dispatch(router, store, "GET", "/v1/missing", { authorization: null });
  expect(hidden.status).toBe(401);
  const wrong = await dispatch(router, store, "PUT", "/v1/workspaces");
  expect(wrong.status).toBe(405);
  expect((await dispatch(router, store, "PUT", "/v1/workspaces", { authorization: null })).status).toBe(401);
});

test("register lists fetches and removes a workspace", async () => {
  const { root, store, router } = setup();
  const workspace = makeWorkspace(root, "demo");
  const created = await post(router, store, workspace);
  expect(created.status).toBe(201);
  const again = await post(router, store, workspace);
  expect(again.status).toBe(200);
  expect(again.payload.id).toBe(created.payload.id);
  const listing = await dispatch(router, store, "GET", "/v1/workspaces");
  expect(listing.status).toBe(200);
  expect((listing.payload.workspaces as Array<{ available: boolean }>)[0]?.available).toBe(true);
  const fetched = await dispatch(router, store, "GET", `/v1/workspaces/${String(created.payload.id)}`);
  expect(fetched.status).toBe(200);
  expect(fetched.payload.available).toBe(true);
  const removed = await dispatch(router, store, "DELETE", `/v1/workspaces/${String(created.payload.id)}`);
  expect(removed.status).toBe(200);
  const missing = await dispatch(router, store, "GET", `/v1/workspaces/${String(created.payload.id)}`);
  expect(missing.status).toBe(404);
  expect(missing.payload.error).toBe("workspace_not_found");
});

test("register rejects a bad body before the store", async () => {
  const { root, home, store, router } = setup();
  const workspace = makeWorkspace(root, "demo");
  const entered: string[] = [];
  const cases: Array<[Buffer, string]> = [
    [Buffer.from("not-json"), "Request body is not JSON."],
    [Buffer.from(JSON.stringify({ path: workspace, tool: TOOL, extra: 1 })), "Request fields are invalid."],
    [Buffer.from(JSON.stringify({ path: workspace })), "Tool name is invalid."],
    [Buffer.from(JSON.stringify({ path: 1, tool: TOOL })), "Workspace path is not absolute."],
    [Buffer.from(JSON.stringify({ path: workspace, name: "x".repeat(201), tool: TOOL })), "Workspace name is invalid."],
  ];
  for (const [body, message] of cases) {
    entered.length = 0;
    const result = await dispatch(router, store, "POST", "/v1/workspaces", {
      body,
      beforeStore: () => entered.push("entered"),
    });
    expect(result.status, message).toBe(400);
    expect(result.payload.message).toBe(message);
    expect(entered).toEqual([]);
    expect(existsSync(path.join(home, "registry.json"))).toBe(false);
  }
});

test("relative path is rejected even when cwd contains the workspace", async () => {
  const { root, home, store, router } = setup();
  const workspace = makeWorkspace(root, "demo");
  process.chdir(root);
  const rejected = await post(router, store, path.basename(workspace));
  expect(rejected.status).toBe(400);
  expect(existsSync(path.join(home, "registry.json"))).toBe(false);
  const created = await post(router, store, workspace);
  expect(created.status).toBe(201);
  expect(created.payload.path).toBe(realpathSync(workspace));
  for (const relative of ["~/somewhere", "../escape"]) {
    expect((await post(router, store, relative)).status).toBe(400);
  }
  const listing = await store.list();
  expect(listing.map((row) => row.path)).toEqual([realpathSync(workspace)]);
});

test("a corrupt registry stays unchanged", async () => {
  const { root, home, store, router } = setup();
  const workspace = makeWorkspace(root, "demo");
  const registry = path.join(home, "registry.json");
  writeFileSync(registry, "{");
  const result = await post(router, store, workspace);
  expect(result.status).toBe(409);
  expect(result.payload.error).toBe("registry_corrupt");
  expect(readFileSync(registry)).toEqual(Buffer.from("{"));
});

test("a busy registry is reported without the store exception", async () => {
  const { store, router } = setup();
  store.list = () => {
    throw new RegistryBusy("held");
  };
  const result = await dispatch(router, store, "GET", "/v1/workspaces");
  expect(result.status).toBe(409);
  expect(result.payload.error).toBe("registry_busy");
  expect(result.payload.message).toBe("The registry is busy.");
});

test("store access runs the deadline hook first", async () => {
  const { store, router } = setup();
  const seen: string[] = [];
  await dispatch(router, store, "GET", "/v1/workspaces", { beforeStore: () => seen.push("entered") });
  expect(seen).toEqual(["entered"]);
});

test("an added route receives its path segment", async () => {
  const { store, router } = setup();
  const captured: string[] = [];
  const echo = (call: Call): Result => {
    captured.push(call.params.workspace_id ?? "");
    return new Result(200, { id: call.params.workspace_id });
  };
  router.route("GET", "/v1/echo/{workspace_id}")(echo);
  const result = await dispatch(router, store, "GET", "/v1/echo/ws_abc");
  expect(result.payload).toEqual({ id: "ws_abc" });
  expect(captured).toEqual(["ws_abc"]);
  expect((await dispatch(router, store, "GET", "/v1/echo")).status).toBe(404);
  expect((await dispatch(router, store, "GET", "/v1/echo/ws_abc/more")).status).toBe(404);
  expect(() => router.route("GET", "/v1/{workspace_id}/child")(echo)).toThrow(ValueError);
});

test("a nested workspace path is not found", async () => {
  const { store, router } = setup();
  const result = await dispatch(router, store, "GET", "/v1/workspaces/ws_one/child");
  expect(result.status).toBe(404);
});
