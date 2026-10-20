import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AgentToolRunner } from "@nodeint/migent-kernel";
import { expect, test } from "vitest";
import { cliHooks } from "../src/hooks.ts";
import { main } from "../src/index.ts";
import { ScriptedAdapter, capture, removeWorkspace, repoWorkflowText, writeFakeWorkflowWorkspace } from "./support.ts";

const SPLIT = "Pass --workflow for a workflow run, or --role for an agent run.";

test("session without a subcommand prints help", async () => {
  const captured = await capture(() => main(["session"]));
  expect(captured.value).toBe(2);
  expect(captured.stdout).toContain("Usage: migent session");
  expect(captured.stdout).toContain("run");
  expect(captured.stdout).toContain("list");
  expect(captured.stdout).toContain("show");
  expect(captured.stdout).toContain("follow");
});

test("session prepare help names the workflow start", async () => {
  const captured = await capture(() => main(["session", "prepare", "--help"]));
  expect(captured.value).toBe(0);
  expect(captured.stdout.replaceAll(/\s+/g, " ")).toContain(
    "session run --session <id> --workflow <workflow>",
  );
});

test("session run help shows both modes", async () => {
  const captured = await capture(() => main(["session", "run", "--help"]));
  expect(captured.value).toBe(0);
  expect(captured.stdout).toContain("migent session run --workflow plan --task");
  expect(captured.stdout).toContain("migent session run --session wave-3 --workflow plan");
  expect(captured.stdout).toContain("migent session run --role reviewer --prompt");
  expect(captured.stdout).toContain("With --workflow:");
  expect(captured.stdout).toContain("Without --workflow:");
});

test("session run requires a workflow or a role", async () => {
  const neither = await capture(() => main(["session", "run"]));
  expect(neither.value).toBe(2);
  expect(neither.stderr).toContain(SPLIT);

  const sessionOnly = await capture(() => main(["session", "run", "--session", "wave-3"]));
  expect(sessionOnly.value).toBe(2);
  expect(sessionOnly.stderr).toContain(SPLIT);

  const both = await capture(() => main(["session", "run", "--workflow", "plan", "--role", "reviewer", "--prompt", "x"]));
  expect(both.value).toBe(2);
  expect(both.stderr).toContain(SPLIT);

  const once = await capture(() => main(["session", "run", "--role", "reviewer", "--prompt", "x", "--once"]));
  expect(once.value).toBe(2);
  expect(once.stderr).toContain(SPLIT);

  const refresh = await capture(() =>
    main(["session", "run", "--role", "reviewer", "--prompt", "x", "--refresh-workflow"]),
  );
  expect(refresh.value).toBe(2);
  expect(refresh.stderr).toContain(SPLIT);

  const empty = await capture(() => main(["session", "run", "--workflow", " "]));
  expect(empty.value).toBe(2);
  expect(empty.stderr).toContain("--workflow is empty.");
});

test("session run --refresh-workflow requires an existing session", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    const captured = await capture(() =>
      main(["session", "run", "--workflow", "plan", "--task", "Write a plan", "--refresh-workflow"], workspace),
    );
    expect(captured.value).toBe(2);
    expect(captured.stderr).toContain("--refresh-workflow requires an existing session.");
    expect(existsSync(path.join(workspace, ".migent", "sessions"))).toBe(false);
  } finally {
    removeWorkspace(workspace);
  }
});

test("session run --workflow dispatches one stage", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  const configPath = path.join(workspace, ".migent", "config.yaml");
  writeFileSync(
    configPath,
    readFileSync(configPath, "utf8").replace(
      "  planner:\n    default_model: fake-model\n",
      "  planner:\n    default_model: fake-model\n    instructions:\n      - Stay inside the task.\n",
    ),
  );
  const adapter = new ScriptedAdapter(["status: complete\n\nplanned"], ["# Plan\n"]);
  cliHooks.runner = new AgentToolRunner({ fake: adapter }, 10);
  try {
    const captured = await capture(() =>
      main(["session", "run", "--workflow", "plan", "--task", "Write a plan", "--once"], workspace),
    );
    expect(captured.value).toBe(0);
    expect(captured.stderr).not.toContain("deprecated");
    const payload = JSON.parse(captured.stdout) as { session_id: string; session_status: string };
    expect(payload.session_id).toContain("plan");
    expect(payload.session_status).toBe("active");
    const prompt = adapter.calls[0]?.prompt ?? "";
    const roleAt = prompt.indexOf("Role instructions:\n- Stay inside the task.");
    expect(roleAt).toBeGreaterThan(prompt.indexOf("Stage: plan (role: planner)"));
    expect(prompt.indexOf("Constraints:")).toBeGreaterThan(roleAt);

    const listed = await capture(() => main(["session", "list", "--latest", "--json"], workspace));
    expect(listed.value).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({ session: payload.session_id, workflow: "plan", status: "active" });

    const shown = await capture(() => main(["session", "show", payload.session_id, "--json"], workspace));
    expect(shown.value).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({ session_id: payload.session_id, status: "active" });
  } finally {
    cliHooks.runner = null;
    removeWorkspace(workspace);
  }
});

test("session run without --workflow runs one role", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  const configPath = path.join(workspace, ".migent", "config.yaml");
  writeFileSync(
    configPath,
    readFileSync(configPath, "utf8").replace(
      "  reviewer:\n    default_model: fake-model\n",
      "  reviewer:\n    default_model: fake-model\n    instructions:\n      - Judge the change.\n",
    ),
  );
  const adapter = new ScriptedAdapter(["status: complete\n\ndone", "status: complete\n\nagain"]);
  try {
    cliHooks.runner = new AgentToolRunner({ fake: adapter }, 10);
    const captured = await capture(() =>
      main(["session", "run", "--role", "reviewer", "--prompt", "Review the latest changes", "--json"], workspace),
    );
    expect(captured.value).toBe(0);
    const payload = JSON.parse(captured.stdout) as { outcome_status: string; session_id: string };
    expect(payload.outcome_status).toBe("complete");
    expect(adapter.calls[0]?.prompt).toContain(
      "Role instructions:\n- Judge the change.\n\nReview the latest changes",
    );

    cliHooks.runner = new AgentToolRunner({ fake: adapter }, 10);
    const again = await capture(() =>
      main(
        ["session", "run", "--role", "reviewer", "--session", payload.session_id, "--prompt", "Summarize the risks", "--json"],
        workspace,
      ),
    );
    expect(again.value).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ session_id: payload.session_id, outcome_status: "complete" });
    expect(adapter.calls[1]?.prompt).toContain(
      "Role instructions:\n- Judge the change.\n\nSummarize the risks",
    );
  } finally {
    cliHooks.runner = null;
    removeWorkspace(workspace);
  }
});

test("session prepare starts through session run --workflow", async () => {
  const workspace = writeFakeWorkflowWorkspace({
    plan: repoWorkflowText("plan"),
    "plan-implement": repoWorkflowText("plan-implement"),
  });
  try {
    const prepared = await capture(() => main(["session", "prepare", "wave-3", "--workflow", "plan"], workspace));
    expect(prepared.value).toBe(0);
    expect(JSON.parse(prepared.stdout)).toEqual({
      session_id: "wave-3",
      status: "prepared",
      task_path: ".migent/sessions/wave-3/task.md",
    });

    const missing = await capture(() =>
      main(["session", "run", "--session", "wave-3", "--workflow", "plan", "--once"], workspace),
    );
    expect(missing.value).toBe(2);
    expect(missing.stderr).toContain("no task.md");

    writeFileSync(path.join(workspace, ".migent", "sessions", "wave-3", "task.md"), "Migrate the plugin API.\n", "utf8");
    const mismatch = await capture(() =>
      main(["session", "run", "--session", "wave-3", "--workflow", "plan-implement", "--once"], workspace),
    );
    expect(mismatch.value).toBe(2);
    expect(mismatch.stderr).toContain("does not match");

    cliHooks.runner = new AgentToolRunner({ fake: new ScriptedAdapter(["status: complete\n\nplanned"], ["# Plan\n"]) }, 10);
    const started = await capture(() =>
      main(["session", "run", "--session", "wave-3", "--workflow", "plan", "--once"], workspace),
    );
    expect(started.value).toBe(0);
    expect(JSON.parse(started.stdout)).toMatchObject({ session_id: "wave-3" });
  } finally {
    cliHooks.runner = null;
    removeWorkspace(workspace);
  }
});

test("removed session aliases are unknown commands", async () => {
  for (const name of ["start", "prepare", "continue", "sessions", "agent", "stage", "watch"]) {
    const captured = await capture(() => main([name]));
    expect(captured.value).toBe(2);
    expect(captured.stderr).toContain(name);
  }
});
