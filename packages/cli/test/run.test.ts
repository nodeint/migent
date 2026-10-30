import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentToolRunner, DEFAULT_MAX_DISPATCHES, listSessionRows } from "@nodeint/migent-kernel";
import { expect, test } from "vitest";
import { executeWorkflow } from "../src/commands/execute.ts";
import { listSessions } from "../src/commands/sessions.ts";
import { followSession } from "../src/commands/watch.ts";
import { cliHooks } from "../src/hooks.ts";
import { main } from "../src/index.ts";
import { ScriptedProvider, capture, removeWorkspace, repoWorkflowText, writeFakeWorkflowWorkspace } from "./support.ts";

type Row = Record<string, unknown>;

function writeWatchSession(
  workspace: string,
  args: { events: Record<string, unknown>[]; execution: Record<string, unknown>; sessionStatus?: Record<string, unknown> },
): void {
  const executionId = "0001-implement--attempt-01";
  const sessionDirectory = path.join(workspace, ".migent", "sessions", "run-1");
  const executionDirectory = path.join(sessionDirectory, "executions", executionId);
  mkdirSync(executionDirectory, { recursive: true });
  writeFileSync(
    path.join(sessionDirectory, "events.jsonl"),
    args.events.map((event) => `${JSON.stringify(event)}\n`).join(""),
    "utf8",
  );
  const payload = { execution_id: executionId, stage_id: "implement", status: "running", ...args.execution };
  writeFileSync(path.join(executionDirectory, "execution.json"), JSON.stringify(payload), "utf8");
  const status: Record<string, unknown> = {
    session_id: "run-1",
    status: "active",
    latest_execution_id: executionId,
    latest_execution_status: payload.status,
    updated_at: "2026-09-19T10:20:30Z",
    ...args.sessionStatus,
  };
  writeFileSync(path.join(sessionDirectory, "status.json"), JSON.stringify(status), "utf8");
}

function executionTexts(workspace: string, sessionId: string): Map<string, string> {
  const directory = path.join(workspace, ".migent", "sessions", sessionId, "executions");
  const files = new Map<string, string>();
  if (!existsSync(directory)) return files;
  for (const executionId of readdirSync(directory)) {
    const filePath = path.join(directory, executionId, "execution.json");
    if (!existsSync(filePath)) continue;
    files.set(executionId, readFileSync(filePath, "utf8"));
  }
  return files;
}

function executionFingerprint(text: string): string {
  const record = JSON.parse(text) as Record<string, unknown>;
  return JSON.stringify({
    status: record.status ?? null,
    outcome: record.outcome ?? null,
    completed_at: record.completed_at ?? null,
    failure_reason: record.failure_reason ?? null,
  });
}

function sessionIdFromOutput(stderr: string, argv: string[]): string | null {
  const match = /session_id: (\S+)/.exec(stderr);
  if (match?.[1]) return match[1];
  const continueAt = argv.indexOf("continue");
  if (continueAt >= 0) {
    const id = argv[continueAt + 1];
    if (id && !id.startsWith("-")) return id;
  }
  const sessionAt = argv.indexOf("--session");
  if (sessionAt >= 0) {
    const id = argv[sessionAt + 1];
    if (id && !id.startsWith("-")) return id;
  }
  return null;
}

function stopReasonFor(code: number, status: string): string {
  if (code === 130) return "cancelled";
  if (code === 8) return "quota";
  if (code === 7) return "verify_failed";
  if (code === 6) return "verify_exhausted";
  if (code === 5) return "dispatch_limit";
  if (code === 4) return "revisions_exhausted";
  if (code === 3) return "stage_failed";
  if (code === 2) return "configuration";
  if (status === "completed") return "completed";
  if (status === "blocked") return "blocked";
  if (status === "cancelled") return "cancelled";
  return "stage";
}

async function runExecute(workspace: string, argv: string[], provider: ScriptedProvider): Promise<[number, Row[]]> {
  const hinted = sessionIdFromOutput("", argv);
  const before = hinted === null ? new Map<string, string>() : executionTexts(workspace, hinted);
  cliHooks.runner = new AgentToolRunner({ fake: provider }, 10);
  const captured = await capture(() => main(argv, workspace));
  const sessionId = sessionIdFromOutput(captured.stderr, argv);
  if (sessionId === null) throw new Error(captured.stderr);
  const stages: Row[] = [];
  for (const [executionId, text] of executionTexts(workspace, sessionId)) {
    const previous = before.get(executionId);
    if (previous !== undefined && executionFingerprint(previous) === executionFingerprint(text)) continue;
    const record = JSON.parse(text) as Record<string, unknown>;
    const outcome =
      typeof record.outcome === "object" && record.outcome !== null && !Array.isArray(record.outcome)
        ? (record.outcome as Record<string, unknown>)
        : {};
    stages.push({
      execution_id: executionId,
      execution_order: record.execution_order,
      outcome_status: typeof outcome.status === "string" ? outcome.status : "",
      outcome_decision: typeof outcome.decision === "string" ? outcome.decision : "",
    });
  }
  stages.sort((left, right) => Number(left.execution_order ?? 0) - Number(right.execution_order ?? 0));
  const status = JSON.parse(
    readFileSync(path.join(workspace, ".migent", "sessions", sessionId, "status.json"), "utf8"),
  ) as Record<string, unknown>;
  const summary = {
    session_id: sessionId,
    session_status: status.status,
    stop_reason: stopReasonFor(captured.value as number, typeof status.status === "string" ? status.status : ""),
    outputs: status.outputs ?? {},
  };
  return [captured.value as number, [...stages, summary]];
}

function executions(workspace: string, sessionId: string): string[] {
  return readdirSync(path.join(workspace, ".migent", "sessions", sessionId, "executions"));
}

test("a snapshot prints without replaying events", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-cli-"));
  try {
    writeWatchSession(workspace, {
      events: [
        {
          event: "provider.heartbeat",
          stage_id: "implement",
          timestamp: "2026-09-19T10:20:30Z",
          summary: "running for 30s",
        },
      ],
      execution: { status: "running" },
    });
    const captured = await capture(() => followSession(workspace, "run-1", { once: true }));
    expect(captured.value).toBe(0);
    expect(captured.stdout).toContain("run-1");
    expect(captured.stdout).toContain("active");
    expect(captured.stdout).toContain("events_cursor");
    expect(captured.stdout).not.toContain("heartbeat");
    expect(captured.stdout).not.toContain("running for 30s");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("until terminal reads execution json not session status", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-cli-"));
  try {
    writeWatchSession(workspace, {
      events: [
        {
          event: "execution.failed",
          execution_id: "0001-implement--attempt-01",
          stage_id: "implement",
          timestamp: "2026-09-19T10:20:30Z",
        },
      ],
      execution: { status: "failed", error: "missing status header" },
      sessionStatus: { status: "active" },
    });
    expect(
      await followSession(workspace, "run-1", {
        executionId: "0001-implement--attempt-01",
        untilTerminal: true,
      }),
    ).toBe(1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("lists sorted rows and marks invalid status json corrupt", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-cli-"));
  try {
    const runs = path.join(workspace, ".migent", "sessions");
    for (const [name, payload] of [
      [
        "older",
        {
          updated_at: "2026-09-19T00:00:00+00:00",
          workflow_id: "plan",
          status: "completed",
          latest_execution_id: "0001",
          latest_decision: "approved",
          outputs: { plan: {} },
          task: "old task",
        },
      ],
      [
        "newer",
        {
          updated_at: "2026-09-20T00:00:00+00:00",
          workflow_id: "plan-implement",
          status: "active",
          task: "new task",
        },
      ],
    ] as const) {
      const directory = path.join(runs, name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "status.json"), JSON.stringify(payload), "utf8");
    }
    const broken = path.join(runs, "broken");
    mkdirSync(broken);
    writeFileSync(path.join(broken, "status.json"), "{", "utf8");
    expect(listSessionRows(workspace).map((row) => row[1])).toEqual(["newer", "older", "broken"]);
    expect(listSessionRows(workspace).at(-1)?.[3]).toBe("corrupt");
    const text = await capture(() => listSessions(workspace));
    expect(text.value).toBe(0);
    expect(text.stdout.indexOf("newer")).toBeLessThan(text.stdout.indexOf("older"));
    expect(text.stdout).toContain("plan-implement");
    expect(text.stdout).toContain("not started");
    expect(text.stdout).toContain("new task");
    expect(text.stdout).toContain("plan");
    expect(text.stdout).toContain("0001");
    expect(text.stdout).toContain("approved");
    expect(text.stdout).toContain("old task");
    expect(text.stdout).toContain("corrupt");
    const jsonOut = await capture(() => listSessions(workspace, { asJson: true }));
    expect(jsonOut.value).toBe(0);
    const rows = JSON.parse(jsonOut.stdout) as Array<Record<string, string>>;
    expect(rows.map((row) => row.session)).toEqual(["newer", "older", "broken"]);
    expect(rows[1]?.decision).toBe("approved");
    expect(rows[0]).not.toHaveProperty("task");
    expect(rows[1]?.outputs).toBe("plan");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("session filters select the newest match and reject bad flags", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-cli-"));
  try {
    const runs = path.join(workspace, ".migent", "sessions");
    mkdirSync(runs, { recursive: true });
    writeFileSync(path.join(workspace, ".migent", "config.yaml"), "schema_version: 1\n", "utf8");
    for (const [name, payload] of [
      [
        "older",
        {
          updated_at: "2026-09-19T00:00:00+00:00",
          workflow_id: "plan",
          status: "completed",
          latest_execution_id: "0001",
          latest_decision: "approved",
          outputs: { plan: {} },
          task: "old task",
        },
      ],
      [
        "newer",
        {
          updated_at: "2026-09-20T00:00:00+00:00",
          workflow_id: "plan-implement",
          status: "active",
          task: "new task",
        },
      ],
    ] as const) {
      const directory = path.join(runs, name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "status.json"), JSON.stringify(payload), "utf8");
    }
    const matched = await capture(() =>
      main(["session", "list", "--workflow", "plan", "--status", "completed", "--json"], workspace),
    );
    expect(matched.value).toBe(0);
    expect(JSON.parse(matched.stdout)).toEqual([
      {
        session: "older",
        title: "older",
        workflow: "plan",
        status: "completed",
        execution: "0001",
        decision: "approved",
        outputs: "plan",
      },
    ]);
    const latest = await capture(() => main(["session", "list", "--latest", "--json"], workspace));
    expect(JSON.parse(latest.stdout)).toMatchObject({ session: "newer", workflow: "plan-implement", status: "active" });
    expect(JSON.parse(latest.stdout)).not.toHaveProperty("task");
    const missing = await capture(() => main(["session", "list", "--workflow", "missing", "--latest", "--json"], workspace));
    expect(missing.value).toBe(0);
    expect(missing.stdout).toBe("null\n");
    const human = await capture(() => main(["session", "list", "--latest"], workspace));
    expect(human.stdout).toContain("new task");
    expect(human.stdout).not.toContain("old task");
    const empty = await capture(() => main(["session", "list", "--status", "cancelled"], workspace));
    expect(empty.value).toBe(0);
    expect(empty.stdout).toBe("No sessions.\n");
    const limited = await capture(() => main(["session", "list", "--limit", "1", "--json"], workspace));
    expect(JSON.parse(limited.stdout)).toEqual([
      expect.objectContaining({ session: "newer" }),
    ]);

    const combined = await capture(() => main(["session", "list", "--latest", "--limit", "1"], workspace));
    expect(combined.value).toBe(2);
    expect(combined.stderr).toContain("--latest cannot be combined with --limit.");
    const badStatus = await capture(() => main(["session", "list", "--status", "paused"], workspace));
    expect(badStatus.value).toBe(2);
    expect(badStatus.stderr).toContain("--status must be active, prepared, completed, blocked, question, cancelled, or corrupt.");
    const badLimit = await capture(() => main(["session", "list", "--limit", "0"], workspace));
    expect(badLimit.value).toBe(2);
    expect(badLimit.stderr).toContain("--limit must be an integer >= 1.");
    const blankWorkflow = await capture(() => main(["session", "list", "--workflow", " "], workspace));
    expect(blankWorkflow.value).toBe(2);
    expect(blankWorkflow.stderr).toContain("--workflow is empty.");
    const withSession = await capture(() => main(["session", "list", "newer", "--latest"], workspace));
    expect(withSession.value).toBe(2);
    expect(withSession.stderr).toContain("too many arguments");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("execute completes plan review and publishes plan", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    const provider = new ScriptedProvider(
      ["status: complete\n\nplanned", "status: complete\ndecision: approved\n\nok"],
      ["# Plan\n", null],
    );
    const [code, objects] = await runExecute(workspace, ["session", "run", "--workflow", "plan", "--task", "Write a plan"], provider);
    expect(code).toBe(0);
    expect(objects.at(-1)?.session_status).toBe("completed");
    expect(objects.at(-1)?.stop_reason).toBe("completed");
    expect(objects.at(-1)?.outputs as object).toHaveProperty("plan");
    expect(objects[0]?.outcome_status).toBe("complete");
    expect(objects[1]?.outcome_decision).toBe("approved");
    const published = path.join(
      workspace,
      ".migent",
      "sessions",
      String(objects.at(-1)?.session_id),
      "outputs",
      "plan.md",
    );
    expect(readFileSync(published, "utf8").trim().length).toBeGreaterThan(0);
  } finally {
    removeWorkspace(workspace);
  }
});

test("execute reruns plan then review after revise", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    const provider = new ScriptedProvider(
      [
        "status: complete\n\nplanned v1",
        "status: complete\ndecision: revise\n\nneeds work",
        "status: complete\n\nplanned v2",
        "status: complete\ndecision: revise\n\nstill open",
        "status: complete\n\nplanned v3",
        "status: complete\ndecision: approved\n\nok",
      ],
      ["# Plan v1\n", null, "# Plan v2\n", null, "# Plan v3\n", null],
    );
    const [code, objects] = await runExecute(workspace, ["session", "run", "--workflow", "plan", "--task", "Write a plan"], provider);
    expect(code).toBe(0);
    expect(objects.slice(0, -1).map((item) => item.outcome_decision)).toEqual([
      "",
      "revise",
      "",
      "revise",
      "",
      "approved",
    ]);
    expect(objects.at(-1)?.stop_reason).toBe("completed");
    const sessionId = String(objects.at(-1)?.session_id);
    const resumed = (executionId: unknown) =>
      JSON.parse(
        readFileSync(
          path.join(workspace, ".migent", "sessions", sessionId, "executions", String(executionId), "execution.json"),
          "utf8",
        ),
      ) as { resumes_execution_id?: string | null };
    expect(resumed(objects[2]?.execution_id).resumes_execution_id).toBe(objects[0]?.execution_id);
    expect(resumed(objects[4]?.execution_id).resumes_execution_id).toBe(objects[2]?.execution_id);
    expect(resumed(objects[1]?.execution_id).resumes_execution_id).toBeNull();
    expect(resumed(objects[3]?.execution_id).resumes_execution_id).toBe(objects[1]?.execution_id);
    expect(resumed(objects[5]?.execution_id).resumes_execution_id).toBe(objects[3]?.execution_id);
    expect(provider.calls.map((call) => call.agent_id)).toEqual([
      null,
      null,
      "native-session-1",
      "native-session-1",
      "native-session-1",
      "native-session-1",
    ]);
    expect(provider.calls[2]?.prompt).toContain("Decision that routed to this stage");
    expect(provider.calls[2]?.prompt).toContain("Previous plan artifact");
    expect(provider.calls[2]?.prompt).not.toContain("Do not write implementation code.");
    expect(provider.calls[0]?.prompt).toContain("Do not write implementation code.");
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

test("execute requires prior session then completes plan implement", async () => {
  const requiring = repoWorkflowText("plan-implement").replace(
    "schema_version: 3\n",
    "schema_version: 3\nrequires:\n  workflow: plan\n",
  );
  const workspace = writeFakeWorkflowWorkspace({
    plan: repoWorkflowText("plan"),
    "plan-implement": requiring,
  });
  try {
    for (const argv of [
      ["session", "run", "--workflow", "plan-implement", "--task", "Do work"],
      ["session", "run", "--workflow", "plan-implement", "--task", "Do work", "--once"],
    ]) {
      const captured = await capture(() => main(argv, workspace));
      expect(captured.value).toBe(2);
      expect(captured.stderr).toContain("pass --prior");
    }
    expect(readdirSync(path.join(workspace, ".migent")).includes("sessions")).toBe(false);
    const [priorCode, priorObjects] = await runExecute(
      workspace,
      ["session", "run", "--workflow", "plan", "--task", "Write a plan"],
      new ScriptedProvider(
        ["status: complete\n\nplanned", "status: complete\ndecision: approved\n\nok"],
        ["# Plan\n", null],
      ),
    );
    expect(priorCode).toBe(0);
    const priorId = String(priorObjects.at(-1)?.session_id);
    const provider = new ScriptedProvider(
      [
        "status: complete\n\nimplemented",
        "status: complete\ndecision: approved\n\nok",
        "status: complete\n\ntests written",
        "status: complete\ndecision: approved\n\nok",
      ],
      ["# impl\n", null, "# tests\n", null],
    );
    const [code, objects] = await runExecute(
      workspace,
      ["session", "run", "--workflow", "plan-implement", "--task", "Do work", "--prior", priorId],
      provider,
    );
    expect(code).toBe(0);
    expect(new Set(Object.keys(objects.at(-1)?.outputs as object))).toEqual(
      new Set(["implementation-result", "test-result"]),
    );
    const resumed = JSON.parse(
      readFileSync(
        path.join(
          workspace,
          ".migent",
          "sessions",
          String(objects.at(-1)?.session_id),
          "executions",
          String(objects[2]?.execution_id),
          "execution.json",
        ),
        "utf8",
      ),
    ) as { resumes_execution_id?: string };
    expect(resumed.resumes_execution_id).toBe(objects[0]?.execution_id);
    expect(provider.calls[2]?.agent_id).toBe("native-session-1");
    expect(provider.calls[0]?.agent_id).toBeNull();
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);

test("continue redispatches a blocked session, leaves completed sessions stopped, and finalizes a cancelled execution in place", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    const blockedProvider = new ScriptedProvider(
      ["status: complete\n\nplanned", "status: blocked\nblocker: missing design\n\nnope"],
      ["# Plan\n", null],
    );
    const [code, objects] = await runExecute(workspace, ["session", "run", "--workflow", "plan", "--task", "Write a plan"], blockedProvider);
    expect(code).toBe(1);
    expect(objects.at(-1)?.stop_reason).toBe("blocked");
    const sessionId = String(objects.at(-1)?.session_id);
    const before = executions(workspace, sessionId);
    const retry = new ScriptedProvider(["status: complete\ndecision: approved\n\nok"], [null]);
    const [code2, objects2] = await runExecute(workspace, ["session", "continue", sessionId, "--once"], retry);
    expect(code2).toBe(0);
    expect(objects2.at(-1)?.session_status).toBe("completed");
    expect(retry.calls).toHaveLength(1);
    expect(retry.calls[0]?.prompt).toContain("missing design");
    expect(executions(workspace, sessionId).length).toBe(before.length + 1);
    const idle = new ScriptedProvider(["status: complete\ndecision: approved\n\nok"], [null]);
    const [code3, objects3] = await runExecute(workspace, ["session", "continue", sessionId], idle);
    expect(code3).toBe(0);
    expect(objects3.at(-1)?.stop_reason).toBe("completed");
    expect(idle.calls).toEqual([]);
  } finally {
    removeWorkspace(workspace);
  }

  const completedWorkspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    const [doneCode, doneObjects] = await runExecute(
      completedWorkspace,
      ["session", "run", "--workflow", "plan", "--task", "Write a plan"],
      new ScriptedProvider(
        ["status: complete\n\nplanned", "status: complete\ndecision: approved\n\nok"],
        ["# Plan\n", null],
      ),
    );
    expect(doneCode).toBe(0);
    const completedId = String(doneObjects.at(-1)?.session_id);
    const unused = new ScriptedProvider(["status: complete\n\nnope"], ["# x\n"]);
    const [code3, objects3] = await runExecute(completedWorkspace, ["session", "continue", completedId], unused);
    expect(code3).toBe(0);
    expect(objects3.at(-1)?.stop_reason).toBe("completed");
    expect(unused.calls).toEqual([]);
    const unusedStage = new ScriptedProvider(["status: complete\n\nnope"], ["# x\n"]);
    const [codeStage, objectsStage] = await runExecute(completedWorkspace, ["session", "continue", completedId, "--once"], unusedStage);
    expect(codeStage).toBe(0);
    expect(objectsStage.at(-1)?.stop_reason).toBe("completed");
    expect(unusedStage.calls).toEqual([]);

    const cancelledId = String(doneObjects.at(-1)?.session_id);
    const statusPath = path.join(completedWorkspace, ".migent", "sessions", cancelledId, "status.json");
    const status = JSON.parse(readFileSync(statusPath, "utf8")) as Record<string, unknown>;
    const executionPath = path.join(
      completedWorkspace,
      ".migent",
      "sessions",
      cancelledId,
      "executions",
      String(status.latest_execution_id),
      "execution.json",
    );
    const execution = JSON.parse(readFileSync(executionPath, "utf8")) as Record<string, unknown>;
    execution.status = "cancelled";
    writeFileSync(executionPath, JSON.stringify(execution), "utf8");
    const before = executions(completedWorkspace, cancelledId);
    const unused2 = new ScriptedProvider(["status: complete\n\nnope"], ["# x\n"]);
    const [code4, objects4] = await runExecute(completedWorkspace, ["session", "continue", cancelledId], unused2);
    expect(code4).toBe(0);
    expect(objects4.at(-1)?.stop_reason).toBe("completed");
    expect(objects4[0]?.execution_id).toBe(status.latest_execution_id);
    expect(unused2.calls).toEqual([]);
    expect(executions(completedWorkspace, cancelledId)).toEqual(before);
  } finally {
    removeWorkspace(completedWorkspace);
  }
});

test("a failed stage stays active and continue --once dispatches it once", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    const provider = new ScriptedProvider(["status: complete\n\nplanned", "not a header"], ["# Plan\n", null]);
    const [code, objects] = await runExecute(
      workspace,
      ["session", "run", "--workflow", "plan", "--task", "Write a plan"],
      provider,
    );
    expect(code).toBe(3);
    expect(objects.at(-1)?.stop_reason).toBe("stage_failed");
    expect(objects.at(-1)?.session_status).toBe("active");
    const sessionId = String(objects.at(-1)?.session_id);
    const [stageCode, stageObjects] = await runExecute(
      workspace,
      ["session", "continue", sessionId, "--once"],
      new ScriptedProvider(["status: complete\ndecision: approved\n\nok"], [null]),
    );
    expect(stageCode).toBe(0);
    expect(stageObjects[0]?.outcome_decision).toBe("approved");
    expect(stageObjects.at(-1)?.session_status).toBe("completed");
    expect(stageObjects.at(-1)?.stop_reason).toBe("completed");
  } finally {
    removeWorkspace(workspace);
  }
});

test("continue dispatches a failed stage once", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    const [code, objects] = await runExecute(
      workspace,
      ["session", "run", "--workflow", "plan", "--task", "Write a plan"],
      new ScriptedProvider(["status: complete\n\nplanned", "not a header"], ["# Plan\n", null]),
    );
    expect(code).toBe(3);
    expect(objects.at(-1)?.stop_reason).toBe("stage_failed");
    const sessionId = String(objects.at(-1)?.session_id);
    const second = new ScriptedProvider(["status: complete\ndecision: approved\n\nok"], [null]);
    const [code2, objects2] = await runExecute(workspace, ["session", "continue", sessionId], second);
    expect(code2).toBe(0);
    expect(objects2.at(-1)?.stop_reason).toBe("completed");
    expect(second.calls).toHaveLength(1);
  } finally {
    removeWorkspace(workspace);
  }
});

test("stage id runs the first stage and stops", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    const provider = new ScriptedProvider(
      ["status: complete\n\nplanned", "status: complete\ndecision: approved\n\nshould not run"],
      ["# Plan\n", null],
    );
    const [code, objects] = await runExecute(
      workspace,
      ["session", "run", "--workflow", "plan", "--task", "Write a plan", "--once"],
      provider,
    );
    expect(code).toBe(0);
    expect(objects[0]?.outcome_status).toBe("complete");
    expect(objects.at(-1)?.stop_reason).toBe("stage");
    expect(objects.at(-1)?.session_status).toBe("active");
    expect(provider.calls).toHaveLength(1);
  } finally {
    removeWorkspace(workspace);
  }
});

test("stage id of a later stage creates no session", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    const provider = new ScriptedProvider(["status: complete\ndecision: approved\n\nok"], [null]);
    const [code, objects] = await runExecute(
      workspace,
      ["session", "run", "--workflow", "plan", "--task", "Write a plan", "--once"],
      provider,
    );
    expect(code).toBe(0);
    expect(objects.at(-1)?.stop_reason).toBe("stage");
    expect(provider.calls).toHaveLength(1);
  } finally {
    removeWorkspace(workspace);
  }
});

test("stage id follows eligibility after the first stage", async () => {
  const workspace = writeFakeWorkflowWorkspace({ plan: repoWorkflowText("plan") });
  try {
    const first = new ScriptedProvider(["status: complete\n\nplanned"], ["# Plan\n"]);
    const [code, objects] = await runExecute(
      workspace,
      ["session", "run", "--workflow", "plan", "--task", "Write a plan", "--once"],
      first,
    );
    expect(code).toBe(0);
    const sessionId = String(objects.at(-1)?.session_id);
    const review = new ScriptedProvider(
      ["status: complete\ndecision: revise\n\nneeds work", "status: complete\n\nshould not run"],
      [null, "# Plan\n"],
    );
    const [code2, objects2] = await runExecute(workspace, ["session", "continue", sessionId, "--once"], review);
    expect(code2).toBe(0);
    expect(objects2[0]?.outcome_decision).toBe("revise");
    expect(objects2.at(-1)?.stop_reason).toBe("stage");
    expect(objects2.at(-1)?.session_status).toBe("active");
    expect(review.calls).toHaveLength(1);
  } finally {
    removeWorkspace(workspace);
  }
});

test("stage rejects a dispatch ceiling", async () => {
  const captured = await capture(() =>
    main(["session", "run", "--workflow", "plan", "--task", "Write a plan", "--once", "--max-dispatches", "2"]),
  );
  expect(captured.value).toBe(2);
  expect(captured.stderr).toContain("--max-dispatches");
});

test("stage id resumes the declared source session", async () => {
  const workflow = `\
schema_version: 3
id: resume-sample
stages:
  - id: draft
    role: developer
    depends_on: []
    produces:
      artifact: draft.md
  - id: revise-draft
    role: developer
    session:
      resume_from: draft
    depends_on:
      - draft
    produces:
      artifact: revision.md
`;
  const workspace = writeFakeWorkflowWorkspace({ "resume-sample": workflow });
  try {
    const [code, objects] = await runExecute(
      workspace,
      ["session", "run", "--workflow", "resume-sample", "--task", "Draft", "--once"],
      new ScriptedProvider(["status: complete\n\ndraft"], ["# draft\n"]),
    );
    expect(code).toBe(0);
    const sessionId = String(objects.at(-1)?.session_id);
    const second = new ScriptedProvider(["status: complete\n\nrevised"], ["# revision\n"]);
    const [code2, objects2] = await runExecute(workspace, ["session", "continue", sessionId, "--once"], second);
    expect(code2).toBe(0);
    const resumed = JSON.parse(
      readFileSync(
        path.join(
          workspace,
          ".migent",
          "sessions",
          sessionId,
          "executions",
          String(objects2[0]?.execution_id),
          "execution.json",
        ),
        "utf8",
      ),
    ) as { resumes_execution_id?: string };
    expect(resumed.resumes_execution_id).toBe(objects[0]?.execution_id);
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]?.agent_id).toBe("native-session-1");
    expect(second.calls[0]?.new_agent_id).toBeNull();
  } finally {
    removeWorkspace(workspace);
  }
});

const REVISION_LOOP = `\
schema_version: 3
id: loop
stages:
  - id: plan
    role: planner
    max_revisions: 0
    produces:
      artifact: plan.md
  - id: review-plan
    role: reviewer
    depends_on:
      - plan
    decision:
      - approved:
          when: Choose approved according to the task.
          navigate: complete
      - revise:
          when: Choose revise according to the task.
          navigate: plan
`;

const OPEN_LOOP = `\
schema_version: 3
id: loop
stages:
  - id: plan
    role: planner
    produces:
      artifact: plan.md
  - id: review-plan
    role: reviewer
    depends_on:
      - plan
    decision:
      - approved:
          when: Choose approved according to the task.
          navigate: complete
      - revise:
          when: Choose revise according to the task.
          navigate: plan
`;

test("continue resets revision count and stage keeps new limit", async () => {
  const workspace = writeFakeWorkflowWorkspace({ loop: REVISION_LOOP.replace("max_revisions: 0", "max_revisions: 1") });
  try {
    const [code, objects] = await runExecute(
      workspace,
      ["session", "run", "--workflow", "loop", "--task", "Write a plan"],
      new ScriptedProvider(
        [
          "status: complete\n\ninitial plan",
          "status: complete\ndecision: revise\n\nrevise",
          "status: complete\n\nfirst revision",
          "status: complete\ndecision: revise\n\nrevise again",
        ],
        ["# Initial\n", null, "# First revision\n", null],
      ),
    );
    expect(code).toBe(4);
    expect(objects.at(-1)?.stop_reason).toBe("revisions_exhausted");
    const sessionId = String(objects.at(-1)?.session_id);
    const root = path.join(workspace, ".migent", "sessions", sessionId, "executions");
    const revisionPrompt = readFileSync(path.join(root, String(objects[2]?.execution_id), "prompt.md"), "utf8");
    expect(revisionPrompt).toContain(path.join(root, String(objects[1]?.execution_id), "response.md"));
    expect(revisionPrompt).toContain(path.join(root, String(objects[0]?.execution_id), "artifacts", "plan.md"));

    const second = new ScriptedProvider(["status: complete\n\nsecond revision"], ["# Second revision\n"]);
    const [limited, limitedObjects] = await runExecute(
      workspace,
      ["session", "continue", sessionId, "--max-dispatches", "1"],
      second,
    );
    expect(limited).toBe(5);
    expect(limitedObjects.at(-1)?.stop_reason).toBe("dispatch_limit");
    expect(second.calls).toHaveLength(1);
    const status = JSON.parse(
      readFileSync(path.join(workspace, ".migent", "sessions", sessionId, "status.json"), "utf8"),
    ) as { revision_baselines?: Record<string, number> };
    expect(status.revision_baselines).toEqual({ plan: 2, "review-plan": 2 });

    const reviewer = new ScriptedProvider(["status: complete\ndecision: revise\n\nrevise again"]);
    expect((await runExecute(workspace, ["session", "continue", sessionId, "--once"], reviewer))[0]).toBe(0);
    const stopped = new ScriptedProvider(["status: complete\n\nshould not run"]);
    const [stoppedCode, stoppedObjects] = await runExecute(workspace, ["session", "continue", sessionId, "--once"], stopped);
    expect(stoppedCode).toBe(4);
    expect(stoppedObjects.at(-1)?.stop_reason).toBe("revisions_exhausted");
    expect(stopped.calls).toEqual([]);

    const last = new ScriptedProvider(
      ["status: complete\n\nthird revision", "status: complete\ndecision: approved\n\napproved"],
      ["# Third revision\n", null],
    );
    const [done, doneObjects] = await runExecute(workspace, ["session", "continue", sessionId], last);
    expect(done).toBe(0);
    expect(doneObjects.at(-1)?.stop_reason).toBe("completed");
    expect(last.calls).toHaveLength(2);
  } finally {
    removeWorkspace(workspace);
  }
}, 60_000);

test("revise stops before another plan and later commands stop too", async () => {
  const workspace = writeFakeWorkflowWorkspace({ loop: REVISION_LOOP });
  try {
    const provider = new ScriptedProvider(
      [
        "status: complete\n\nplanned",
        "status: complete\ndecision: revise\n\nagain",
        "status: complete\n\nshould not run",
      ],
      ["# Plan\n", null, "# Plan\n"],
    );
    const [code, objects] = await runExecute(
      workspace,
      ["session", "run", "--workflow", "loop", "--task", "Write a plan", "--max-dispatches", "10"],
      provider,
    );
    expect(code).toBe(4);
    expect(objects.at(-1)?.stop_reason).toBe("revisions_exhausted");
    expect(objects.at(-1)?.session_status).toBe("active");
    expect(objects.slice(0, -1).map((item) => item.outcome_decision)).toEqual(["", "revise"]);
    expect(provider.calls).toHaveLength(2);
    const sessionId = String(objects.at(-1)?.session_id);
    const idle = new ScriptedProvider(["status: complete\n\nnope"], ["# Plan\n"]);
    const [continueCode, continueObjects] = await runExecute(
      workspace,
      ["session", "continue", sessionId, "--max-dispatches", "10"],
      idle,
    );
    expect(continueCode).toBe(4);
    expect(continueObjects.at(-1)?.stop_reason).toBe("revisions_exhausted");
    expect(idle.calls).toEqual([]);
    const stage = new ScriptedProvider(["status: complete\n\nnope"], ["# Plan\n"]);
    const [stageCode, stageObjects] = await runExecute(workspace, ["session", "continue", sessionId, "--once"], stage);
    expect(stageCode).toBe(4);
    expect(stageObjects.at(-1)?.stop_reason).toBe("revisions_exhausted");
    expect(stageObjects.at(-1)?.session_status).toBe("active");
    expect(stage.calls).toEqual([]);
  } finally {
    removeWorkspace(workspace);
  }
});

test("dispatch ceiling stops before the next stage", async () => {
  const workspace = writeFakeWorkflowWorkspace({ loop: OPEN_LOOP });
  try {
    const provider = new ScriptedProvider(
      [
        "status: complete\n\nplanned",
        "status: complete\ndecision: revise\n\nagain",
        "status: complete\n\nshould not run",
      ],
      ["# Plan\n", null, "# Plan\n"],
    );
    const [code, objects] = await runExecute(
      workspace,
      ["session", "run", "--workflow", "loop", "--task", "Write a plan", "--max-dispatches", "2"],
      provider,
    );
    expect(code).toBe(5);
    expect(objects.at(-1)?.stop_reason).toBe("dispatch_limit");
    expect(objects.at(-1)?.session_status).toBe("active");
    expect(provider.calls).toHaveLength(2);
    expect(objects.at(-2)?.outcome_decision).toBe("revise");
  } finally {
    removeWorkspace(workspace);
  }
});

test("default dispatch ceiling matches the constant", async () => {
  const workspace = writeFakeWorkflowWorkspace({ loop: OPEN_LOOP });
  try {
    const responses: string[] = [];
    const artifacts: Array<string | null> = [];
    for (let index = 0; index < DEFAULT_MAX_DISPATCHES + 1; index += 1) {
      if (index % 2 === 0) {
        responses.push("status: complete\n\nplanned");
        artifacts.push("# Plan\n");
      } else {
        responses.push("status: complete\ndecision: revise\n\nagain");
        artifacts.push(null);
      }
    }
    const provider = new ScriptedProvider(responses, artifacts);
    const [code, objects] = await runExecute(workspace, ["session", "run", "--workflow", "loop", "--task", "Write a plan"], provider);
    expect(code).toBe(5);
    expect(objects.at(-1)?.stop_reason).toBe("dispatch_limit");
    expect(provider.calls).toHaveLength(DEFAULT_MAX_DISPATCHES);
  } finally {
    removeWorkspace(workspace);
  }
}, 60_000);

test("unlimited dispatches runs past the default ceiling", async () => {
  const workspace = writeFakeWorkflowWorkspace({ loop: OPEN_LOOP });
  try {
    const provider = new ScriptedProvider(
      ["status: complete\n\nplanned", "status: complete\ndecision: approved\n\nok"],
      ["# Plan\n", null],
    );
    const [code, objects] = await runExecute(
      workspace,
      ["session", "run", "--workflow", "loop", "--task", "Write a plan", "--unlimited-dispatches"],
      provider,
    );
    expect(code).toBe(0);
    expect(objects.at(-1)?.stop_reason).toBe("completed");
    expect(provider.calls).toHaveLength(2);
  } finally {
    removeWorkspace(workspace);
  }
});

test("rejects a non positive dispatch ceiling", async () => {
  const workspace = writeFakeWorkflowWorkspace({ loop: OPEN_LOOP });
  try {
    await expect(
      executeWorkflow(workspace, { action: "start", workflowId: "loop", task: "Write a plan", maxDispatches: 0 }),
    ).rejects.toThrow(/--max-dispatches/);
  } finally {
    removeWorkspace(workspace);
  }
});

test("unlimited dispatches rejects an explicit ceiling", async () => {
  const captured = await capture(() =>
    main(["session", "run", "--workflow", "loop", "--task", "Write a plan", "--max-dispatches", "4", "--unlimited-dispatches"]),
  );
  expect(captured.value).toBe(2);
  expect(captured.stderr).toContain("--unlimited-dispatches");
});

test("continue rejects flags that start a session", async () => {
  const captured = await capture(() => main(["session", "continue", "run-1", "--task", "again"]));
  expect(captured.value).toBe(2);
  expect(captured.stderr).toContain("--task");
});

test("role override requires both provider and model", async () => {
  const captured = await capture(() =>
    main(["session", "run", "--role", "developer", "--provider", "grok", "--prompt", "x"]),
  );
  expect(captured.value).toBe(2);
  expect(captured.stderr).toContain("--provider");
  expect(captured.stderr).toContain("--model");
});

test("help prints command usage without a workspace", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "migent-cli-"));
  try {
    const captured = await capture(() => main(["session", "run", "--help"], cwd));
    expect(captured.value).toBe(0);
    expect(captured.stdout).toContain("Usage: migent session run");
    expect(captured.stdout).toContain("Exit 3");
    expect(captured.stdout).toContain("Exit 4");
    expect(captured.stdout).toContain("Exit 5");
    expect(captured.stdout).toContain("Exit 8");
    expect(captured.stdout).toContain("--max-dispatches");
    expect(captured.stdout).toContain("--unlimited-dispatches");
    expect(captured.stdout).toContain("--once");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("help subcommand prints flags declared on that subcommand", async () => {
  const captured = await capture(() => main(["session", "continue", "--help"]));
  expect(captured.value).toBe(0);
  expect(captured.stdout).toContain("Usage: migent session continue");
  expect(captured.stdout).toContain("--max-dispatches");
  expect(captured.stdout).toContain("--once");
  expect(captured.stdout.replace(/\s+/g, " ")).toContain("does not reset");
  expect(captured.stdout).toContain("migent session continue <session> --once");
});

test("help rejects an unknown subcommand", async () => {
  const captured = await capture(() => main(["missing"]));
  expect(captured.value).toBe(2);
  expect(captured.stderr).toContain("missing");
});

test("no command prints help", async () => {
  const captured = await capture(() => main([]));
  expect(captured.value).toBe(2);
  expect(captured.stdout).toContain("Usage: migent");
  expect(captured.stdout).toContain("session");
  expect(captured.stdout).not.toContain("execute");
});
