import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { RequestError } from "@hono/node-server";
import {
  InvalidRecord,
  NotAWorkspace,
  RegistryBusy,
  RegistryCorrupt,
  WorkspaceNotFound,
  type WorkspacePublic,
} from "./store.js";
import { WorkspaceLocationError, locateWorkspace } from "./workspace.js";

export type Auth = "required" | "health";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

export class Result {
  readonly status: number;
  readonly payload: Record<string, unknown>;

  constructor(status: number, payload: Record<string, unknown>) {
    this.status = status;
    this.payload = payload;
  }
}

export interface WorkspaceRecords {
  list(): Promise<WorkspacePublic[]> | WorkspacePublic[];
  get(workspaceId: string): Promise<WorkspacePublic> | WorkspacePublic;
  remove(workspaceId: string): Promise<WorkspacePublic> | WorkspacePublic;
  register(
    filePath: string,
    name: string | null,
    tool: unknown,
  ): Promise<[WorkspacePublic, boolean]> | [WorkspacePublic, boolean];
}

const noop = (): void => undefined;

export class Call {
  method: string;
  path: string;
  store: WorkspaceRecords;
  token: string;
  instanceId: string;
  authorization: string | null;
  body: Buffer | null;
  beforeStore: () => void;
  params: Record<string, string>;

  constructor(options: {
    method: string;
    path: string;
    store: WorkspaceRecords;
    token: string;
    instanceId: string;
    authorization?: string | null;
    body?: Buffer | null;
    beforeStore?: () => void;
    params?: Record<string, string>;
  }) {
    this.method = options.method;
    this.path = options.path;
    this.store = options.store;
    this.token = options.token;
    this.instanceId = options.instanceId;
    this.authorization = options.authorization ?? null;
    this.body = options.body ?? null;
    this.beforeStore = options.beforeStore ?? noop;
    this.params = options.params ?? {};
  }

  jsonObject(allowed: Set<string>, required: Set<string>): Record<string, unknown> {
    const raw = this.body ?? Buffer.alloc(0);
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new HttpError(400, "invalid_request", "Request body is not JSON.");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new HttpError(400, "invalid_request", "Request fields are invalid.");
    }
    const record = payload as Record<string, unknown>;
    const keys = new Set(Object.keys(record));
    for (const key of keys) {
      if (!allowed.has(key)) throw new HttpError(400, "invalid_request", "Request fields are invalid.");
    }
    for (const key of required) {
      if (!keys.has(key)) throw new HttpError(400, "invalid_request", "Request fields are invalid.");
    }
    return record;
  }
}

interface Route {
  method: string;
  pattern: string;
  handler: (call: Call) => Result | Promise<Result>;
  auth: Auth;
  answerBeforeBody: boolean;
}

class GatedStore implements WorkspaceRecords {
  private readonly inner: WorkspaceRecords;
  private readonly before: () => void;

  constructor(inner: WorkspaceRecords, before: () => void) {
    this.inner = inner;
    this.before = before;
  }

  async list(): Promise<WorkspacePublic[]> {
    this.before();
    return this.inner.list();
  }

  async get(workspaceId: string): Promise<WorkspacePublic> {
    this.before();
    return this.inner.get(workspaceId);
  }

  async remove(workspaceId: string): Promise<WorkspacePublic> {
    this.before();
    return this.inner.remove(workspaceId);
  }

  async register(filePath: string, name: string | null, tool: unknown): Promise<[WorkspacePublic, boolean]> {
    this.before();
    return this.inner.register(filePath, name, tool);
  }
}

function failure(status: number, code: string, message: string): Result {
  return new Result(status, { error: code, message });
}

function unauthorized(): Result {
  return failure(401, "unauthorized", "Bearer token is missing or incorrect.");
}

function failureForStore(error: unknown): Result | null {
  if (error instanceof RegistryBusy) return failure(409, "registry_busy", "The registry is busy.");
  if (error instanceof RegistryCorrupt) {
    return failure(409, "registry_corrupt", "registry.json is corrupt and was left unchanged.");
  }
  if (error instanceof WorkspaceNotFound) return failure(404, "workspace_not_found", error.message);
  if (error instanceof InvalidRecord || error instanceof NotAWorkspace) {
    return failure(400, "invalid_request", error.message);
  }
  return null;
}

export function matchPath(pattern: string, requestPath: string): Record<string, string> | null {
  const marker = pattern.lastIndexOf("{");
  if (marker === -1) return pattern === requestPath ? {} : null;
  const prefix = pattern.slice(0, marker);
  const name = pattern.slice(marker + 1, -1);
  if (!requestPath.startsWith(prefix)) return null;
  const value = requestPath.slice(prefix.length);
  if (value === "" || value.includes("/")) return null;
  return { [name]: value };
}

function checkPattern(pattern: string): void {
  if (!pattern.includes("{") && !pattern.includes("}")) return;
  const marker = pattern.lastIndexOf("{");
  const name = pattern.slice(marker + 1, -1);
  const braces = pattern.split("{").length - 1;
  if (
    braces !== 1 ||
    !pattern.endsWith("}") ||
    pattern.slice(marker).includes("/") ||
    name === "" ||
    !pattern.slice(0, marker).endsWith("/")
  ) {
    throw new ValueError("A route pattern is an exact path or one trailing {name} segment.");
  }
}

export function authState(authorization: string | null, token: string): "ok" | "absent" | "bad" {
  if (authorization === null) return "absent";
  const splitAt = authorization.indexOf(" ");
  const scheme = splitAt === -1 ? authorization : authorization.slice(0, splitAt);
  const rest = splitAt === -1 ? "" : authorization.slice(splitAt + 1);
  const presented = rest.trim();
  if (scheme !== "Bearer" || presented === "" || presented.includes(" ")) return "bad";
  try {
    const left = Buffer.from(presented);
    const right = Buffer.from(token);
    if (left.length !== right.length || !timingSafeEqual(left, right)) return "bad";
  } catch {
    return "bad";
  }
  return "ok";
}

export class Router {
  private readonly routes: Route[] = [];
  readonly hono: Hono;

  constructor() {
    this.hono = new Hono();
    this.hono.all("*", async (c) => {
      try {
        const call = (c.env as { call?: Call }).call;
        if (!call) throw new RequestError("Missing registry call.");
        const result = await this.dispatch(call);
        return new Response(JSON.stringify(result.payload), {
          status: result.status,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        });
      } catch (error) {
        if (error instanceof RequestError) {
          return new Response(JSON.stringify({ error: "invalid_request", message: error.message }), {
            status: 400,
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          });
        }
        throw error;
      }
    });
  }

  route(
    method: string,
    pattern: string,
    options: { auth?: Auth; answerBeforeBody?: boolean } = {},
  ): (handler: (call: Call) => Result | Promise<Result>) => (call: Call) => Result | Promise<Result> {
    return (handler) => {
      checkPattern(pattern);
      this.routes.push({
        method,
        pattern,
        handler,
        auth: options.auth ?? "required",
        answerBeforeBody: options.answerBeforeBody ?? false,
      });
      return handler;
    };
  }

  shouldReadBody(method: string, requestPath: string): boolean {
    if (method !== "POST") return false;
    for (const route of this.routes) {
      if (route.answerBeforeBody && matchPath(route.pattern, requestPath) !== null) return false;
    }
    return true;
  }

  async dispatch(call: Call): Promise<Result> {
    call.store = new GatedStore(call.store, call.beforeStore);
    const matched: Array<[Route, Record<string, string>]> = [];
    for (const route of this.routes) {
      const params = matchPath(route.pattern, call.path);
      if (params !== null) matched.push([route, params]);
    }
    const chosen = matched.filter(([route]) => route.method === call.method);
    if (chosen.length === 0) {
      if (authState(call.authorization, call.token) !== "ok") return unauthorized();
      if (matched.length === 0) return failure(404, "workspace_not_found", "Not found.");
      return failure(405, "method_not_allowed", "Method is not allowed.");
    }
    const [route, params] = chosen[0]!;
    call.params = params;
    if (route.auth !== "health" && authState(call.authorization, call.token) !== "ok") return unauthorized();
    try {
      return await route.handler(call);
    } catch (error) {
      if (error instanceof HttpError) return failure(error.status, error.code, error.message);
      const mapped = failureForStore(error);
      if (mapped) return mapped;
      throw error;
    }
  }
}

export function buildRouter(): Router {
  const router = new Router();

  router.route("GET", "/v1/health", { auth: "health", answerBeforeBody: true })((call) => {
    const state = authState(call.authorization, call.token);
    if (state === "bad") return unauthorized();
    if (state === "ok") return new Result(200, { ok: true, instance_id: call.instanceId });
    return new Result(200, { ok: true });
  });

  router.route("GET", "/v1/workspaces")(async (call) => new Result(200, { workspaces: await call.store.list() }));

  router.route("POST", "/v1/workspaces")(async (call) => {
    const payload = call.jsonObject(new Set(["path", "name", "tool"]), new Set(["path"]));
    const rawPath = payload.path;
    if (typeof rawPath !== "string") throw new HttpError(400, "invalid_request", "Workspace path is not absolute.");
    const name = payload.name;
    if (Object.hasOwn(payload, "name") && (typeof name !== "string" || name.length < 1 || name.length > 200)) {
      throw new HttpError(400, "invalid_request", "Workspace name is invalid.");
    }
    if (!Object.hasOwn(payload, "tool")) throw new HttpError(400, "invalid_request", "Tool name is invalid.");
    let root: string;
    try {
      root = locateWorkspace(rawPath);
    } catch (error) {
      if (error instanceof WorkspaceLocationError) {
        throw new HttpError(400, "invalid_request", error.message);
      }
      throw error;
    }
    const [record, created] = await call.store.register(root, typeof name === "string" ? name : null, payload.tool);
    return new Result(created ? 201 : 200, { ...record });
  });

  router.route("GET", "/v1/workspaces/{workspace_id}")(async (call) => {
    const record = await call.store.get(call.params.workspace_id ?? "");
    return new Result(200, { ...record });
  });

  router.route("DELETE", "/v1/workspaces/{workspace_id}")(async (call) => {
    const record = await call.store.remove(call.params.workspace_id ?? "");
    return new Result(200, { ...record });
  });

  return router;
}
