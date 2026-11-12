import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

import { JSON_INDENT, PAD_WIDTH_2, PAD_WIDTH_4 } from '@nodeint/migent-kernel';

import { DIRECTORY_MODE, FILE_MODE, MAX_TOOL_NAME_LENGTH, MAX_TOOL_VERSION_LENGTH, MAX_WORKSPACE_NAME_LENGTH, WORKSPACE_HASH_LENGTH } from './constants.js';
import { interprocessLock, RegistryBusy, registryBusy } from './locks.js';

export { RegistryBusy };

/** Upper bounds of the calendar fields accepted in a stored timestamp. */
const MAX_MONTH = 12;
const MAX_DAY = 31;
const MAX_HOUR = 23;
const MAX_MINUTE_OR_SECOND = 59;
/** Random bytes in a temp-file name. */
const TEMP_SUFFIX_BYTES = 8;

const toolName = /^[A-Za-z0-9._-]+$/;
const timestampText = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const topKeys = new Set(['schema_version', 'workspaces']);
const workspaceKeys = new Set(['id', 'name', 'path', 'registered_at', 'updated_at', 'tool']);
const toolKeys = new Set(['name', 'version']);

export class RegistryCorrupt extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryCorrupt';
  }
}

export class WorkspaceNotFound extends Error {
  public readonly workspaceId: string;

  constructor(workspaceId: string) {
    super(`Workspace was not found: ${workspaceId}`);
    this.name = 'WorkspaceNotFound';
    this.workspaceId = workspaceId;
  }
}

export class NotAWorkspace extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotAWorkspace';
  }
}

export class InvalidRecord extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRecord';
  }
}

export interface ToolRecord {
  name: string;
  version?: string;
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  path: string;
  registered_at: string;
  updated_at: string;
  tool: ToolRecord;
}

export interface WorkspacePublic extends WorkspaceRecord {
  available: boolean;
}

export const storeFs = {
  replace(source: string, destination: string): void {
    renameSync(source, destination);
  },
  fsync(fd: number): void {
    fsyncSync(fd);
  },
  write(fd: number, data: Buffer): number {
    return writeSync(fd, data);
  },
};

export function workspaceIdFor(filePath: string): string {
  return `ws_${createHash('sha256').update(filePath, 'utf8').digest('hex').slice(0, WORKSPACE_HASH_LENGTH)}`;
}

export function utcTimestamp(now = new Date()): string {
  const year = now.getUTCFullYear().toString().padStart(PAD_WIDTH_4, '0');
  const month = String(now.getUTCMonth() + 1).padStart(PAD_WIDTH_2, '0');
  const day = String(now.getUTCDate()).padStart(PAD_WIDTH_2, '0');
  const hour = String(now.getUTCHours()).padStart(PAD_WIDTH_2, '0');
  const minute = String(now.getUTCMinutes()).padStart(PAD_WIDTH_2, '0');
  const second = String(now.getUTCSeconds()).padStart(PAD_WIDTH_2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

function writeFully(fd: number, payload: Buffer): void {
  fchmodSync(fd, FILE_MODE);
  let offset = 0;
  while (offset < payload.length) {
    const written = storeFs.write(fd, payload.subarray(offset));
    if (written <= 0) throw new Error('short write publishing registry file');
    offset += written;
  }
  storeFs.fsync(fd);
}

function fsyncDirectory(directory: string): void {
  // Windows cannot open or fsync a directory; its rename is durable without it.
  if (process.platform === 'win32') return;
  const dirFd = openSync(directory, fsConstants.O_RDONLY);
  try {
    storeFs.fsync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

export function atomicReplace(destination: string, payload: Buffer): void {
  const directory = path.dirname(destination);
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  chmodSync(directory, DIRECTORY_MODE);
  const tmpPath = path.join(directory, `${path.basename(destination)}.tmp.${randomBytes(TEMP_SUFFIX_BYTES).toString('hex')}`);
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY;
  const fd = openSync(tmpPath, flags, FILE_MODE);
  let replaced = false;
  try {
    try {
      writeFully(fd, payload);
    } finally {
      closeSync(fd);
    }
    storeFs.replace(tmpPath, destination);
    replaced = true;
    chmodSync(destination, FILE_MODE);
    fsyncDirectory(directory);
  } finally {
    if (!replaced) {
      rmSync(tmpPath, { force: true });
    }
  }
}

function sameKeys(value: object, expected: Set<string>, exact: boolean): boolean {
  const keys = Object.keys(value);
  if (exact && keys.length !== expected.size) return false;
  for (const key of keys) {
    if (!expected.has(key)) return false;
  }
  if (exact) {
    for (const key of expected) {
      if (!Object.hasOwn(value, key)) return false;
    }
  }
  return true;
}

function inRange(value: number | undefined, min: number, max: number): value is number {
  return value !== undefined && !Number.isNaN(value) && value >= min && value <= max;
}

function isTimestamp(value: string): boolean {
  if (!timestampText.test(value)) return false;
  const [date, time] = value.slice(0, -1).split('T');
  if (!date || !time) return false;
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, second] = time.split(':').map(Number);
  if (!year || !inRange(month, 1, MAX_MONTH) || !inRange(day, 1, MAX_DAY)) return false;
  if (!inRange(hour, 0, MAX_HOUR)) return false;
  if (!inRange(minute, 0, MAX_MINUTE_OR_SECOND) || !inRange(second, 0, MAX_MINUTE_OR_SECOND)) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day &&
    parsed.getUTCHours() === hour &&
    parsed.getUTCMinutes() === minute &&
    parsed.getUTCSeconds() === second
  );
}

function absoluteRegistryPath(filePath: string): boolean {
  if (filePath.includes('\0')) return false;
  try {
    return path.isAbsolute(filePath);
  } catch {
    return false;
  }
}

function schemaVersionToken(text: string): string | null {
  const matched = text.match(/"schema_version"\s*:\s*([^\s,}\]]+)/);
  return matched?.[1] ?? null;
}

function isWorkspace(filePath: string): boolean {
  const config = path.join(filePath, '.migent', 'config.yaml');
  try {
    return statSync(config).isFile();
  } catch {
    return false;
  }
}

function normalizeTool(tool: unknown): ToolRecord {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) throw new InvalidRecord('Tool name is invalid.');
  const record = tool as Record<string, unknown>;
  if (!sameKeys(record, toolKeys, false) || !Object.hasOwn(record, 'name')) {
    throw new InvalidRecord('Tool name is invalid.');
  }
  const {name} = record;
  if (typeof name !== 'string' || !toolName.test(name) || name.length === 0 || name.length > MAX_TOOL_NAME_LENGTH) {
    throw new InvalidRecord('Tool name is invalid.');
  }
  const stored: ToolRecord = { name };
  if (Object.hasOwn(record, 'version')) {
    const {version} = record;
    if (typeof version !== 'string' || version.length > MAX_TOOL_VERSION_LENGTH) throw new InvalidRecord('Tool version is invalid.');
    stored.version = version;
  }
  return stored;
}

function prepareRegister(filePath: string, name: string | null, tool: unknown): [string, string, ToolRecord] {
  if (typeof filePath !== 'string' || filePath.includes('\0') || !path.isAbsolute(filePath)) {
    throw new NotAWorkspace('Workspace path is not absolute.');
  }
  let stored: string;
  try {
    stored = realpathSync(filePath);
  } catch {
    stored = path.resolve(filePath);
  }
  if (!path.isAbsolute(stored)) throw new NotAWorkspace('Workspace path is not absolute.');
  let chosen: string;
  if (name === null) chosen = path.basename(stored);
  else if (typeof name === 'string' && name.length > 0 && name.length <= MAX_WORKSPACE_NAME_LENGTH) chosen = name;
  else throw new InvalidRecord('Workspace name must be 1 to 200 characters.');
  if (!chosen) throw new InvalidRecord('Workspace name must be 1 to 200 characters.');
  return [stored, chosen, normalizeTool(tool)];
}

const WRONG_SHAPE = 'registry.json has the wrong shape.';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseStoredTool(tool: unknown): ToolRecord {
  if (!isPlainObject(tool) || !sameKeys(tool, toolKeys, false) || !('name' in tool)) {
    throw new RegistryCorrupt(WRONG_SHAPE);
  }
  const {name} = tool;
  if (typeof name !== 'string' || !toolName.test(name) || name.length === 0 || name.length > MAX_TOOL_NAME_LENGTH) {
    throw new RegistryCorrupt(WRONG_SHAPE);
  }
  const storedTool: ToolRecord = { name };
  if (Object.hasOwn(tool, 'version')) {
    const {version} = tool;
    if (typeof version !== 'string' || version.length > MAX_TOOL_VERSION_LENGTH) throw new RegistryCorrupt(WRONG_SHAPE);
    storedTool.version = version;
  }
  return storedTool;
}

function validWorkspaceFields(record: Omit<WorkspaceRecord, 'tool'>): boolean {
  return record.name.length > 0
    && record.name.length <= MAX_WORKSPACE_NAME_LENGTH
    && absoluteRegistryPath(record.path)
    && record.id === workspaceIdFor(record.path)
    && isTimestamp(record.registered_at)
    && isTimestamp(record.updated_at);
}

function parseWorkspace(item: unknown): WorkspaceRecord {
  if (!isPlainObject(item) || !sameKeys(item, workspaceKeys, true)) {
    throw new RegistryCorrupt(WRONG_SHAPE);
  }
  const readString = (key: 'id' | 'name' | 'path' | 'registered_at' | 'updated_at'): string => {
    const value = item[key];
    if (typeof value !== 'string' || value === '') throw new RegistryCorrupt(WRONG_SHAPE);
    return value;
  };
  const record = {
    id: readString('id'),
    name: readString('name'),
    path: readString('path'),
    registered_at: readString('registered_at'),
    updated_at: readString('updated_at'),
  };
  const {tool} = item;
  if (!isPlainObject(tool) || !sameKeys(tool, toolKeys, false) || !('name' in tool)) {
    throw new RegistryCorrupt(WRONG_SHAPE);
  }
  if (!validWorkspaceFields(record)) throw new RegistryCorrupt(WRONG_SHAPE);
  return { ...record, tool: parseStoredTool(tool) };
}

function parseRegistry(raw: Buffer): WorkspaceRecord[] {
  if (raw.toString('utf8').trim() === '') throw new RegistryCorrupt('registry.json is empty.');
  let text: string;
  try {
    text = raw.toString('utf8');
    if (text.includes('\uFFFD') && !Buffer.from(text, 'utf8').equals(raw)) {
      throw new Error('bad encoding');
    }
  } catch {
    throw new RegistryCorrupt('registry.json is not valid JSON.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RegistryCorrupt('registry.json is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !sameKeys(parsed, topKeys, true)) {
    throw new RegistryCorrupt('registry.json has the wrong shape.');
  }
  const token = schemaVersionToken(text);
  const version = (parsed as { schema_version?: unknown }).schema_version;
  const {workspaces} = (parsed as { workspaces?: unknown });
  if (token !== '1' || typeof version !== 'number' || !Number.isInteger(version) || version !== 1 || !Array.isArray(workspaces)) {
    throw new RegistryCorrupt('registry.json has the wrong shape.');
  }
  return workspaces.map((item) => parseWorkspace(item));
}

function stored(record: WorkspaceRecord): WorkspaceRecord {
  const tool: ToolRecord = { name: record.tool.name };
  if (record.tool.version !== undefined) tool.version = record.tool.version;
  return {
    id: record.id,
    name: record.name,
    path: record.path,
    registered_at: record.registered_at,
    updated_at: record.updated_at,
    tool,
  };
}

function asPublic(record: WorkspaceRecord): WorkspacePublic {
  return { ...stored(record), available: isWorkspace(record.path) };
}

function findRecord(records: WorkspaceRecord[], workspaceId: string): WorkspaceRecord {
  const found = records.find((record) => record.id === workspaceId);
  if (!found) throw new WorkspaceNotFound(workspaceId);
  return found;
}

function ordered(records: WorkspaceRecord[]): WorkspaceRecord[] {
  return [...records].sort((left, right) => {
    if (left.registered_at < right.registered_at) return -1;
    if (left.registered_at > right.registered_at) return 1;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });
}

export class RegistryStore {
  public readonly directory: string;
  public readonly timeoutSec: number;
  public lockedHook: () => void | Promise<void> = () => undefined;

  constructor(directory: string, timeoutSec = 2) {
    this.directory = directory;
    this.timeoutSec = timeoutSec;
  }

  public async register(filePath: string, name: string | null, tool: unknown): Promise<[WorkspacePublic, boolean]> {
    const [storedPath, chosenName, storedTool] = prepareRegister(filePath, name, tool);
    return this.lock(false, async () => {
      const records = this.load();
      if (!isWorkspace(storedPath)) throw new NotAWorkspace(storedPath);
      await this.lockedHook();
      const now = utcTimestamp();
      let created = true;
      let updated: WorkspaceRecord | null = null;
      for (const record of records) {
        if (record.path === storedPath) {
          created = false;
          record.name = chosenName;
          record.tool = storedTool;
          record.updated_at = now;
          updated = record;
          break;
        }
      }
      if (!updated) {
        updated = {
          id: workspaceIdFor(storedPath),
          name: chosenName,
          path: storedPath,
          registered_at: now,
          updated_at: now,
          tool: storedTool,
        };
        records.push(updated);
      }
      this.publish(records);
      return [asPublic(updated), created];
    });
  }

  public async list(): Promise<WorkspacePublic[]> {
    return this.lock(true, async () => ordered(this.load()).map(asPublic));
  }

  public async get(workspaceId: string): Promise<WorkspacePublic> {
    return this.lock(true, async () => asPublic(findRecord(this.load(), workspaceId)));
  }

  public async remove(workspaceId: string): Promise<WorkspacePublic> {
    return this.lock(false, async () => {
      const records = this.load();
      const found = findRecord(records, workspaceId);
      await this.lockedHook();
      this.publish(withoutRecord(records, workspaceId));
      return asPublic(found);
    });
  }

  private async lock<T>(shared: boolean, body: () => Promise<T>): Promise<T> {
    mkdirSync(this.directory, { recursive: true, mode: DIRECTORY_MODE });
    chmodSync(this.directory, DIRECTORY_MODE);
    return interprocessLock(
      path.join(this.directory, 'registry.lock'),
      { shared, timeoutSec: this.timeoutSec, busyError: registryBusy },
      body,
    );
  }

  private load(): WorkspaceRecord[] {
    const file = path.join(this.directory, 'registry.json');
    if (!existsSync(file)) return [];
    try {
      return parseRegistry(readFileSync(file));
    } catch (error) {
      if (error instanceof RegistryCorrupt) throw error;
      throw new RegistryCorrupt('registry.json is unreadable.');
    }
  }

  private publish(records: WorkspaceRecord[]): void {
    const document = {
      schema_version: 1,
      workspaces: ordered(records).map((record) => stored(record)),
    };
    const payload = Buffer.from(`${JSON.stringify(document, null, JSON_INDENT)}\n`, 'utf8');
    atomicReplace(path.join(this.directory, 'registry.json'), payload);
  }
}

function withoutRecord(records: readonly WorkspaceRecord[], workspaceId: string): WorkspaceRecord[] {
  return records.filter((record) => record.id !== workspaceId);
}
