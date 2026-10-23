import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { SessionLock } from "@nodeint/migent-kernel";
import { main } from "../src/index.ts";
import { capture, removeWorkspace, writeFakeWorkflowWorkspace } from "./support.ts";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) removeWorkspace(workspace);
});

function sessionIn(): { workspace: string; directory: string } {
  const workspace = writeFakeWorkflowWorkspace({});
  workspaces.push(workspace);
  const directory = path.join(workspace, ".migent", "sessions", "s1");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "status.json"), JSON.stringify({ status: "active" }));
  return { workspace, directory };
}

test("cancel exits 2 for a missing session and for one nobody runs", async () => {
  const { workspace } = sessionIn();
  const missing = await capture(() => main(["session", "cancel", "nope"], workspace));
  expect(missing.value).toBe(2);
  expect(missing.stderr).toContain("does not exist");
  const idle = await capture(() => main(["session", "cancel", "s1"], workspace));
  expect(idle.value).toBe(2);
  expect(idle.stderr).toContain("migent session continue s1");
});

test("cancel exits 2 when the lock belongs to another host", async () => {
  const { workspace, directory } = sessionIn();
  writeFileSync(
    path.join(directory, "session.lock"),
    JSON.stringify({
      pid: 4242,
      host: `${os.hostname()}-other`,
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      nonce: "foreign",
    }),
  );
  const result = await capture(() => main(["session", "cancel", "s1"], workspace));
  expect(result.value).toBe(2);
});

test("cancel exits 0 once the holder stops and prints json", async () => {
  const { workspace, directory } = sessionIn();
  const lock = SessionLock.acquire(directory);
  lock.onCancelRequest(() => lock.release());
  const result = await capture(() => main(["session", "cancel", "s1", "--json"], workspace));
  expect(result.value).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ session_id: "s1", cancelled: true, status: "active" });
});

test("cancel exits 1 when the holder keeps running past --wait", async () => {
  const { workspace, directory } = sessionIn();
  const lock = SessionLock.acquire(directory);
  try {
    const result = await capture(() => main(["session", "cancel", "s1", "--wait", "1", "--json"], workspace));
    expect(result.value).toBe(1);
    expect(JSON.parse(result.stdout).cancelled).toBe(false);
  } finally {
    lock.release();
  }
});
