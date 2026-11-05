import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { ProviderCommandFailed, runProviderCommandAsync } from "../src/provider.ts";

const sleeper = (ms: number, text: string): string[] => [process.execPath, "-e", `setTimeout(() => process.stdout.write(${JSON.stringify(text)}), ${ms})`];

test("distinct provider lookups overlap instead of running one after another", async () => {
  const started = Date.now();
  const outputs = await Promise.all([
    runProviderCommandAsync(sleeper(1500, "a")),
    runProviderCommandAsync(sleeper(1500, "b")),
    runProviderCommandAsync(sleeper(1500, "c")),
  ]);
  expect(outputs).toEqual(["a", "b", "c"]);
  expect(Date.now() - started).toBeLessThan(3500);
});

test("a lookup past its timeout is rejected", async () => {
  await expect(runProviderCommandAsync(sleeper(10_000, "x"), undefined, { timeoutMs: 300 })).rejects.toThrow(/timed out/);
});

test("a failing lookup reports its stderr; stdin reaches the command", async () => {
  await expect(runProviderCommandAsync([process.execPath, "-e", "console.error('nope'); process.exit(3)"]))
    .rejects.toBeInstanceOf(ProviderCommandFailed);
  const echoed = await runProviderCommandAsync([process.execPath, "-e", "process.stdin.pipe(process.stdout)"], "hello");
  expect(echoed).toBe("hello");
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a timeout ends descendants of the provider, including behind a Windows shim", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "migent-timeout-"));
  const pidFile = path.join(directory, "grandchild.pid");
  const script = path.join(directory, "provider.js");
  writeFileSync(script, [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    "setTimeout(() => {}, 60000);",
  ].join("\n"));
  let argv = [process.execPath, script];
  if (process.platform === "win32") {
    const shim = path.join(directory, "provider.cmd");
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}"\r\n`);
    argv = [shim];
  }
  let grandchild = 0;
  try {
    await expect(runProviderCommandAsync(argv, undefined, { timeoutMs: 1500 })).rejects.toThrow(/timed out/);
    grandchild = Number(readFileSync(pidFile, "utf8"));
    expect(grandchild).toBeGreaterThan(0);
    for (let attempt = 0; attempt < 40 && alive(grandchild); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(grandchild)).toBe(false);
  } finally {
    if (grandchild > 0 && alive(grandchild)) process.kill(grandchild, "SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
