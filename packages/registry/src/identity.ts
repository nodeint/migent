import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';

import { JSON_INDENT, MS_PER_SECOND } from '@nodeint/migent-kernel';

import { HTTP_OK, MAX_PORT } from './constants.js';
import { LockNotHeld, threadHolds } from './locks.js';
import { atomicReplace } from './store.js';

export const CORRUPT = Symbol('corrupt');
export const SERVICE_SCHEMA_VERSION = 2;

const serviceKeys = new Set(['schema_version', 'instance_id', 'pid', 'host', 'port', 'token', 'started_at']);
// Migent 0.1 identified the service by libc process identity instead of a local endpoint.
const legacyServiceKeys = new Set([...serviceKeys, 'pgid', 'start_key', 'boot_id', 'hostname']);

export class ServiceCorrupt extends Error {
  constructor() {
    super('service.json is corrupt.');
    this.name = 'ServiceCorrupt';
  }
}

export interface ServiceRecord {
  schema_version: number;
  instance_id: string;
  pid: number;
  host: string;
  port: number;
  token: string;
  started_at: string;
}

export function serviceJsonPath(home: string): string {
  return path.join(home, 'service.json');
}

export function startLockPath(home: string): string {
  return path.join(home, 'start.lock');
}

function sameKeySet(value: object, expected: Set<string>): boolean {
  const keys = Object.keys(value);
  if (keys.length !== expected.size) return false;
  return keys.every((key) => expected.has(key));
}

export function writeServiceJson(
  home: string,
  record: ServiceRecord | Record<string, unknown>,
  beforePublish: (home: string, record: ServiceRecord | Record<string, unknown>) => void,
): void {
  if (!threadHolds(startLockPath(home))) throw new LockNotHeld();
  beforePublish(home, record);
  atomicReplace(serviceJsonPath(home), Buffer.from(`${JSON.stringify(record, null, JSON_INDENT)}\n`, 'utf8'));
}

export async function removeServiceJsonIfUnchanged(
  home: string,
  instanceId: string,
  beforeUnlink: (home: string, instanceId: string) => void | Promise<void>,
): Promise<'absent' | 'changed' | 'removed'> {
  if (!threadHolds(startLockPath(home))) throw new LockNotHeld();
  await beforeUnlink(home, instanceId);
  const file = serviceJsonPath(home);
  if (!existsSync(file)) return 'absent';
  let record: ServiceRecord;
  try {
    record = parseServiceBytes(readFileSync(file));
  } catch {
    return 'changed';
  }
  if (record.instance_id === instanceId) {
    try {
      unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
      throw error;
    }
    return 'removed';
  }
  return 'changed';
}

export async function authenticatedInstanceId(port: number, token: string, timeoutSec: number): Promise<string | null> {
  try {
    const { status, raw } = await requestLocal(port, {
      method: 'GET',
      path: '/v1/health',
      headers: { Authorization: `Bearer ${token}`, Connection: 'close' },
      body: null,
      timeoutSec,
    });
    if (status !== HTTP_OK) return null;
    const payload = JSON.parse(raw.toString('utf8')) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const instanceId = (payload as { instance_id?: unknown }).instance_id;
    return typeof instanceId === 'string' ? instanceId : null;
  } catch {
    return null;
  }
}

export function readService(home: string): ServiceRecord | typeof CORRUPT | null {
  const file = serviceJsonPath(home);
  if (!existsSync(file)) return null;
  try {
    return parseServiceBytes(readFileSync(file));
  } catch {
    return CORRUPT;
  }
}

function parseServiceObject(raw: Buffer): Record<string, unknown> {
  if (raw.toString('utf8').trim() === '') throw new ServiceCorrupt();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ServiceCorrupt();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ServiceCorrupt();
  return parsed as Record<string, unknown>;
}

function validateServiceFields(record: Record<string, unknown>): void {
  for (const key of ['instance_id', 'host', 'token', 'started_at']) {
    if (typeof record[key] !== 'string' || record[key] === '') throw new ServiceCorrupt();
  }
  for (const key of ['pid', 'port']) {
    if (typeof record[key] !== 'number' || !Number.isInteger(record[key])) throw new ServiceCorrupt();
  }
  const port = record.port as number;
  if (port < 1 || port > MAX_PORT) throw new ServiceCorrupt();
}

export function parseServiceBytes(raw: Buffer): ServiceRecord {
  const record = parseServiceObject(raw);
  const keys = record.schema_version === 1 ? legacyServiceKeys : serviceKeys;
  if (record.schema_version !== 1 && record.schema_version !== SERVICE_SCHEMA_VERSION) throw new ServiceCorrupt();
  if (!sameKeySet(record, keys)) throw new ServiceCorrupt();
  validateServiceFields(record);
  return {
    schema_version: record.schema_version,
    instance_id: record.instance_id as string,
    pid: record.pid as number,
    host: record.host as string,
    port: record.port as number,
    token: record.token as string,
    started_at: record.started_at as string,
  };
}

export interface LocalRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer | null;
  readonly timeoutSec: number;
}

export async function requestLocal(port: number, request: LocalRequest): Promise<{ status: number; raw: Buffer }> {
  const { method, path: requestPath, headers, body, timeoutSec } = request;
  const { request: httpRequest } = await import('node:http');
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path: requestPath,
        headers,
        timeout: Math.max(1, timeoutSec * MS_PER_SECOND),
      },
      (response) => {
        readResponse(response).then(resolve, reject);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

async function readResponse(response: IncomingMessage): Promise<{ status: number; raw: Buffer }> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk as Buffer));
  return { status: response.statusCode ?? 0, raw: Buffer.concat(chunks) };
}
