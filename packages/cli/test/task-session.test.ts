import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { main } from "../src/index.ts";
import { ScriptedProvider, capture, removeWorkspace, repoWorkflowText, writeFakeWorkflowWorkspace } from "./support.ts";
import { AgentToolRunner } from "@nodeint/migent-kernel";
import { cliHooks } from "../src/hooks.ts";

async function runOnce(
  workspace: string,
  argv: string[],
  provider: ScriptedProvider,
): Promise<{ code: number; sessionId: string; executionId: string }> {
  cliHooks.runner = new AgentToolRunner({ fake: provider }, 10);
  const captured = await capture(() => main(argv, workspace));
  const sessionMatch = /session_id: (\S+)/.exec(captured.stderr);
  const sessionFlag = argv.indexOf("--session");
  const sessionId = sessionMatch?.[1] ?? (sessionFlag >= 0 ? argv[sessionFlag + 1] : "") ?? "";
  const executions = path.join(workspace, ".migent", "sessions", sessionId, "executions");
  const executionId = existsSync(executions) ? (readdirSync(executions)[0] ?? "") : "";
  return {
    code: captured.value as number,
    sessionId,
    executionId,
  };
}

test("prepare writes a chosen session and start runs task.md", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    const badId = await capture(() => main(["session", "prepare", "one\ntwo", "--workflow", "plan"], workspace));
    expect(badId.value).toBe(2);
    expect(badId.stderr).toContain("one line");

    const prepared = await capture(() => main(["session", "prepare", "some task title", "--workflow", "plan"], workspace));
    expect(prepared.value).toBe(0);
    const preparedBody = JSON.parse(prepared.stdout) as { session_id: string; title: string; task_path: string };
    expect(preparedBody).toEqual({
      session_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      title: "some task title",
      status: "prepared",
      task_path: `.migent/sessions/${preparedBody.session_id}/task.md`,
    });
    expect(prepared.stderr).toContain(`session_id: ${preparedBody.session_id}`);
    const sessionId = preparedBody.session_id;

    const duplicate = await capture(() => main(["session", "prepare", "some task title", "--workflow", "plan"], workspace));
    expect(duplicate.value).toBe(0);
    const duplicateBody = JSON.parse(duplicate.stdout) as { session_id: string; title: string };
    expect(duplicateBody.title).toBe("some task title");
    expect(duplicateBody.session_id).not.toBe(sessionId);

    const listed = await capture(() => main(["session", "list", "--status", "prepared", "--json"], workspace));
    expect(listed.value).toBe(0);
    const listedRows = JSON.parse(listed.stdout) as Array<{ session: string }>;
    expect(listedRows).toHaveLength(2);
    expect(listedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ session: duplicateBody.session_id, title: "some task title", workflow: "plan", status: "prepared" }),
        expect.objectContaining({ session: sessionId, title: "some task title", workflow: "plan", status: "prepared" }),
      ]),
    );

    const snapshot = await capture(() => main(["session", "show", sessionId, "--json"], workspace));
    expect(snapshot.value).toBe(0);
    expect(JSON.parse(snapshot.stdout)).toMatchObject({ session_id: sessionId, title: "some task title", status: "prepared" });

    const early = await capture(() => main(["session", "continue", sessionId], workspace));
    expect(early.value).toBe(2);
    expect(early.stderr).toContain(`migent session run --session ${sessionId} --workflow plan`);

    const missing = await capture(() => main(["session", "run", "--session", sessionId, "--workflow", "plan", "--once"], workspace));
    expect(missing.value).toBe(2);
    expect(missing.stderr).toContain("no task.md");

    const taskPath = path.join(workspace, ".migent", "sessions", sessionId, "task.md");
    writeFileSync(taskPath, "Migrate the plugin API for wave 3.\nDetails follow.\n", "utf8");
    const started = await runOnce(
      workspace,
      ["session", "run", "--session", sessionId, "--workflow", "plan", "--once", "--verbose"],
      new ScriptedProvider(["status: complete\n\nplanned"], ["# Plan\n"]),
    );
    expect(started.code).toBe(0);
    expect(started.sessionId).toBe(sessionId);
    const executionDirectory = path.join(
      workspace,
      ".migent",
      "sessions",
      sessionId,
      "executions",
      started.executionId,
    );
    const prompt = readFileSync(path.join(executionDirectory, "prompt.md"), "utf8");
    expect(prompt).toContain("task.md");
    expect(prompt).toContain(sessionId);
    expect(prompt).not.toContain("Migrate the plugin API");
    expect(readFileSync(path.join(executionDirectory, "task.md"), "utf8")).toContain("Migrate the plugin API");

    const activeAgain = await capture(() => main(["session", "run", "--session", sessionId, "--workflow", "plan"], workspace));
    expect(activeAgain.value).toBe(2);
    expect(activeAgain.stderr).toContain(`migent session continue ${sessionId}`);

    writeFileSync(taskPath, "Changed after dispatch.\n", "utf8");
    const changed = await capture(() => main(["session", "continue", sessionId, "--once"], workspace));
    expect(changed.value).toBe(2);
    expect(changed.stderr).toContain("task.md changed");
  } finally {
    removeWorkspace(workspace);
  }
});

test("start --task stores one line and rejects a newline", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    const bad = await capture(() => main(["session", "run", "--workflow", "plan", "--task", "one\ntwo"], workspace));
    expect(bad.value).toBe(2);
    expect(bad.stderr).toContain("one line");
    expect(existsSync(path.join(workspace, ".migent", "sessions"))).toBe(false);

    const trailing = await capture(() => main(["session", "run", "--workflow", "plan", "--task", "one\n"], workspace));
    expect(trailing.value).toBe(2);
    expect(trailing.stderr).toContain("one line");
    expect(existsSync(path.join(workspace, ".migent", "sessions"))).toBe(false);

    const started = await runOnce(
      workspace,
      ["session", "run", "--workflow", "plan", "--task", "Write a plan", "--once", "--verbose"],
      new ScriptedProvider(["status: complete\n\nplanned"], ["# Plan\n"]),
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
