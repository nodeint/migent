import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentToolRunner, raiseCancellation, type BuildCommandInput, type CommandSpec } from "@nodeint/migent-kernel";
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
      task: "ship the feature",
    }),
    "utf8",
  );
}

const STAGE_DURATION = String.raw`(?:\d+h )?(?:\d+m )?\d+s`;

function artifactPathsFrom(stderr: string): string[] {
  const prefix = "[migent] artifact: ";
  return stderr
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

function sessionIdFrom(stderr: string): string {
  const match = /session_id: (\S+)/.exec(stderr);
  if (!match?.[1]) throw new Error(stderr);
  return match[1];
}

test("start --once and continue --once match a single stage", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    cliHooks.runner = new AgentToolRunner(
      { fake: new ScriptedAdapter(["status: complete\n\nplanned", "status: complete\ndecision: approved\n\nshould not run"], ["# Plan\n", null]) },
      10,
    );
    const started = await capture(() => main(["session", "run", "--workflow", "plan", "--task", "Write a plan", "--once"], workspace));
    expect(started.value).toBe(0);
    expect(started.stdout).toBe("");
    expect(started.stderr).toMatch(new RegExp(String.raw`stage plan · attempt 1 · \d{2}:\d{2}:\d{2} ·`));
    expect(started.stderr).toMatch(new RegExp(String.raw`stage plan · attempt 1 · ${STAGE_DURATION} · complete\.`));
    expect(started.stderr).not.toContain("completed ·");
    expect(started.stderr).not.toContain("planned");
    const sessionId = sessionIdFrom(started.stderr);

    cliHooks.runner = new AgentToolRunner(
      { fake: new ScriptedAdapter(["status: complete\ndecision: revise\n\nneeds work", "status: complete\n\nshould not run"], [null, "# Plan\n"]) },
      10,
    );
    const continued = await capture(() => main(["session", "continue", sessionId, "--once", "--verbose"], workspace));
    expect(continued.value).toBe(0);
    expect(continued.stdout).toBe("");
    expect(continued.stderr).toMatch(
      new RegExp(String.raw`stage review-plan · attempt 1 · ${STAGE_DURATION} · complete decision=revise\.`),
    );
    expect(continued.stderr).not.toContain("needs work");
    expect(continued.stderr).not.toContain("completed ·");
  } finally {
    removeWorkspace(workspace);
  }
});

class ItemAdapter extends ScriptedAdapter {
  override buildCommand(input: BuildCommandInput): CommandSpec {
    super.buildCommand(input);
    return { argv: [process.execPath, "-e", "console.log('ITEM_START');console.log('ITEM_DONE');console.log('HEARTBEAT')"] };
  }

  parseProgressEvent(line: string): Record<string, unknown> | null {
    if (line === "ITEM_START") return { event: "provider.item_started", summary: "command started: echo hi" };
    if (line === "ITEM_DONE") return { event: "provider.item_completed", summary: "command completed: echo hi" };
    if (line === "HEARTBEAT") return { event: "provider.heartbeat", summary: "running for 30s" };
    return null;
  }
}

test("start keeps tool traces out of the coordinator result", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    cliHooks.runner = new AgentToolRunner(
      { fake: new ItemAdapter(["status: complete\n\nUNIQUE_PLAN_BODY"], ["# Plan\n"]) },
      10,
    );
    const started = await capture(() => main(["session", "run", "--workflow", "plan", "--task", "Write a plan", "--once"], workspace));
    expect(started.value).toBe(0);
    expect(started.stdout).toBe("");
    expect(started.stderr).not.toContain("UNIQUE_PLAN_BODY");
    expect(started.stderr).toMatch(new RegExp(String.raw`stage plan · attempt 1 · ${STAGE_DURATION} · complete\.`));
    expect(started.stderr).not.toContain("command started");
    expect(started.stderr).not.toContain("command completed");
    expect(started.stderr).not.toContain("running for 30s");
    const sessionDirectory = path.join(workspace, ".migent", "sessions", sessionIdFrom(started.stderr));
    const events = readFileSync(path.join(sessionDirectory, "events.jsonl"), "utf8");
    expect(events).not.toContain("provider.item_started");
    expect(events).not.toContain("provider.heartbeat");
    const status = JSON.parse(readFileSync(path.join(sessionDirectory, "status.json"), "utf8")) as {
      latest_execution_id?: string;
    };
    const stream = readFileSync(
      path.join(sessionDirectory, "executions", String(status.latest_execution_id), "stream.jsonl"),
      "utf8",
    );
    expect(stream).toContain("provider.item_started");
    expect(stream).toContain("provider.item_completed");
    expect(stream).toContain("provider.heartbeat");

    cliHooks.runner = new AgentToolRunner(
      { fake: new ItemAdapter(["status: complete\ndecision: revise\n\nUNIQUE_REVIEW"], [null]) },
      10,
    );
    const verbose = await capture(() =>
      main(["session", "continue", sessionIdFrom(started.stderr), "--once", "--progress", "--verbose"], workspace),
    );
    expect(verbose.value).toBe(0);
    expect(verbose.stdout).toBe("");
    expect(verbose.stderr).not.toContain("UNIQUE_REVIEW");
    const reviewExecution = readdirSync(path.join(sessionDirectory, "executions")).find((name) => name.includes("review"));
    const reviewResponse = readFileSync(
      path.join(sessionDirectory, "executions", String(reviewExecution), "response.md"),
      "utf8",
    );
    expect(reviewResponse).toContain("UNIQUE_REVIEW");
    const completed = verbose.stderr.split("\n").filter((line) => line.includes("command completed"));
    expect(completed).toHaveLength(1);
    expect(verbose.stderr).not.toContain("command started");
    expect(verbose.stderr).not.toContain("running for 30s");
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
    const started = await capture(() => main(["session", "run", "--workflow", "plan", "--task", "Write a plan"], workspace));
    expect(started.value).toBe(4);
    expect(started.stdout).toBe("");
    const sessionId = sessionIdFrom(started.stderr);
    expect(resumeCommand(started.stderr)).toBe(`migent session continue ${sessionId}`);

    cliHooks.runner = new AgentToolRunner({ fake: new ScriptedAdapter(["status: complete\n\nshould not run"], [null]) }, 10);
    const once = await capture(() => main(["session", "continue", sessionId, "--once"], workspace));
    expect(once.value).toBe(4);
    expect(once.stdout).toBe("");
  } finally {
    removeWorkspace(workspace);
  }
});

test("--once rejects attempt and dispatch flags from the raw options", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    for (const argv of [
      ["session", "continue", "session", "--once", "--max-dispatches", "2"],
      ["session", "run", "--workflow", "plan", "--task", "Write a plan", "--once", "--unlimited-dispatches"],
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

function resumeCommand(stderr: string): string | undefined {
  const lines = stderr.trimEnd().split("\n");
  const label = lines.lastIndexOf("Resume with:");
  if (label === -1) return undefined;
  return lines[label + 1];
}

test("a stopped session prints the continue command", async () => {
  const blockedWorkspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    cliHooks.runner = new AgentToolRunner(
      {
        fake: new ScriptedAdapter(
          ["status: complete\n\nplanned", "status: blocked\nblocker: missing design\n\nnope"],
          ["# Plan\n", null],
        ),
      },
      10,
    );
    const blocked = await capture(() => main(["session", "run", "--workflow", "plan", "--task", "Write a plan"], blockedWorkspace));
    expect(blocked.value).toBe(1);
    expect(blocked.stdout).toBe("");
    expect(blocked.stderr).toMatch(new RegExp(String.raw`· blocked\.`));
    expect(blocked.stderr).toContain("response: executions/");
    expect(blocked.stderr).not.toContain("nope");
    const blockedId = sessionIdFrom(blocked.stderr);
    expect(resumeCommand(blocked.stderr)).toBe(`migent session continue ${blockedId}`);
    expect(blocked.stdout).not.toContain("migent session continue");
  } finally {
    removeWorkspace(blockedWorkspace);
  }

  const onceWorkspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    cliHooks.runner = new AgentToolRunner(
      { fake: new ScriptedAdapter(["status: complete\n\nplanned"], ["# Plan\n"]) },
      10,
    );
    const once = await capture(() =>
      main(["session", "run", "--workflow", "plan", "--task", "Write a plan", "--once"], onceWorkspace),
    );
    expect(once.value).toBe(0);
    expect(once.stdout).toBe("");
    expect(once.stderr).not.toContain("completed ·");
    expect(resumeCommand(once.stderr)).toBe(`migent session continue ${sessionIdFrom(once.stderr)}`);
  } finally {
    removeWorkspace(onceWorkspace);
  }

  const doneWorkspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    cliHooks.runner = new AgentToolRunner(
      {
        fake: new ScriptedAdapter(
          ["status: complete\n\nplanned", "status: complete\ndecision: approved\n\nok"],
          ["# Plan\n", null],
        ),
      },
      10,
    );
    const done = await capture(() => main(["session", "run", "--workflow", "plan", "--task", "Write a plan"], doneWorkspace));
    expect(done.value).toBe(0);
    expect(done.stdout).toBe("");
    expect(done.stderr).toMatch(new RegExp(String.raw`completed · ${STAGE_DURATION}`));
    const artifacts = artifactPathsFrom(done.stderr);
    expect(artifacts).toHaveLength(1);
    expect(path.isAbsolute(artifacts[0] ?? "")).toBe(true);
    expect(artifacts[0]).toMatch(/[/\\]outputs[/\\]plan\.md$/);
    expect(readFileSync(artifacts[0] ?? "", "utf8")).toBe("# Plan\n");
    expect(done.stderr).not.toContain("artifacts:");
    expect(done.stderr).not.toContain("planned");
    expect(done.stderr).not.toContain("Resume with:");
    expect(done.stderr).not.toContain("migent session continue");
  } finally {
    removeWorkspace(doneWorkspace);
  }
});

class CancelOnCommand extends ScriptedAdapter {
  override buildCommand(input: BuildCommandInput): CommandSpec {
    super.buildCommand(input);
    raiseCancellation(2);
    return { argv: [process.execPath, "-e", "process.exit(0)"] };
  }
}

test("a cancelled session prints the continue command", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    cliHooks.runner = new AgentToolRunner({ fake: new CancelOnCommand([], []) }, 10);
    const cancelled = await capture(() => main(["session", "run", "--workflow", "plan", "--task", "Write a plan"], workspace));
    expect(cancelled.value).toBe(130);
    expect(cancelled.stdout).toBe("");
    const sessionId = sessionIdFrom(cancelled.stderr);
    const status = JSON.parse(
      readFileSync(path.join(workspace, ".migent", "sessions", sessionId, "status.json"), "utf8"),
    ) as { status?: string };
    expect(status.status).toBe("cancelled");
    expect(resumeCommand(cancelled.stderr)).toBe(`migent session continue ${sessionId}`);
  } finally {
    removeWorkspace(workspace);
  }
});

test("session show and follow keep snapshot and exit-when-done behavior", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-cli-"));
  try {
    writeWatchSession(workspace, "blocked");
    const snapshot = await capture(() => main(["session", "show", "run-1", "--json"], workspace));
    expect(snapshot.value).toBe(0);
    const body = JSON.parse(snapshot.stdout) as { session_id: string; status: string };
    expect(body.session_id).toBe("run-1");
    expect(body.status).toBe("blocked");
    expect(body).not.toHaveProperty("task");
    expect(body).toHaveProperty("events_cursor");
    expect(snapshot.stdout).not.toContain("ship the feature");
    const human = await capture(() => main(["session", "show", "run-1"], workspace));
    expect(human.value).toBe(0);
    expect(human.stdout).toContain("ship the feature");

    const followed = await capture(() => main(["session", "follow", "run-1", "--exit-when-done"], workspace));
    expect(followed.value).toBe(1);
    expect(followed.stderr).toContain("Watching session run-1.");

    const until = await capture(() => main(["session", "follow", "run-1", "--until"], workspace));
    expect(until.value).toBe(2);
    expect(until.stderr).toContain("--until requires --execution.");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("session inspect help names list, show, and follow", async () => {
  const list = await capture(() => main(["session", "list", "--help"]));
  expect(list.value).toBe(0);
  expect(list.stdout).toContain("migent session list");
  expect(list.stdout).toContain("migent session list --latest --json");
  const show = await capture(() => main(["session", "show", "--help"]));
  expect(show.stdout).toContain("migent session show <session>");
  const follow = await capture(() => main(["session", "follow", "--help"]));
  expect(follow.stdout).toContain("migent session follow <session>");
  expect(follow.stdout).toContain("--exit-when-done");
});
