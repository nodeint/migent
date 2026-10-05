import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { CORRUPT, readService, recordIsConfirmedGone, serviceIdentityMatches, serviceLockPath, writeServiceJson } from "../src/identity.ts";
import { LockNotHeld, holdStartLock } from "../src/locks.ts";
import { ScriptedInspector, serviceRecord } from "./support.ts";

test("identity matches only the lock holder", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "registry-id-"));
  const record = serviceRecord();
  const inspector = new ScriptedInspector(record);
  const lock = serviceLockPath(tmp);
  expect(serviceIdentityMatches(record, inspector, lock)).toBe(true);
  inspector.holdLock = false;
  expect(serviceIdentityMatches(record, inspector, lock)).toBe(false);
});

test("a dead unlocked pid is confirmed gone", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "registry-id-"));
  const record = serviceRecord();
  const inspector = new ScriptedInspector(record);
  inspector.holdLock = false;
  inspector.alive = false;
  const lock = serviceLockPath(tmp);
  expect(recordIsConfirmedGone(record, inspector, lock)).toBe(true);
  inspector.holdLock = true;
  expect(recordIsConfirmedGone(record, inspector, lock)).toBe(false);
});

test("unreadable service json is corrupt and a missing file is absent", () => {
  const home = mkdtempSync(path.join(tmpdir(), "registry-id-"));
  expect(readService(home)).toBeNull();
  writeFileSync(path.join(home, "service.json"), "{");
  expect(readService(home)).toBe(CORRUPT);
});

test("publish requires the start lock before the hook", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "registry-id-"));
  const record = serviceRecord();
  const called: boolean[] = [];
  const before = (): void => {
    called.push(true);
  };
  expect(() => writeServiceJson(home, record, before)).toThrow(LockNotHeld);
  expect(called).toEqual([]);
  await holdStartLock(home, 1, () => {
    writeServiceJson(home, record, before);
  });
  expect(called).toEqual([true]);
  expect(readFileSync(path.join(home, "service.json"), "utf8")).toContain(String(record.instance_id));
});
