import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentToolRunner } from "@nodeint/migent-kernel";
import { expect, test } from "vitest";
import { cliHooks } from "../src/hooks.ts";
import { main } from "../src/index.ts";
import { ScriptedAdapter, capture, removeWorkspace, repoWorkflowText, writeFakeWorkflowWorkspace } from "./support.ts";

function writeWatchSession(workspace: string, status: string): void {
  const root = path.join(workspace, ".migent");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "config.yaml"), "schema_version: 1\n", "utf8");
  const sessionDirectory = path.join(workspace, ".migent", "sessions", "run-1");
  const executionDirectory = path.join(sessionDirectory, "executions", "0001-implement--attempt-01");
  mkdirSync(executionDirectory, { recursive: true });
  writeFileSync(
    path.join(sessionDirectory, "events.jsonl"),
    `${JSON.stringify({ event: "provider.heartbeat", stage_id: "implement", timestamp: "2026-09-19T10:20:30Z" })}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(executionDirectory, "execution.json"),
    JSON.stringify({ execution_id: "0001-implement--attempt-01", stage_id: "implement", status: "running" }),
    "utf8",
  );
  writeFileSync(
    path.join(sessionDirectory, "status.json"),
    JSON.stringify({
      session_id: "run-1",
      status,
      latest_execution_id: "0001-implement--attempt-01",
      updated_at: "2026-09-19T10:20:30Z",
    }),
    "utf8",
  );
}

test("start --once and continue --once match a single stage", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    cliHooks.runner = new AgentToolRunner(
      { fake: new ScriptedAdapter(["status: complete\n\nplanned", "status: complete\ndecision: approved\n\nshould not run"], ["# Plan\n", null]) },
      10,
    );
    const started = await capture(() => main(["start", "plan", "--task", "Write a plan", "--once"], workspace));
    const startedPayload = JSON.parse(started.stdout) as { stop_reason: string; session_status: string; session_id: string };
    expect(started.value).toBe(0);
    expect(started.stdout.endsWith("\n")).toBe(true);
    expect(started.stdout.trim().split("\n")).toHaveLength(1);
    expect(startedPayload.stop_reason).toBe("stage");
    expect(startedPayload.session_status).toBe("active");

    cliHooks.runner = new AgentToolRunner(
      { fake: new ScriptedAdapter(["status: complete\ndecision: revise\n\nneeds work", "status: complete\n\nshould not run"], [null, "# Plan\n"]) },
      10,
    );
    const continued = await capture(() => main(["continue", startedPayload.session_id, "--once"], workspace));
    const continuedPayload = JSON.parse(continued.stdout) as { stop_reason: string; session_status: string; stages: Array<{ outcome_decision?: string }> };
    expect(continued.value).toBe(0);
    expect(continuedPayload.stop_reason).toBe("stage");
    expect(continuedPayload.session_status).toBe("active");
    expect(continuedPayload.stages[0]?.outcome_decision).toBe("revise");
  } finally {
    removeWorkspace(workspace);
  }
});

test("continue --once does not reset revision counts", async () => {
  const workflow = repoWorkflowText("plan").replace("max_revisions: 3", "max_revisions: 0");
  const workspace = writeFakeWorkflowWorkspace({ plan: workflow });
  try {
    cliHooks.runner = new AgentToolRunner(
      {
        fake: new ScriptedAdapter(
          ["status: complete\n\nplanned", "status: complete\ndecision: revise\n\nrevise"],
          ["# Plan\n", null],
        ),
      },
      10,
    );
    const started = await capture(() => main(["start", "plan", "--task", "Write a plan"], workspace));
    const payload = JSON.parse(started.stdout) as { session_id: string; stop_reason: string };
    expect(started.value).toBe(4);
    expect(payload.stop_reason).toBe("revisions_exhausted");
    expect(started.stderr).toContain(`Resume with: migent continue ${payload.session_id}`);
    expect(started.stdout.trim().split("\n")).toHaveLength(1);

    cliHooks.runner = new AgentToolRunner({ fake: new ScriptedAdapter(["status: complete\n\nshould not run"], [null]) }, 10);
    const once = await capture(() => main(["continue", payload.session_id, "--once"], workspace));
    const oncePayload = JSON.parse(once.stdout) as { stop_reason: string };
    expect(once.value).toBe(4);
    expect(oncePayload.stop_reason).toBe("revisions_exhausted");
  } finally {
    removeWorkspace(workspace);
  }
});

test("--once rejects attempt and dispatch flags from the raw options", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    for (const argv of [
      ["start", "plan", "--task", "Write a plan", "--once", "--attempts", "1"],
      ["continue", "session", "--once", "--max-dispatches", "2"],
      ["start", "plan", "--task", "Write a plan", "--once", "--unlimited-dispatches"],
    ]) {
      const captured = await capture(() => main(argv, workspace));
      expect(captured.value).toBe(2);
      expect(captured.stderr).toContain("--once cannot be combined");
      expect(captured.stdout).toBe("");
    }
  } finally {
    removeWorkspace(workspace);
  }
});

test("deprecated aliases keep their exit codes and name the replacement", async () => {
  const attempts = await capture(() => main(["stage", "--workflow", "plan", "--task", "Write a plan", "--attempts", "1"]));
  expect(attempts.value).toBe(2);
  expect(attempts.stderr).toContain("--attempts");
  const bare = await capture(() => main(["stage"]));
  expect(bare.value).toBe(2);
  expect(bare.stderr).toContain("'stage' is deprecated; use 'start WORKFLOW --task TASK --once'.");
  expect(bare.stderr).toContain("Pass SESSION, or both --workflow and --task.");

  const workspace = mkdtempSync(path.join(tmpdir(), "migent-cli-"));
  try {
    writeWatchSession(workspace, "blocked");
    const watched = await capture(() => main(["watch", "run-1", "--once", "--until"], workspace));
    expect(watched.value).toBe(2);
    expect(watched.stderr).toContain("'watch' is deprecated; use 'sessions SESSION'.");
    expect(watched.stderr).toContain("--once cannot be combined with --until.");

    const snapshot = await capture(() => main(["sessions", "run-1", "--json"], workspace));
    expect(snapshot.value).toBe(0);
    const body = JSON.parse(snapshot.stdout) as { session_id: string; status: string };
    expect(body.session_id).toBe("run-1");
    expect(body.status).toBe("blocked");

    const followed = await capture(() => main(["sessions", "run-1", "--follow", "--exit-when-done"], workspace));
    expect(followed.value).toBe(1);
    expect(followed.stderr).toContain("Watching session run-1.");

    const cursor = await capture(() => main(["sessions", "run-1", "--cursor", "0"], workspace));
    expect(cursor.value).toBe(2);
    expect(cursor.stderr).toContain("--cursor requires --follow.");

    const until = await capture(() => main(["sessions", "run-1", "--until"], workspace));
    expect(until.value).toBe(2);
    expect(until.stderr).toContain("--until requires --follow.");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("agent with no flags prints help", async () => {
  const captured = await capture(() => main(["agent"]));
  expect(captured.value).toBe(2);
  expect(captured.stdout).toContain("Usage: migent agent");
  expect(captured.stdout).toContain("Label for the new session.");
});

test("sessions help shows list snapshot and follow examples", async () => {
  const captured = await capture(() => main(["sessions", "--help"]));
  expect(captured.value).toBe(0);
  expect(captured.stdout).toContain("migent sessions");
  expect(captured.stdout).toContain("migent sessions <session>");
  expect(captured.stdout).toContain("migent sessions <session> --follow");
  expect(captured.stdout).toContain("tools");
});
