import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { childInvocation } from "../src/child.ts";
import { RegistryBusy } from "../src/locks.ts";
import { RegistryCorrupt, RegistryStore, WorkspaceNotFound, storeFs, workspaceIdFor } from "../src/store.ts";
import { TOOL, makeWorkspace, registryBytes } from "./support.ts";
import { sleep } from "../src/time.ts";

const locksModule = new URL("../src/locks.ts", import.meta.url);

function resolved(filePath: string): string {
  return realpathSync(filePath);
}

test("register refresh list get and remove", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "registry-store-"));
  const first = makeWorkspace(root, "alpha");
  const second = makeWorkspace(root, "beta");
  const store = new RegistryStore(path.join(root, "registry"));
  const [created, wasNew] = await store.register(first, null, TOOL);
  expect(wasNew).toBe(true);
  expect(created.name).toBe("alpha");
  expect(created.path).toBe(resolved(first));
  expect(created.available).toBe(true);
  const [again, againNew] = await store.register(first, "renamed", { name: "codex", version: "9" });
  expect(againNew).toBe(false);
  expect(again.id).toBe(created.id);
  expect(again.registered_at).toBe(created.registered_at);
  expect(again.name).toBe("renamed");
  expect(again.tool.name).toBe("codex");
  const [other] = await store.register(second, null, TOOL);
  const rows = await store.list();
  const sorted = [...rows].sort((left, right) => {
    if (left.registered_at < right.registered_at) return -1;
    if (left.registered_at > right.registered_at) return 1;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });
  expect(rows.map((row) => row.id)).toEqual(sorted.map((row) => row.id));
  expect(new Set(rows.map((row) => row.id))).toEqual(new Set([created.id, other.id]));
  expect((await store.get(other.id)).path).toBe(resolved(second));
  const { unlinkSync } = await import("node:fs");
  unlinkSync(path.join(first, ".migent", "config.yaml"));
  expect((await store.get(created.id)).available).toBe(false);
  const removed = await store.remove(other.id);
  expect(removed.id).toBe(other.id);
  await expect(store.get(other.id)).rejects.toBeInstanceOf(WorkspaceNotFound);
  await expect(store.remove(other.id)).rejects.toBeInstanceOf(WorkspaceNotFound);
  const mode = statSync(path.join(root, "registry", "registry.json")).mode & 0o777;
  expect(mode).toBe(0o600);
});

test("two instances cannot interleave register", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "registry-store-"));
  const first = makeWorkspace(root, "one");
  const second = makeWorkspace(root, "two");
  const directory = path.join(root, "registry");
  const left = new RegistryStore(directory);
  const right = new RegistryStore(directory);
  let entered = false;
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let rightEntered = false;
  left.lockedHook = async () => {
    entered = true;
    await Promise.race([released, sleep(3)]);
  };
  right.lockedHook = () => {
    rightEntered = true;
  };
  const errors: unknown[] = [];
  const runLeft = left.register(first, null, TOOL).catch((error: unknown) => errors.push(error));
  const started = Date.now();
  while (!entered && Date.now() - started < 2000) await sleep(0.02);
  expect(entered).toBe(true);
  const runRight = right.register(second, null, TOOL).catch((error: unknown) => errors.push(error));
  await sleep(0.3);
  expect(rightEntered).toBe(false);
  release();
  await runLeft;
  await runRight;
  expect(errors).toEqual([]);
  const ids = new Set((await left.list()).map((row) => row.id));
  expect(ids.size).toBe(2);
});

test("register raises busy and leaves the first document", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "registry-store-"));
  const first = makeWorkspace(root, "one");
  const second = makeWorkspace(root, "two");
  const directory = path.join(root, "registry");
  const holder = new RegistryStore(directory, 2);
  const waiter = new RegistryStore(directory, 0.2);
  let entered = false;
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  holder.lockedHook = async () => {
    entered = true;
    await Promise.race([released, sleep(3)]);
  };
  const errors: unknown[] = [];
  const running = holder.register(first, null, TOOL).catch((error: unknown) => errors.push(error));
  const started = Date.now();
  while (!entered && Date.now() - started < 2000) await sleep(0.02);
  expect(entered).toBe(true);
  await expect(waiter.register(second, null, TOOL)).rejects.toBeInstanceOf(RegistryBusy);
  release();
  await running;
  expect(errors).toEqual([]);
  const rows = await holder.list();
  expect(rows.map((row) => row.name)).toEqual(["one"]);
});

test("missing file is empty and corrupt files are left unchanged", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "registry-store-"));
  const workspace = makeWorkspace(root, "demo");
  const directory = path.join(root, "registry");
  const store = new RegistryStore(directory);
  expect(await store.list()).toEqual([]);
  expect(existsSync(path.join(directory, "registry.json"))).toBe(false);
  const samples = [
    Buffer.from(""),
    Buffer.from("   \n"),
    Buffer.from("{"),
    Buffer.from("[]"),
    Buffer.from('{"schema_version": 2, "workspaces": []}'),
    Buffer.from('{"schema_version": true, "workspaces": []}'),
    Buffer.from('{"schema_version": 1.0, "workspaces": []}'),
  ];
  for (const raw of samples) {
    const file = path.join(directory, "registry.json");
    writeFileSync(file, raw);
    await expect(store.register(workspace, null, TOOL)).rejects.toBeInstanceOf(RegistryCorrupt);
    expect(readFileSync(file)).toEqual(raw);
  }
});

test("records outside the schema are left unchanged", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "registry-store-"));
  const workspace = makeWorkspace(root, "demo");
  const directory = path.join(root, "registry");
  mkdirSync(directory);
  const store = new RegistryStore(directory);
  const storedPath = resolved(workspace);
  const record = {
    id: workspaceIdFor(storedPath),
    name: "demo",
    path: storedPath,
    registered_at: "2026-09-26T08:07:57Z",
    updated_at: "2026-09-26T08:07:57Z",
    tool: { name: "migent", version: "0.1.0" },
  };
  const file = path.join(directory, "registry.json");
  writeFileSync(file, registryBytes([record]));
  expect((await store.list())[0]?.id).toBe(record.id);
  const relative = "relative/demo";
  const malformed = [
    { ...record, name: "n".repeat(201) },
    { ...record, path: relative, id: workspaceIdFor(relative) },
    { ...record, id: "ws_000000000000" },
    { ...record, tool: { name: "bad name", version: "0.1.0" } },
    { ...record, tool: { name: "a".repeat(81), version: "0.1.0" } },
    { ...record, tool: { name: "migent", version: "v".repeat(41) } },
    { ...record, registered_at: "2026-09-26 08:07:57" },
  ];
  for (const item of malformed) {
    const raw = registryBytes([item]);
    writeFileSync(file, raw);
    await expect(store.list()).rejects.toBeInstanceOf(RegistryCorrupt);
    expect(readFileSync(file)).toEqual(raw);
    await expect(store.register(workspace, null, TOOL)).rejects.toBeInstanceOf(RegistryCorrupt);
    expect(readFileSync(file)).toEqual(raw);
  }
});

test("temp sibling is not loaded and failed replace keeps the original", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "registry-store-"));
  const first = makeWorkspace(root, "one");
  const second = makeWorkspace(root, "two");
  const directory = path.join(root, "registry");
  const store = new RegistryStore(directory);
  const [created] = await store.register(first, null, TOOL);
  const sibling = path.join(directory, "registry.json.tmp.leftover");
  writeFileSync(sibling, '{"schema_version":1,"workspaces":[]}');
  expect((await store.list()).map((row) => row.id)).toEqual([created.id]);
  expect(existsSync(sibling)).toBe(true);
  const original = readFileSync(path.join(directory, "registry.json"));
  const realReplace = storeFs.replace;
  storeFs.replace = () => {
    throw new Error("replace failed");
  };
  try {
    await expect(store.register(second, null, TOOL)).rejects.toThrow("replace failed");
  } finally {
    storeFs.replace = realReplace;
  }
  expect(readFileSync(path.join(directory, "registry.json"))).toEqual(original);
  expect((await store.get(created.id)).name).toBe("one");
  expect(existsSync(sibling)).toBe(true);
  expect(readdirSync(directory).filter((name) => name.startsWith("registry.json.tmp."))).toEqual([
    "registry.json.tmp.leftover",
  ]);
});

test("successful replace preserves an unrelated temp file", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "registry-store-"));
  const workspace = makeWorkspace(root, "one");
  const directory = path.join(root, "registry");
  const store = new RegistryStore(directory);
  const [created] = await store.register(workspace, null, TOOL);
  const other = path.join(directory, "registry.json.tmp.otherwriter");
  writeFileSync(other, "other writer");
  await store.register(workspace, "renamed", TOOL);
  expect(readFileSync(other, "utf8")).toBe("other writer");
  expect((await store.get(created.id)).name).toBe("renamed");
  expect(readdirSync(directory).filter((name) => name.startsWith("registry.json.tmp."))).toEqual([
    "registry.json.tmp.otherwriter",
  ]);
});

test("failed write or fsync removes the temp file", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "registry-store-"));
  const workspace = makeWorkspace(root, "one");
  const directory = path.join(root, "registry");
  const store = new RegistryStore(directory);
  const [created] = await store.register(workspace, null, TOOL);
  const original = readFileSync(path.join(directory, "registry.json"));
  const sibling = path.join(directory, "registry.json.tmp.leftover");
  writeFileSync(sibling, "partial");
  const realFsync = storeFs.fsync;
  storeFs.fsync = () => {
    throw new Error("fsync failed");
  };
  try {
    await expect(store.register(workspace, "renamed", TOOL)).rejects.toThrow("fsync failed");
  } finally {
    storeFs.fsync = realFsync;
  }
  expect(readFileSync(path.join(directory, "registry.json"))).toEqual(original);
  expect((await store.get(created.id)).name).toBe("one");
  expect(readFileSync(sibling, "utf8")).toBe("partial");
  expect(readdirSync(directory).filter((name) => name.startsWith("registry.json.tmp."))).toEqual([
    "registry.json.tmp.leftover",
  ]);
  const realWrite = storeFs.write;
  storeFs.write = () => {
    throw new Error("write failed");
  };
  try {
    await expect(store.register(workspace, "renamed", TOOL)).rejects.toThrow("write failed");
  } finally {
    storeFs.write = realWrite;
  }
  expect(readFileSync(path.join(directory, "registry.json"))).toEqual(original);
  expect((await store.get(created.id)).name).toBe("one");
  expect(readFileSync(sibling, "utf8")).toBe("partial");
  expect(readdirSync(directory).filter((name) => name.startsWith("registry.json.tmp."))).toEqual([
    "registry.json.tmp.leftover",
  ]);
});

test("cross process lock returns busy", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "registry-store-"));
  const directory = path.join(root, "registry");
  mkdirSync(directory);
  const lockPath = path.join(directory, "registry.lock");
  const script = `
    const { interprocessLock, registryBusy } = await import(${JSON.stringify(locksModule.href)});
    await interprocessLock(process.argv[1], { shared: false, timeoutSec: 2, busyError: registryBusy }, async () => {
      process.stdout.write("locked\\n");
      await new Promise(() => setInterval(() => undefined, 1000));
    });
  `;
  // Strip types and map .js imports to .ts, as the registry child does when run from source.
  const invocation = childInvocation(fileURLToPath(locksModule));
  const proc = spawn(process.execPath, [...invocation.args, "--input-type=module", "-e", script, lockPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  try {
    const line = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error(`lock helper silent: ${stderr}`)), 3000);
      proc.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (buffer.includes("\n")) {
          clearTimeout(timer);
          resolve(buffer);
        }
      });
      proc.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`lock helper exited ${code}: ${stderr}`));
      });
    });
    expect(line.trim()).toBe("locked");
    const workspace = makeWorkspace(root, "demo");
    const store = new RegistryStore(directory, 0.2);
    await expect(store.register(workspace, null, TOOL)).rejects.toBeInstanceOf(RegistryBusy);
  } finally {
    proc.kill("SIGKILL");
    await new Promise((resolve) => proc.once("exit", resolve));
  }
});
