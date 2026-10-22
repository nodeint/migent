import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AgentToolRunner, createWorkflowSession } from "@nodeint/migent-kernel";
import { expect, test } from "vitest";
import { followSession } from "../src/commands/watch.ts";
import { cliHooks } from "../src/hooks.ts";
import { main } from "../src/index.ts";
import { ScriptedProvider, capture, removeWorkspace, repoWorkflowText, writeFakeWorkflowWorkspace } from "./support.ts";

test("a v1 session works with show, list, follow, continue, and repair", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
    const directory = path.join(workspace, ".migent", "sessions", sessionId);
    const manifestPath = path.join(directory, "manifest.yaml");
    const stripped = readFileSync(manifestPath, "utf8").replace(/\nschema_version:.*(?:\n|$)/, "\n");
    const manifest = /^status:/m.test(stripped) ? stripped : `${stripped.replace(/\n$/, "")}\nstatus: running\n`;
    writeFileSync(manifestPath, manifest.endsWith("\n") ? manifest : `${manifest}\n`, "utf8");
    rmSync(path.join(directory, "workflow.frozen.yaml"));

    const listed = await capture(() => main(["session", "list", "--json"], workspace));
    expect(listed.value).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual(
      expect.arrayContaining([expect.objectContaining({ session: sessionId, workflow: "plan", status: "active" })]),
    );

    const shown = await capture(() => main(["session", "show", sessionId, "--json"], workspace));
    expect(shown.value).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({ session_id: sessionId, workflow_id: "plan", status: "active" });

    const followed = await capture(() => followSession(workspace, sessionId, { once: true }));
    expect(followed.value).toBe(0);
    expect(followed.stdout).toContain(sessionId);

    cliHooks.runner = new AgentToolRunner({ fake: new ScriptedProvider(["status: complete\n\ndone"], ["# Plan\n"]) }, 10);
    const continued = await capture(() => main(["session", "continue", sessionId, "--once"], workspace));
    expect(continued.value).toBe(0);
    expect(continued.stdout).toBe("");
    const statusAfter = JSON.parse(readFileSync(path.join(directory, "status.json"), "utf8")) as { status?: string };
    expect(statusAfter.status).toBe("active");

    const repaired = await capture(() => main(["session", "repair", sessionId], workspace));
    expect(repaired.value).toBe(0);
    expect(JSON.parse(repaired.stdout)).toMatchObject({ session_id: sessionId, status: "active" });
    const status = JSON.parse(readFileSync(path.join(directory, "status.json"), "utf8")) as {
      workflow_id?: string;
      task_sha256?: string;
    };
    expect(status.workflow_id).toBe("plan");
    expect(status.task_sha256).toMatch(/^[a-f0-9]{64}$/);
    const manifestText = readFileSync(manifestPath, "utf8");
    expect(manifestText).toContain("status: running");
    expect(manifestText).not.toContain("schema_version:");
    expect(existsSync(path.join(directory, "workflow.frozen.yaml"))).toBe(false);
  } finally {
    cliHooks.runner = null;
    removeWorkspace(workspace);
  }
});
