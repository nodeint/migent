import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { main } from "../src/index.ts";
import { ScriptedAdapter, capture, removeWorkspace, repoWorkflowText, writeFakeWorkflowWorkspace } from "./support.ts";
import { AgentToolRunner } from "@nodeint/migent-kernel";
import { cliHooks } from "../src/hooks.ts";

async function runOnce(
  workspace: string,
  argv: string[],
  adapter: ScriptedAdapter,
): Promise<{ code: number; sessionId: string; executionId: string }> {
  cliHooks.runner = new AgentToolRunner({ fake: adapter }, 10);
  const captured = await capture(() => main(argv, workspace));
  const payload = JSON.parse(captured.stdout) as {
    session_id?: string;
    stages?: Array<{ execution_id?: string }>;
  };
  return {
    code: captured.value as number,
    sessionId: String(payload.session_id),
    executionId: String(payload.stages?.[0]?.execution_id),
  };
}

test("prepare writes a chosen session and start runs task.md", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    const badId = await capture(() => main(["prepare", "Wave-3", "--workflow", "plan"], workspace));
    expect(badId.value).toBe(2);
    expect(badId.stderr).toContain("lowercase slug");

    const prepared = await capture(() => main(["prepare", "wave-3", "--workflow", "plan"], workspace));
    expect(prepared.value).toBe(0);
    expect(JSON.parse(prepared.stdout)).toEqual({
      session_id: "wave-3",
      status: "prepared",
      task_path: ".migent/sessions/wave-3/task.md",
    });
    expect(prepared.stderr).toContain("session_id: wave-3");

    const duplicate = await capture(() => main(["prepare", "wave-3", "--workflow", "plan"], workspace));
    expect(duplicate.value).toBe(2);
    expect(duplicate.stderr).toContain("already exists");

    const listed = await capture(() => main(["sessions", "--status", "prepared", "--json"], workspace));
    expect(listed.value).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([
      expect.objectContaining({ session: "wave-3", workflow: "plan", status: "prepared" }),
    ]);

    const snapshot = await capture(() => main(["sessions", "wave-3", "--json"], workspace));
    expect(snapshot.value).toBe(0);
    expect(JSON.parse(snapshot.stdout)).toMatchObject({ session_id: "wave-3", status: "prepared" });

    const early = await capture(() => main(["continue", "wave-3"], workspace));
    expect(early.value).toBe(2);
    expect(early.stderr).toContain("migent start --session wave-3");

    const missing = await capture(() => main(["start", "--session", "wave-3", "--once"], workspace));
    expect(missing.value).toBe(2);
    expect(missing.stderr).toContain("no task.md");

    const taskPath = path.join(workspace, ".migent", "sessions", "wave-3", "task.md");
    writeFileSync(taskPath, "Migrate the plugin API for wave 3.\nDetails follow.\n", "utf8");
    const started = await runOnce(
      workspace,
      ["start", "--session", "wave-3", "--once", "--verbose"],
      new ScriptedAdapter(["status: complete\n\nplanned"], ["# Plan\n"]),
    );
    expect(started.code).toBe(0);
    expect(started.sessionId).toBe("wave-3");
    const executionDirectory = path.join(
      workspace,
      ".migent",
      "sessions",
      "wave-3",
      "executions",
      started.executionId,
    );
    const prompt = readFileSync(path.join(executionDirectory, "prompt.md"), "utf8");
    expect(prompt).toContain("task.md");
    expect(prompt).toContain("wave-3");
    expect(prompt).not.toContain("Migrate the plugin API");
    expect(readFileSync(path.join(executionDirectory, "task.md"), "utf8")).toContain("Migrate the plugin API");

    const activeAgain = await capture(() => main(["start", "--session", "wave-3"], workspace));
    expect(activeAgain.value).toBe(2);
    expect(activeAgain.stderr).toContain("migent continue wave-3");

    writeFileSync(taskPath, "Changed after dispatch.\n", "utf8");
    const changed = await capture(() => main(["continue", "wave-3", "--once"], workspace));
    expect(changed.value).toBe(2);
    expect(changed.stderr).toContain("task.md changed");
  } finally {
    removeWorkspace(workspace);
  }
});

test("start --task stores one line and rejects a newline", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    const bad = await capture(() => main(["start", "plan", "--task", "one\ntwo"], workspace));
    expect(bad.value).toBe(2);
    expect(bad.stderr).toContain("one line");
    expect(existsSync(path.join(workspace, ".migent", "sessions"))).toBe(false);

    const trailing = await capture(() => main(["start", "plan", "--task", "one\n"], workspace));
    expect(trailing.value).toBe(2);
    expect(trailing.stderr).toContain("one line");
    expect(existsSync(path.join(workspace, ".migent", "sessions"))).toBe(false);

    const started = await runOnce(
      workspace,
      ["start", "plan", "--task", "Write a plan", "--once", "--verbose"],
      new ScriptedAdapter(["status: complete\n\nplanned"], ["# Plan\n"]),
    );
    expect(started.code).toBe(0);
    const sessionDirectory = path.join(workspace, ".migent", "sessions", started.sessionId);
    expect(readFileSync(path.join(sessionDirectory, "task.md"), "utf8")).toBe("Write a plan\n");
    const prompt = readFileSync(
      path.join(sessionDirectory, "executions", started.executionId, "prompt.md"),
      "utf8",
    );
    expect(prompt).not.toContain("Task: Write a plan");
    expect(prompt).toContain("task.md");
    expect(readdirSync(path.join(sessionDirectory, "executions", started.executionId))).toContain("task.md");
  } finally {
    removeWorkspace(workspace);
  }
});
