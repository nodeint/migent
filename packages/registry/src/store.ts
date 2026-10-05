import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  constants as fsConstants,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { RegistryBusy, interprocessLock, registryBusy } from "./locks.js";

export { RegistryBusy };

const toolName = /^[A-Za-z0-9._-]+$/;
const timestampText = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const topKeys = new Set(["schema_version", "workspaces"]);
const workspaceKeys = new Set(["id", "name", "path", "registered_at", "updated_at", "tool"]);
const toolKeys = new Set(["name", "version"]);
const stringFields = ["id", "name", "path", "registered_at", "updated_at"] as const;

export class RegistryCorrupt extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryCorrupt";
  }
}

export class WorkspaceNotFound extends Error {
  readonly workspaceId: string;

  constructor(workspaceId: string) {
    super(`Workspace was not found: ${workspaceId}`);
    this.name = "WorkspaceNotFound";
    this.workspaceId = workspaceId;
  }
}

export class NotAWorkspace extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotAWorkspace";
  }
}

export class InvalidRecord extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRecord";
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
  return `ws_${createHash("sha256").update(filePath, "utf8").digest("hex").slice(0, 12)}`;
}

export function utcTimestamp(now = new Date()): string {
  const year = now.getUTCFullYear().toString().padStart(4, "0");
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hour = String(now.getUTCHours()).padStart(2, "0");
  const minute = String(now.getUTCMinutes()).padStart(2, "0");
  const second = String(now.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

export function atomicReplace(destination: string, payload: Buffer): void {
  const directory = path.dirname(destination);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const tmpPath = path.join(directory, `${path.basename(destination)}.tmp.${randomBytes(8).toString("hex")}`);
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY;
  const fd = openSync(tmpPath, flags, 0o600);
  let replaced = false;
  try {
    try {
      fchmodSync(fd, 0o600);
      let offset = 0;
      while (offset < payload.length) {
        const written = storeFs.write(fd, payload.subarray(offset));
        if (written <= 0) throw new Error("short write publishing registry file");
        offset += written;
      }
      storeFs.fsync(fd);
    } finally {
      closeSync(fd);
    }
    storeFs.replace(tmpPath, destination);
    replaced = true;
    chmodSync(destination, 0o600);
    const dirFd = openSync(directory, fsConstants.O_RDONLY);
    try {
      storeFs.fsync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } finally {
    if (!replaced) {
      try {
        unlinkSync(tmpPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw error;
      }
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

function isTimestamp(value: string): boolean {
  if (!timestampText.test(value)) return false;
  const [date, time] = value.slice(0, -1).split("T");
  if (!date || !time) return false;
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second] = time.split(":").map(Number);
  if (
    !year ||
    !month ||
    !day ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
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
  if (filePath.includes("\0")) return false;
  try {
    return path.posix.isAbsolute(filePath);
  } catch {
    return false;
  }
}

function schemaVersionToken(text: string): string | null {
  const matched = text.match(/"schema_version"\s*:\s*([^\s,}\]]+)/);
  return matched?.[1] ?? null;
}

function isWorkspace(filePath: string): boolean {
  const config = path.join(filePath, ".migent", "config.yaml");
  try {
    return statSync(config).isFile();
  } catch {
    return false;
  }
}

function normalizeTool(tool: unknown): ToolRecord {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) throw new InvalidRecord("Tool name is invalid.");
  const record = tool as Record<string, unknown>;
  if (!sameKeys(record, toolKeys, false) || !Object.hasOwn(record, "name")) {
    throw new InvalidRecord("Tool name is invalid.");
  }
  const name = record.name;
  if (typeof name !== "string" || !toolName.test(name) || name.length < 1 || name.length > 80) {
    throw new InvalidRecord("Tool name is invalid.");
  }
  const stored: ToolRecord = { name };
  if (Object.hasOwn(record, "version")) {
    const version = record.version;
    if (typeof version !== "string" || version.length > 40) throw new InvalidRecord("Tool version is invalid.");
    stored.version = version;
  }
  return stored;
}

function prepareRegister(filePath: string, name: string | null, tool: unknown): [string, string, ToolRecord] {
  if (typeof filePath !== "string" || filePath.includes("\0") || !path.posix.isAbsolute(filePath)) {
    throw new NotAWorkspace("Workspace path is not absolute.");
  }
  let stored = filePath;
  try {
    stored = realpathSync(filePath);
  } catch {
    stored = path.resolve(filePath);
  }
  if (!path.posix.isAbsolute(stored)) throw new NotAWorkspace("Workspace path is not absolute.");
  let chosen: string;
  if (name === null) chosen = path.basename(stored);
  else if (typeof name === "string" && name.length >= 1 && name.length <= 200) chosen = name;
  else throw new InvalidRecord("Workspace name must be 1 to 200 characters.");
  if (!chosen) throw new InvalidRecord("Workspace name must be 1 to 200 characters.");
  return [stored, chosen, normalizeTool(tool)];
}

function parseWorkspace(item: unknown): WorkspaceRecord {
  if (!item || typeof item !== "object" || Array.isArray(item) || !sameKeys(item, workspaceKeys, true)) {
    throw new RegistryCorrupt("registry.json has the wrong shape.");
  }
  const source = item as Record<string, unknown>;
  const record: Partial<WorkspaceRecord> = {};
  for (const key of stringFields) {
    const value = source[key];
    if (typeof value !== "string" || value === "") throw new RegistryCorrupt("registry.json has the wrong shape.");
    record[key] = value;
  }
  const tool = source.tool;
  if (!tool || typeof tool !== "object" || Array.isArray(tool) || !sameKeys(tool, toolKeys, false) || !("name" in tool)) {
    throw new RegistryCorrupt("registry.json has the wrong shape.");
  }
  if (record.name!.length < 1 || record.name!.length > 200) {
    throw new RegistryCorrupt("registry.json has the wrong shape.");
  }
  if (!absoluteRegistryPath(record.path!)) throw new RegistryCorrupt("registry.json has the wrong shape.");
  if (record.id !== workspaceIdFor(record.path!)) throw new RegistryCorrupt("registry.json has the wrong shape.");
  if (!isTimestamp(record.registered_at!) || !isTimestamp(record.updated_at!)) {
    throw new RegistryCorrupt("registry.json has the wrong shape.");
  }
  const toolRecord = tool as Record<string, unknown>;
  const name = toolRecord.name;
  if (typeof name !== "string" || !toolName.test(name) || name.length < 1 || name.length > 80) {
    throw new RegistryCorrupt("registry.json has the wrong shape.");
  }
  const storedTool: ToolRecord = { name };
  if (Object.hasOwn(toolRecord, "version")) {
    const version = toolRecord.version;
    if (typeof version !== "string" || version.length > 40) {
      throw new RegistryCorrupt("registry.json has the wrong shape.");
    }
    storedTool.version = version;
  }
  return {
    id: record.id!,
    name: record.name!,
    path: record.path!,
    registered_at: record.registered_at!,
    updated_at: record.updated_at!,
    tool: storedTool,
  };
}

function parseRegistry(raw: Buffer): WorkspaceRecord[] {
  if (raw.toString("utf8").trim() === "") throw new RegistryCorrupt("registry.json is empty.");
  let text: string;
  try {
    text = raw.toString("utf8");
    if (text.includes("\uFFFD") && !Buffer.from(text, "utf8").equals(raw)) {
      throw new Error("bad encoding");
    }
  } catch {
    throw new RegistryCorrupt("registry.json is not valid JSON.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RegistryCorrupt("registry.json is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !sameKeys(parsed, topKeys, true)) {
    throw new RegistryCorrupt("registry.json has the wrong shape.");
  }
  const token = schemaVersionToken(text);
  const version = (parsed as { schema_version?: unknown }).schema_version;
  const workspaces = (parsed as { workspaces?: unknown }).workspaces;
  if (token !== "1" || typeof version !== "number" || !Number.isInteger(version) || version !== 1 || !Array.isArray(workspaces)) {
    throw new RegistryCorrupt("registry.json has the wrong shape.");
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
  readonly directory: string;
  readonly timeoutSec: number;
  lockedHook: () => void | Promise<void> = () => undefined;

  constructor(directory: string, timeoutSec = 2) {
    this.directory = directory;
    this.timeoutSec = timeoutSec;
  }

  async register(filePath: string, name: string | null, tool: unknown): Promise<[WorkspacePublic, boolean]> {
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

  async list(): Promise<WorkspacePublic[]> {
    return this.lock(true, async () => ordered(this.load()).map((record) => asPublic(record)));
  }

  async get(workspaceId: string): Promise<WorkspacePublic> {
    return this.lock(true, async () => asPublic(findRecord(this.load(), workspaceId)));
  }

  async remove(workspaceId: string): Promise<WorkspacePublic> {
    return this.lock(false, async () => {
      const records = this.load();
      const found = findRecord(records, workspaceId);
      await this.lockedHook();
      this.publish(records.filter((record) => record.id !== workspaceId));
      return asPublic(found);
    });
  }

  private async lock<T>(shared: boolean, body: () => Promise<T>): Promise<T> {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    return interprocessLock(
      path.join(this.directory, "registry.lock"),
      { shared, timeoutSec: this.timeoutSec, busyError: registryBusy },
      body,
    );
  }

  private load(): WorkspaceRecord[] {
    const file = path.join(this.directory, "registry.json");
    if (!existsSync(file)) return [];
    try {
      return parseRegistry(readFileSync(file));
    } catch (error) {
      if (error instanceof RegistryCorrupt) throw error;
      throw new RegistryCorrupt("registry.json is unreadable.");
    }
  }

  private publish(records: WorkspaceRecord[]): void {
    const document = {
      schema_version: 1,
      workspaces: ordered(records).map((record) => stored(record)),
    };
    const payload = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    atomicReplace(path.join(this.directory, "registry.json"), payload);
  }
}
