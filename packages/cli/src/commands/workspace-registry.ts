import { realpathSync } from 'node:fs';
import path from 'node:path';

import { type Static,WorkspaceList, WorkspaceMutation } from '@nodeint/migent-contracts';
import { callService, endpointFromHome, ensureRegistryHome, HTTP_CREATED, HTTP_NOT_FOUND, HTTP_OK, ServiceError, startDetached } from '@nodeint/migent-registry';

import { printError } from '../display.js';
import { writeJson } from '../emit.js';
import { EXIT_CONFIG } from '../exits.js';
import { PACKAGE_VERSION } from '../version.js';
import { findWorkspace, invocationCwdPath } from '../workspace.js';

export const workspaceApi = {
  startDetached,
  callService,
};

export async function runRegister(workspacePath: string | null, name: string | null): Promise<number> {
  const root = workspaceRoot(workspacePath);
  if (!path.isAbsolute(root)) {
    printError('Workspace path is not absolute.');
    return EXIT_CONFIG;
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
  const body: Record<string, unknown> = { path: root, tool: { name: 'migent', version: PACKAGE_VERSION } };
  if (name !== null) body.name = name;
  if (!path.isAbsolute(String(body.path))) {
    printError('Workspace path is not absolute.');
    return EXIT_CONFIG;
  }
  return finish(endpoint, { method: 'POST', path: '/v1/workspaces', body });
}

export async function runWorkspaceList(asJson: boolean): Promise<number> {
  const endpoint = endpointFromHome(ensureRegistryHome());
  if (endpoint === null) {
    printError('Registry service is not running.');
    return 1;
  }
  let status: number;
  let payload: Record<string, unknown>;
  try {
    [status, payload] = await workspaceApi.callService(endpoint, { method: 'GET', path: '/v1/workspaces' });
  } catch (error) {
    printError(`Registry request failed: ${errorText(error)}`);
    return 1;
  }
  if (status !== HTTP_OK) return statusExit(status, payload);
  const rows = payload.workspaces;
  if (!Array.isArray(rows)) {
    printError('Registry response was invalid.');
    return 1;
  }
  if (asJson) writeJson(WorkspaceList, { workspaces: rows as Static<typeof WorkspaceList>['workspaces'] });
  else printWorkspaceRows(rows);
  return 0;
}

function printWorkspaceRows(rows: readonly unknown[]): void {
  for (const row of rows) {
    const record = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
    const available = record.available ? 'true' : 'false';
    process.stdout.write(`${String(record.id)}  ${String(record.name)}  ${String(record.path)}  ${available}\n`);
  }
}

export async function runRemove(workspaceId: string): Promise<number> {
  const endpoint = endpointFromHome(ensureRegistryHome());
  if (endpoint === null) {
    printError('Registry service is not running.');
    return 1;
  }
  return finish(endpoint, { method: 'DELETE', path: `/v1/workspaces/${workspaceId}`, body: null });
}

async function finish(
  endpoint: { host: string; port: number; token: string },
  request: { method: string; path: string; body: Record<string, unknown> | null },
): Promise<number> {
  const { method, path: requestPath, body } = request;
  let status: number;
  let payload: Record<string, unknown>;
  try {
    [status, payload] = await workspaceApi.callService(endpoint, { method, path: requestPath, body });
  } catch (error) {
    printError(`Registry request failed: ${errorText(error)}`);
    return 1;
  }
  if (status === HTTP_OK || status === HTTP_CREATED) {
    writeJson(WorkspaceMutation, payload as Static<typeof WorkspaceMutation>);
    if (method === 'POST') {
      const id = typeof payload.id === 'string' && payload.id !== '' ? payload.id : 'workspace';
      process.stderr.write(`Registered ${id}.\n`);
    } else if (method === 'DELETE') {
      const id = requestPath.split('/').pop() ?? 'workspace';
      process.stderr.write(`Removed ${id}.\n`);
    }
    return 0;
  }
  return statusExit(status, payload);
}

function statusExit(status: number, payload: Record<string, unknown>): number {
  const {message} = payload;
  printError(typeof message === 'string' && message ? message : 'Registry request failed.');
  return status === HTTP_NOT_FOUND ? EXIT_CONFIG : 1;
}

function workspaceRoot(workspacePath: string | null): string {
  const start =
    workspacePath === null ? invocationCwdPath() : path.resolve(invocationCwdPath(), workspacePath);
  return realpathSync(findWorkspace(start));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
