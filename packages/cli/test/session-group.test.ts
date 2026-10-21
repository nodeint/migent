import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AgentToolRunner, raiseCancellation, type BuildCommandInput, type CommandSpec } from "@nodeint/migent-kernel";
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

test("session continue help shows reply", async () => {
  const captured = await capture(() => main(["session", "continue", "--help"]));
  expect(captured.value).toBe(0);
  expect(captured.stdout).toContain("--reply");
  expect(captured.stdout).toContain("--reply-file");
  expect(captured.stdout).toContain('migent session continue <session> --reply "<reply>"');
  expect(captured.stdout).toContain("Role session:");
});

test("session continue rejects an empty or double reply", async () => {
  const empty = await capture(() => main(["session", "continue", "wave-3", "--reply", "   "]));
  expect(empty.value).toBe(2);
  expect(empty.stderr).toContain("--reply is empty.");
  const both = await capture(() =>
    main(["session", "continue", "wave-3", "--reply", "answer", "--reply-file", "answer.md"]),
  );
  expect(both.value).toBe(2);
  expect(both.stderr).toContain("Pass only one of --reply or --reply-file.");
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
    expect(captured.stdout).toBe("");
    expect(captured.stderr).not.toContain("deprecated");
    const sessionMatch = /session_id: (\S+)/.exec(captured.stderr);
    const sessionId = sessionMatch?.[1] ?? "";
    expect(sessionId).toContain("plan");
    const status = JSON.parse(
      readFileSync(path.join(workspace, ".migent", "sessions", sessionId, "status.json"), "utf8"),
    ) as { status?: string };
    expect(status.status).toBe("active");
    const prompt = adapter.calls[0]?.prompt ?? "";
    const roleAt = prompt.indexOf("Role instructions:\n- Stay inside the task.");
    expect(roleAt).toBeGreaterThan(prompt.indexOf("Stage: plan (role: planner)"));
    expect(prompt.indexOf("Constraints:")).toBeGreaterThan(roleAt);

    const listed = await capture(() => main(["session", "list", "--latest", "--json"], workspace));
    expect(listed.value).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({ session: sessionId, workflow: "plan", status: "active" });

    const shown = await capture(() => main(["session", "show", sessionId, "--json"], workspace));
    expect(shown.value).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({ session_id: sessionId, status: "active" });
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
    expect(started.stdout).toBe("");
    expect(started.stderr).toMatch(/stage plan · attempt 1 ·/);
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

function writeMetricsSession(
  workspace: string,
  sessionId: string,
  workflow: string,
  updatedAt: string,
  metrics: Record<string, unknown> | null = { session_id: sessionId, workflow_id: workflow, status: "completed" },
): void {
  const directory = path.join(workspace, ".migent", "sessions", sessionId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "status.json"),
    JSON.stringify({ session_id: sessionId, workflow_id: workflow, status: "completed", updated_at: updatedAt }),
  );
  writeFileSync(
    path.join(directory, "events.jsonl"),
    `${JSON.stringify({ v: 2, seq: 1, event: "session.created", timestamp: updatedAt, data: {} })}\n`,
  );
  if (metrics !== null) writeFileSync(path.join(directory, "metrics.json"), JSON.stringify(metrics));
}

test("session metrics prints one object", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: "id: plan\n" });
  try {
    writeMetricsSession(workspace, "wave-3", "plan", "2026-10-20T00:00:01.000+00:00", {
      session_id: "wave-3",
      workflow_id: "plan",
      status: "completed",
      totals: { usage: { input_tokens: 4 } },
    });
    const captured = await capture(() => main(["session", "metrics", "wave-3", "--json"], workspace));
    expect(captured.value).toBe(0);
    expect(JSON.parse(captured.stdout)).toEqual({
      session_id: "wave-3",
      workflow_id: "plan",
      status: "completed",
      totals: { usage: { input_tokens: 4 } },
    });
  } finally {
    removeWorkspace(workspace);
  }
});

test("session metrics lists sessions as JSON lines", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: "id: plan\n" });
  try {
    writeMetricsSession(workspace, "older", "plan", "2026-10-20T00:00:01.000+00:00");
    writeMetricsSession(workspace, "newer", "plan", "2026-10-20T00:00:02.000+00:00");
    writeMetricsSession(workspace, "other", "implement", "2026-10-20T00:00:03.000+00:00");
    writeMetricsSession(workspace, "open", "plan", "2026-10-20T00:00:04.000+00:00", null);
    const captured = await capture(() =>
      main(["session", "metrics", "--json", "--workflow", "plan"], workspace),
    );
    expect(captured.value).toBe(0);
    const rows = captured.stdout.trim().split("\n").map((line) => JSON.parse(line) as { session_id: string });
    expect(rows.map((row) => row.session_id)).toEqual(["newer", "older"]);
    const empty = await capture(() => main(["session", "metrics", "--json", "--workflow", "missing"], workspace));
    expect(empty.value).toBe(0);
    expect(empty.stdout).toBe("");
  } finally {
    removeWorkspace(workspace);
  }
});

function resumeCommand(stderr: string): string | undefined {
  const lines = stderr.trimEnd().split("\n");
  const label = lines.lastIndexOf("Resume with:");
  if (label === -1) return undefined;
  return lines[label + 1];
}

class CancelOnCommand extends ScriptedAdapter {
  override buildCommand(input: BuildCommandInput): CommandSpec {
    super.buildCommand(input);
    raiseCancellation(2);
    return { argv: [process.execPath, "-e", "process.exit(0)"] };
  }
}

test("session continue retries an active role session with its last prompt", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    cliHooks.runner = new AgentToolRunner({ fake: new ScriptedAdapter(["not a status header"]) }, 10);
    const failed = await capture(() =>
      main(["session", "run", "--role", "reviewer", "--prompt", "Review the change", "--json"], workspace),
    );
    const payload = JSON.parse(failed.stdout) as { session_id: string };
    expect(failed.value).toBe(1);
    expect(resumeCommand(failed.stderr)).toBe(`migent session continue ${payload.session_id}`);

    const retried = new ScriptedAdapter(["status: complete\n\ndone"]);
    cliHooks.runner = new AgentToolRunner({ fake: retried }, 10);
    const resumed = await capture(() => main(["session", "continue", payload.session_id], workspace));
    expect(resumed.value).toBe(0);
    expect(retried.calls[0]?.prompt).toContain("Review the change");
  } finally {
    cliHooks.runner = null;
    removeWorkspace(workspace);
  }
});

test("session continue resumes a role session with the same command", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    cliHooks.runner = new AgentToolRunner(
      { fake: new ScriptedAdapter(["status: blocked\nblocker: missing design\n\nneed a decision"]) },
      10,
    );
    const blocked = await capture(() =>
      main(["session", "run", "--role", "reviewer", "--prompt", "Review the change", "--json"], workspace),
    );
    const blockedPayload = JSON.parse(blocked.stdout) as { session_id: string; outcome_status: string };
    expect(blocked.value).toBe(1);
    expect(blockedPayload.outcome_status).toBe("blocked");
    expect(resumeCommand(blocked.stderr)).toBe(`migent session continue ${blockedPayload.session_id}`);

    const continued = new ScriptedAdapter(["status: complete\n\ndone"]);
    cliHooks.runner = new AgentToolRunner({ fake: continued }, 10);
    const resumed = await capture(() => main(["session", "continue", blockedPayload.session_id], workspace));
    expect(resumed.value).toBe(0);
    expect(resumed.stdout).toContain("complete");
    expect(continued.calls[0]?.prompt).toContain("missing design");
    expect(continued.calls[0]?.prompt).toContain("handled outside this session");
    expect(resumed.stderr).not.toContain("Resume with:");

    const workflowOnly = await capture(() =>
      main(["session", "continue", blockedPayload.session_id, "--once"], workspace),
    );
    expect(workflowOnly.value).toBe(2);
    expect(workflowOnly.stderr).toContain("role session");
    expect(workflowOnly.stderr).toContain("--once");
  } finally {
    cliHooks.runner = null;
    removeWorkspace(workspace);
  }
});

test("session continue resumes a cancelled role session and leaves a completed one stopped", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    cliHooks.runner = new AgentToolRunner({ fake: new CancelOnCommand([]) }, 10);
    const cancelled = await capture(() =>
      main(["session", "run", "--role", "reviewer", "--prompt", "Review the saved turn", "--json"], workspace),
    );
    expect(cancelled.value).toBe(130);
    const sessionId = resumeCommand(cancelled.stderr)?.slice("migent session continue ".length);
    expect(sessionId).toBeTruthy();

    const resumedAdapter = new ScriptedAdapter(["status: complete\n\ndone"]);
    cliHooks.runner = new AgentToolRunner({ fake: resumedAdapter }, 10);
    const resumed = await capture(() => main(["session", "continue", String(sessionId)], workspace));
    expect(resumed.value).toBe(0);
    expect(resumedAdapter.calls[0]?.prompt).toContain("Review the saved turn");
    expect(resumed.stderr).not.toContain("Resume with:");

    const idle = new ScriptedAdapter(["status: complete\n\nshould not run"]);
    cliHooks.runner = new AgentToolRunner({ fake: idle }, 10);
    const again = await capture(() => main(["session", "continue", String(sessionId)], workspace));
    expect(again.value).toBe(0);
    expect(again.stderr).toContain(`Session ${sessionId} is completed.`);
    expect(idle.calls).toEqual([]);

    const replied = new ScriptedAdapter(["status: complete\n\nnext"]);
    cliHooks.runner = new AgentToolRunner({ fake: replied }, 10);
    const next = await capture(() =>
      main(["session", "continue", String(sessionId), "--reply", "Look at the risks"], workspace),
    );
    expect(next.value).toBe(0);
    expect(replied.calls[0]?.prompt).toContain("Look at the risks");
  } finally {
    cliHooks.runner = null;
    removeWorkspace(workspace);
  }
});

test("session metrics requires --json", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: "id: plan\n" });
  try {
    const captured = await capture(() => main(["session", "metrics", "wave-3"], workspace));
    expect(captured.value).toBe(2);
    expect(captured.stderr).toContain("session metrics requires --json.");
  } finally {
    removeWorkspace(workspace);
  }
});

test("session metrics rejects a session with no sealed file", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: "id: plan\n" });
  try {
    writeMetricsSession(workspace, "open", "plan", "2026-10-20T00:00:01.000+00:00", null);
    const missing = await capture(() => main(["session", "metrics", "missing", "--json"], workspace));
    expect(missing.value).toBe(2);
    expect(missing.stderr).toContain(
      "No metrics for session: missing. Metrics are recorded when a workflow session completes.",
    );
    const open = await capture(() => main(["session", "metrics", "open", "--json"], workspace));
    expect(open.value).toBe(2);
    expect(open.stderr).toContain(
      "No metrics for session: open. Metrics are recorded when a workflow session completes.",
    );
  } finally {
    removeWorkspace(workspace);
  }
});

test("session metrics leaves a corrupt sealed file in place", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: "id: plan\n" });
  try {
    writeMetricsSession(workspace, "wave-3", "plan", "2026-10-20T00:00:01.000+00:00", null);
    const file = path.join(workspace, ".migent", "sessions", "wave-3", "metrics.json");
    writeFileSync(file, "not-json");
    const captured = await capture(() => main(["session", "metrics", "wave-3", "--json"], workspace));
    expect(captured.value).toBe(2);
    expect(captured.stderr).toContain("metrics.json for session wave-3 is not valid JSON.");
    expect(readFileSync(file, "utf8")).toBe("not-json");
  } finally {
    removeWorkspace(workspace);
  }
});
