import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { CORRUPT, readService, writeServiceJson } from "../src/identity.ts";
import { LockNotHeld, holdStartLock } from "../src/locks.ts";
import { serviceRecord } from "./support.ts";

test("unreadable service json is corrupt and a missing file is absent", () => {
  const home = mkdtempSync(path.join(tmpdir(), "registry-id-"));
  expect(readService(home)).toBeNull();
  writeFileSync(path.join(home, "service.json"), "{");
  expect(readService(home)).toBe(CORRUPT);
  writeFileSync(path.join(home, "service.json"), JSON.stringify(serviceRecord({ extra: 1 })));
  expect(readService(home)).toBe(CORRUPT);
  writeFileSync(path.join(home, "service.json"), JSON.stringify(serviceRecord({ schema_version: 3 })));
  expect(readService(home)).toBe(CORRUPT);
});

test("a Migent 0.1 record is read as schema 1", () => {
  const home = mkdtempSync(path.join(tmpdir(), "registry-id-"));
  const legacy = serviceRecord({
    schema_version: 1,
    pgid: 424242,
    start_key: "start-key",
    boot_id: "boot-1",
    hostname: "host.example",
  });
  writeFileSync(path.join(home, "service.json"), JSON.stringify(legacy));
  const loaded = readService(home);
  expect(loaded).not.toBe(CORRUPT);
  expect(loaded).toMatchObject({ schema_version: 1, pid: 424242, instance_id: "instance-under-test" });
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
