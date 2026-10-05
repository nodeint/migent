import { realpathSync } from "node:fs";
import path from "node:path";
import { ServiceError, callService, endpointFromHome, ensureRegistryHome, startDetached } from "@migent/registry";
import { printError } from "../display.js";
import { findWorkspace, invocationCwdPath } from "../workspace.js";

export const workspaceApi = {
  startDetached,
  callService,
};

export async function runRegister(workspacePath: string | null, name: string | null): Promise<number> {
  const root = workspaceRoot(workspacePath);
  if (!path.isAbsolute(root)) {
    printError("Workspace path is not absolute.");
    return 2;
  }
  process.stderr.write(`Registering ${root}\n`);
  let endpoint;
  try {
    endpoint = await workspaceApi.startDetached(ensureRegistryHome());
  } catch (error) {
    if (error instanceof ServiceError) {
      printError(error.message);
      return 1;
    }
    throw error;
  }
  const body: Record<string, unknown> = { path: root, tool: { name: "migent", version: "0.1.0" } };
  if (name !== null) body.name = name;
  if (!path.isAbsolute(String(body.path))) {
    printError("Workspace path is not absolute.");
    return 2;
  }
  return finish("POST", "/v1/workspaces", endpoint, body);
}

export async function runWorkspaceList(asJson: boolean): Promise<number> {
  const endpoint = endpointFromHome(ensureRegistryHome());
  if (endpoint === null) {
    printError("Registry service is not running.");
    return 1;
  }
  let status: number;
  let payload: Record<string, unknown>;
  try {
    [status, payload] = await workspaceApi.callService(endpoint.host, endpoint.port, endpoint.token, "GET", "/v1/workspaces");
  } catch (error) {
    printError(`Registry request failed: ${errorText(error)}`);
    return 1;
  }
  if (status !== 200) return statusExit(status, payload);
  const rows = payload.workspaces;
  if (!Array.isArray(rows)) {
    printError("Registry response was invalid.");
    return 1;
  }
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ workspaces: rows })}\n`);
  } else {
    for (const row of rows) {
      const record = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
      const available = record.available ? "true" : "false";
      process.stdout.write(`${String(record.id)}  ${String(record.name)}  ${String(record.path)}  ${available}\n`);
    }
  }
  return 0;
}

export async function runRemove(workspaceId: string): Promise<number> {
  const endpoint = endpointFromHome(ensureRegistryHome());
  if (endpoint === null) {
    printError("Registry service is not running.");
    return 1;
  }
  return finish("DELETE", `/v1/workspaces/${workspaceId}`, endpoint, null);
}

async function finish(
  method: string,
  requestPath: string,
  endpoint: { host: string; port: number; token: string },
  body: Record<string, unknown> | null,
): Promise<number> {
  let status: number;
  let payload: Record<string, unknown>;
  try {
    [status, payload] = await workspaceApi.callService(
      endpoint.host,
      endpoint.port,
      endpoint.token,
      method,
      requestPath,
      body,
    );
  } catch (error) {
    printError(`Registry request failed: ${errorText(error)}`);
    return 1;
  }
  if (status === 200 || status === 201) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return 0;
  }
  return statusExit(status, payload);
}

function statusExit(status: number, payload: Record<string, unknown>): number {
  const message = payload.message;
  printError(typeof message === "string" && message ? message : "Registry request failed.");
  return status === 404 ? 2 : 1;
}

function workspaceRoot(workspacePath: string | null): string {
  const start =
    workspacePath === null ? invocationCwdPath() : path.resolve(invocationCwdPath(), workspacePath);
  return realpathSync(findWorkspace(start));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
