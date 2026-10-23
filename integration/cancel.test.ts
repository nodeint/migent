import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { FAKE_CURSOR, FAKE_LOG, FAKE_SCRIPT, GROK_CONFIG, COMPLETE, PROVIDER_BIN, installScript, removeWorkspace, tempWorkspace, writeWorkspace } from "./support.ts";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "cli", "dist", "index.js");

function env(workspace: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${PROVIDER_BIN}${path.delimiter}${process.env.PATH ?? ""}`,
    MIGENT_FAKE_SCRIPT: path.join(workspace, FAKE_SCRIPT),
    MIGENT_FAKE_CURSOR: path.join(workspace, FAKE_CURSOR),
    MIGENT_FAKE_LOG: path.join(workspace, FAKE_LOG),
  };
}

test("session cancel from another process stops a running role session with exit 130", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, GROK_CONFIG, {});
    installScript(workspace, [{ text: COMPLETE, delay_ms: 60_000 }]);
    const run = spawn(
      process.execPath,
      [CLI, "session", "run", "--role", "planner", "--task", "Think", "--prompt", "hello"],
      { cwd: workspace, env: env(workspace), stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const exited = new Promise<number | null>((resolve) => run.on("exit", (code) => resolve(code)));
    const sessions = path.join(workspace, ".migent", "sessions");
    const lockPath = (): string | null => {
      if (!existsSync(sessions)) return null;
      const id = readdirSync(sessions)[0];
      return id !== undefined && existsSync(path.join(sessions, id, "session.lock")) ? id : null;
    };
    let sessionId: string | null = null;
    for (let i = 0; i < 200 && sessionId === null; i += 1) {
      sessionId = lockPath();
      if (sessionId === null) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(sessionId).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const cancel = spawnSync(process.execPath, [CLI, "session", "cancel", String(sessionId), "--json"], {
      cwd: workspace,
      env: env(workspace),
      encoding: "utf8",
    });
    expect(cancel.status, cancel.stderr).toBe(0);
    expect(JSON.parse(cancel.stdout).cancelled).toBe(true);
    expect(await exited).toBe(130);
  } finally {
    removeWorkspace(workspace);
  }
}, 60_000);
