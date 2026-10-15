import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { FileLockTimeout, withFileLockSync } from "../src/file-lock.ts";

const require = createRequire(import.meta.url);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function target(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "migent-lock-"));
  directories.push(directory);
  const file = path.join(directory, "execution.json");
  writeFileSync(file, "{}");
  return file;
}

test("lock is held during the call and released after, even on throw", () => {
  const file = target();
  expect(withFileLockSync(file, () => existsSync(`${file}.lock`))).toBe(true);
  expect(existsSync(`${file}.lock`)).toBe(false);
  expect(() =>
    withFileLockSync(file, () => {
      throw new Error("boom");
    }),
  ).toThrow("boom");
  expect(existsSync(`${file}.lock`)).toBe(false);
});

test("another process holding the lock makes us wait, then time out", async () => {
  const file = target();
  const script = `
    const lockfile = require(${JSON.stringify(require.resolve("proper-lockfile"))});
    lockfile.lockSync(process.argv[1], { realpath: false, stale: 10000 });
    process.stdout.write("locked\\n");
    setTimeout(() => process.exit(0), Number(process.argv[2]));
  `;
  const holder = spawn(process.execPath, ["-e", script, file, "600"], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise<void>((resolve) => holder.stdout?.once("data", () => resolve()));
    expect(() => withFileLockSync(file, () => "ran", 100)).toThrow(FileLockTimeout);
    // The holder exits without unlocking; proper-lockfile's exit hook removes its lock.
    await new Promise((resolve) => holder.once("exit", resolve));
    expect(withFileLockSync(file, () => "ran", 2000)).toBe("ran");
  } finally {
    holder.kill("SIGKILL");
  }
});

test("a stale lock left by a crashed holder is taken over", () => {
  const file = target();
  mkdirSync(`${file}.lock`);
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${file}.lock`, old, old);
  expect(withFileLockSync(file, () => "ran", 1000)).toBe("ran");
});
