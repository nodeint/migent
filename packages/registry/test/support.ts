import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureRegistryHome } from "../src/home.ts";

export const TOOL = { name: "migent", version: "0.1.0" };
export const TOKEN = "token-under-test-token-under-test-token-01";
export const INSTANCE = "instance-under-test-instance-under-test-01";

export function makeWorkspace(root: string, name = "demo"): string {
  const workspace = path.join(root, name);
  const config = path.join(workspace, ".migent");
  mkdirSync(config, { recursive: true });
  writeFileSync(path.join(config, "config.yaml"), "schema_version: 1\n");
  return workspace;
}

export function serviceRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 2,
    instance_id: "instance-under-test",
    pid: 424242,
    host: "127.0.0.1",
    port: 47321,
    token: "token-under-test",
    started_at: "2026-09-26T08:07:57Z",
    ...overrides,
  };
}

export function writeService(home: string, record: Record<string, unknown>): void {
  ensureRegistryHome(home);
  writeFileSync(path.join(home, "service.json"), `${JSON.stringify(record, null, 2)}\n`);
}

export function registryBytes(workspaces: unknown[]): Buffer {
  return Buffer.from(`${JSON.stringify({ schema_version: 1, workspaces })}\n`);
}

export async function waitFor(predicate: () => boolean, timeoutSec: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

export function logText(home: string): string {
  const file = path.join(home, "service.log");
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
