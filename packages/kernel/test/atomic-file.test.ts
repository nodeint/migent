import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import * as fs from "node:fs";
import { appendLineSynced, isAtomicTempName, writeFileAtomic } from "../src/atomic-file.js";
import { readStatusFileState } from "../src/query.js";
import { ConfigurationError } from "../src/errors.js";
import { freezeSessionTask } from "../src/task-file.js";

function temp(): string {
  return mkdtempSync(path.join(tmpdir(), "migent-atomic-"));
}

test("writeFileAtomic replaces the file and leaves no temp file", () => {
  const dir = temp();
  try {
    const file = path.join(dir, "status.json");
    writeFileAtomic(file, "one");
    writeFileAtomic(file, "two");
    expect(readFileSync(file, "utf8")).toBe("two");
    expect(readdirSync(dir)).toEqual(["status.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a write that fails before rename keeps the old file", () => {
  const dir = temp();
  try {
    const file = path.join(dir, "status.json");
    writeFileSync(file, "old");
    const target = path.join(dir, "missing", "status.json");
    expect(() => writeFileAtomic(target, "new")).toThrow();
    expect(readFileSync(file, "utf8")).toBe("old");
    expect(readdirSync(dir)).toEqual(["status.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("temp names are recognised so readers can ignore them", () => {
  expect(isAtomicTempName(".status.json.abc123.tmp")).toBe(true);
  expect(isAtomicTempName("status.json")).toBe(false);
});

test("appendLineSynced writes whole lines", () => {
  const dir = temp();
  try {
    const file = path.join(dir, "events.jsonl");
    appendLineSynced(file, '{"a":1}');
    appendLineSynced(file, '{"b":2}\n');
    expect(readFileSync(file, "utf8")).toBe('{"a":1}\n{"b":2}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readStatusFileState tells missing from corrupt", () => {
  const dir = temp();
  try {
    const file = path.join(dir, "status.json");
    expect(readStatusFileState(file).state).toBe("missing");
    writeFileSync(file, "{");
    expect(readStatusFileState(file).state).toBe("corrupt");
    writeFileSync(file, "[]");
    expect(readStatusFileState(file).state).toBe("corrupt");
    writeFileSync(file, '{"status":"active"}');
    expect(readStatusFileState(file).state).toBe("ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("freezeSessionTask does not overwrite a corrupt status.json", () => {
  const workspace = temp();
  try {
    const session = path.join(workspace, ".migent", "sessions", "s1");
    fs.mkdirSync(session, { recursive: true });
    writeFileSync(path.join(session, "status.json"), '{"task_sha');
    writeFileSync(path.join(session, "task.md"), "do it\n");
    expect(() => freezeSessionTask(workspace, "s1")).toThrow(ConfigurationError);
    expect(readFileSync(path.join(session, "status.json"), "utf8")).toBe('{"task_sha');
  } finally {
    vi.restoreAllMocks();
    rmSync(workspace, { recursive: true, force: true });
  }
});
