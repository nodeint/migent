import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { ConfigurationError, executeNamedWorkflow, loadNamedWorkflow } from "../src/index.ts";
import { AgentToolRunner } from "../src/agent-runner.ts";
import { readFoldedStatus } from "../src/session-fold.ts";
import { createAgentSession, createPreparedSession, createWorkflowSession } from "../src/session-records.ts";
import { WORKFLOW_FREEZE_FILE, loadFrozenWorkflow } from "../src/session-freeze.ts";
import { SessionStore } from "../src/session-store.ts";
import { ScriptedProvider, tempDir } from "./support.ts";

const ORIGINAL = `\
id: flow
stages:
  - id: draft
    role: developer
    depends_on: []
  - id: review
    role: reviewer
    depends_on:
      - draft
completion:
  stage: review
`;

const EDITED = `\
id: flow
# edited after the session started
stages:
  - id: intake
    role: developer
    depends_on: []
  - id: draft
    role: developer
    depends_on:
      - intake
  - id: review
    role: reviewer
    depends_on:
      - draft
completion:
  stage: review
`;

const FROZEN_CONFIG = `\
models:
  fake:
    provider: fake
    model: frozen-model
roles:
  developer:
    default_model: fake
    instructions:
      - FROZEN_ROLE_LINE
  reviewer:
    default_model: fake
`;

const LIVE_CONFIG = `\
models:
  fake:
    provider: fake
    model: live-model
roles:
  developer:
    default_model: fake
    instructions:
      - LIVE_ROLE_LINE
  reviewer:
    default_model: fake
`;

function workspaceWithFlow(): string {
  const workspace = tempDir("migent-freeze-");
  mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "workflows", "flow.yaml"), ORIGINAL, "utf8");
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), FROZEN_CONFIG, "utf8");
  return workspace;
}

function sessionDirectory(workspace: string, sessionId: string): string {
  return path.join(workspace, ".migent", "sessions", sessionId);
}

function readStatus(workspace: string, sessionId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(sessionDirectory(workspace, sessionId), "status.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

function editLiveFiles(workspace: string): void {
  writeFileSync(path.join(workspace, ".migent", "workflows", "flow.yaml"), EDITED, "utf8");
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), LIVE_CONFIG, "utf8");
}

function markSchema1(workspace: string, sessionId: string): void {
  const manifestPath = path.join(sessionDirectory(workspace, sessionId), "manifest.yaml");
  const stripped = readFileSync(manifestPath, "utf8").replace(/\nschema_version:.*(?:\n|$)/, "\n");
  const text = /^status:/m.test(stripped) ? stripped : `${stripped.replace(/\n$/, "")}\nstatus: running\n`;
  writeFileSync(manifestPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
  unlinkSync(path.join(sessionDirectory(workspace, sessionId), WORKFLOW_FREEZE_FILE));
}

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ value: T; stderr: string }> {
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await fn(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

test("an edited workflow still dispatches the frozen stage, model, and role", async () => {
  const workspace = workspaceWithFlow();
  const sessionId = createWorkflowSession(workspace, "flow", "Write the notes");
  const directory = sessionDirectory(workspace, sessionId);
  expect(readFoldedStatus(workspace, directory)).toEqual(readStatus(workspace, sessionId));
  editLiveFiles(workspace);
  const provider = new ScriptedProvider(["status: complete\n\ndone"]);
  const captured = await captureStderr(() =>
    executeNamedWorkflow(workspace, { sessionId, once: true }, new AgentToolRunner({ fake: provider }, 10)),
  );
  expect(captured.value.code).toBe(0);
  expect(new SessionStore(workspace).executionSnapshots(sessionId)[0]?.stageId).toBe("draft");
  expect(provider.calls[0]?.model).toBe("frozen-model");
  expect(provider.calls[0]?.prompt).toContain("FROZEN_ROLE_LINE");
  expect(provider.calls[0]?.prompt).not.toContain("LIVE_ROLE_LINE");
  expect(captured.stderr).toContain(
    `[migent] session ${sessionId} is using its frozen workflow. The workflow file differs.`,
  );
  expect(captured.stderr).toContain(
    `[migent] session ${sessionId} is using its frozen workflow. Stage draft model differs.`,
  );
  expect(captured.stderr).toContain(
    `[migent] session ${sessionId} is using its frozen workflow. Role developer instructions differ.`,
  );
  expect(readFoldedStatus(workspace, directory)).toEqual(readStatus(workspace, sessionId));
});

test("refresh adopts the edited route and does not change status by itself", async () => {
  const workspace = workspaceWithFlow();
  const sessionId = createWorkflowSession(workspace, "flow", "Write the notes");
  const directory = sessionDirectory(workspace, sessionId);
  editLiveFiles(workspace);
  const before = readStatus(workspace, sessionId);
  await expect(
    executeNamedWorkflow(workspace, { sessionId, once: true, stageId: "review", refreshWorkflow: true }),
  ).rejects.toThrow(/not the eligible stage/);
  expect(readStatus(workspace, sessionId)).toEqual(before);
  expect(readFoldedStatus(workspace, directory)).toEqual(before);
  const events = readFileSync(path.join(directory, "events.jsonl"), "utf8");
  expect(events).toContain('"event":"workflow.refreshed"');
  const refreshed = events
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event?: string; data?: Record<string, unknown> })
    .find((event) => event.event === "workflow.refreshed");
  expect(refreshed?.data?.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(refreshed?.data?.previous_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(refreshed?.data?.source_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(refreshed?.data?.hash).not.toBe(refreshed?.data?.previous_hash);

  const provider = new ScriptedProvider(["status: complete\n\ndone"]);
  const captured = await captureStderr(() =>
    executeNamedWorkflow(
      workspace,
      { sessionId, once: true, refreshWorkflow: true },
      new AgentToolRunner({ fake: provider }, 10),
    ),
  );
  expect(captured.stderr).not.toContain("is using its frozen workflow");
  expect(new SessionStore(workspace).executionSnapshots(sessionId)[0]?.stageId).toBe("intake");
  expect(provider.calls[0]?.model).toBe("live-model");
  expect(provider.calls[0]?.prompt).toContain("LIVE_ROLE_LINE");
  expect(readFoldedStatus(workspace, directory)).toEqual(readStatus(workspace, sessionId));
});

test("a session without a freeze follows the live workflow and refuses refresh", async () => {
  const workspace = workspaceWithFlow();
  const sessionId = createWorkflowSession(workspace, "flow", "Write the notes");
  markSchema1(workspace, sessionId);
  editLiveFiles(workspace);
  const provider = new ScriptedProvider(["status: complete\n\ndone"]);
  const result = await executeNamedWorkflow(
    workspace,
    { sessionId, once: true },
    new AgentToolRunner({ fake: provider }, 10),
  );
  expect(result.code).toBe(0);
  expect(new SessionStore(workspace).executionSnapshots(sessionId)[0]?.stageId).toBe("intake");
  expect(provider.calls[0]?.model).toBe("live-model");
  await expect(
    executeNamedWorkflow(workspace, { sessionId, refreshWorkflow: true, once: true }),
  ).rejects.toThrow(`Session ${sessionId} has no frozen workflow.`);
  expect(readFileSync(path.join(sessionDirectory(workspace, sessionId), "manifest.yaml"), "utf8")).not.toContain(
    "schema_version:",
  );
  expect(existsSync(path.join(sessionDirectory(workspace, sessionId), WORKFLOW_FREEZE_FILE))).toBe(false);
});

test("refresh while creating a session is rejected before a session exists", async () => {
  const workspace = workspaceWithFlow();
  await expect(
    executeNamedWorkflow(workspace, { workflowId: "flow", task: "Write the notes", refreshWorkflow: true }),
  ).rejects.toThrow("--refresh-workflow requires an existing session.");
  expect(existsSync(path.join(workspace, ".migent", "sessions"))).toBe(false);
});

test("refresh names a completed session and leaves the freeze in place", async () => {
  const workspace = workspaceWithFlow();
  const provider = new ScriptedProvider(["status: complete\n\ndraft", "status: complete\n\nreview"]);
  const finished = await executeNamedWorkflow(
    workspace,
    { workflowId: "flow", task: "Write the notes" },
    new AgentToolRunner({ fake: provider }, 10),
  );
  expect(finished.status).toBe("completed");
  const freezePath = path.join(sessionDirectory(workspace, finished.sessionId), WORKFLOW_FREEZE_FILE);
  const freeze = readFileSync(freezePath, "utf8");
  await expect(
    executeNamedWorkflow(workspace, { sessionId: finished.sessionId, refreshWorkflow: true }),
  ).rejects.toThrow(`Session ${finished.sessionId} is completed.`);
  expect(readFileSync(freezePath, "utf8")).toBe(freeze);
});

const VERSION2 = `\
schema_version: 2
id: flow
concurrency: 1
stages:
  - id: draft
    role: developer
    depends_on: []
    produces:
      artifact: draft.md
  - id: review
    role: reviewer
    depends_on:
      - draft
    decision:
      values:
        - approved
        - revise
      routes:
        approved: complete
        revise: draft
outputs:
  - name: draft
    from_stage: draft
    artifact: draft.md
`;

test("a version 2 workflow round-trips through the freeze", () => {
  const workspace = tempDir("migent-freeze-v2-");
  mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "workflows", "flow.yaml"), VERSION2, "utf8");
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), FROZEN_CONFIG, "utf8");
  const sessionId = createWorkflowSession(workspace, "flow", "Write the notes");
  const frozen = loadFrozenWorkflow(sessionDirectory(workspace, sessionId));
  const live = loadNamedWorkflow(workspace, "flow");
  expect(frozen?.schemaVersion).toBe(2);
  expect(frozen?.concurrency).toBe(live.concurrency);
  expect(frozen?.outputs).toEqual(live.outputs);
  expect(frozen?.completion).toBeNull();
  expect(frozen?.requires).toBeNull();
  expect(frozen?.stages.review?.routes).toEqual({ approved: "complete", revise: "draft" });
  expect(frozen?.stages.draft?.instructions).toEqual(live.stages.draft?.instructions);
});

test("refresh does not start a prepared session", async () => {
  const workspace = workspaceWithFlow();
  const sessionId = createPreparedSession(workspace, "wave-3", "flow");
  const freezePath = path.join(sessionDirectory(workspace, sessionId), WORKFLOW_FREEZE_FILE);
  const freeze = readFileSync(freezePath, "utf8");
  await expect(executeNamedWorkflow(workspace, { sessionId, refreshWorkflow: true })).rejects.toThrow(/is prepared/);
  expect(readFileSync(freezePath, "utf8")).toBe(freeze);
});

test("an agent session has no frozen workflow", async () => {
  const workspace = tempDir("migent-freeze-agent-");
  const sessionId = createAgentSession(workspace, "reviewer", "Think");
  await expect(executeNamedWorkflow(workspace, { sessionId, refreshWorkflow: true })).rejects.toThrow(
    `Session ${sessionId} has no frozen workflow.`,
  );
});
