import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  AgentToolRunner,
  ConfigurationError,
  SessionStore,
  createWorkflowSession,
  executeNamedWorkflow,
  migrateWorkflow,
  patchWorkflowText,
  repairSession,
} from "../src/index.ts";
import { parseYamlDocument } from "../src/yaml.ts";
import { PLAN_REVIEW_WORKFLOW, ScriptedAdapter, tempDir } from "./support.ts";

const CONFIG = `\
models:
  fake:
    provider: fake
    model: m1
roles:
  planner:
    default_model: fake
  reviewer:
    default_model: fake
  developer:
    default_model: fake
`;

const APPROVED = "status: complete\ndecision: approved\n\nok";
const DONE = "status: complete\n\ndone";

const TWO = `\
id: two
stages:
  - id: a
    role: developer
    depends_on: []
  - id: b
    role: developer
    depends_on: []
`;

class DropPlanAdapter extends ScriptedAdapter {
  private drops: number;

  constructor(responses: string[], artifacts: Array<string | null>, drops: number) {
    super(responses, artifacts);
    this.drops = drops;
  }

  override parseResponse(): [string, string | null] {
    const parsed = super.parseResponse();
    if (this.drops <= 0) return parsed;
    const prompt = this.calls.at(-1)?.prompt ?? "";
    const match = /^- plan: (.+)$/m.exec(prompt);
    const artifact = match?.[1]?.trim();
    if (artifact) {
      unlinkSync(artifact);
      this.drops -= 1;
    }
    return parsed;
  }
}

function mapping(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a mapping");
  }
  return value as Record<string, unknown>;
}

function migratedPlan(): string {
  const parsed = mapping(parseYamlDocument(PLAN_REVIEW_WORKFLOW));
  migrateWorkflow(parsed, { models: {}, roles: {} });
  return patchWorkflowText(PLAN_REVIEW_WORKFLOW, parsed);
}

function workspaceFor(workflowId: string, text: string): string {
  const workspace = tempDir("migent-v2-");
  const workflows = path.join(workspace, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), CONFIG, "utf8");
  writeFileSync(path.join(workflows, `${workflowId}.yaml`), text, "utf8");
  return workspace;
}

function outputFile(workspace: string, sessionId: string, name: string): string {
  return path.join(workspace, ".migent", "sessions", sessionId, "outputs", name);
}

test("a migrated plan workflow publishes the same output as version 1", async () => {
  const responses = [DONE, APPROVED];
  const artifacts: Array<string | null> = ["# plan\n", null];
  const version1 = workspaceFor("plan", PLAN_REVIEW_WORKFLOW);
  const version2 = workspaceFor("plan", migratedPlan());
  const first = await executeNamedWorkflow(
    version1,
    { workflowId: "plan", task: "Write a plan" },
    new AgentToolRunner({ fake: new ScriptedAdapter(responses, artifacts) }, 10),
  );
  const second = await executeNamedWorkflow(
    version2,
    { workflowId: "plan", task: "Write a plan" },
    new AgentToolRunner({ fake: new ScriptedAdapter([...responses], [...artifacts]) }, 10),
  );
  expect(first.code).toBe(0);
  expect(first.stopReason).toBe("completed");
  expect(second.code).toBe(0);
  expect(second.stopReason).toBe("completed");
  expect(second.status).toBe("completed");
  const left = readFileSync(outputFile(version1, first.sessionId, "plan.md"));
  const right = readFileSync(outputFile(version2, second.sessionId, "plan.md"));
  expect(right.equals(left)).toBe(true);
  expect(right.toString("utf8")).toBe("# plan\n");
});

test("version 2 two roots run in declaration order", async () => {
  const workspace = workspaceFor("two", `schema_version: 2\n${TWO}`);
  const sessionId = createWorkflowSession(workspace, "two", "Run both");
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "two", sessionId },
    new AgentToolRunner({ fake: new ScriptedAdapter([DONE, DONE]) }, 10),
  );
  expect(result.code).toBe(0);
  expect(result.stopReason).toBe("completed");
  expect(new SessionStore(workspace).executionSnapshots(sessionId).map((item) => item.stageId)).toEqual(["a", "b"]);
});

test("version 1 two roots are still ambiguous", async () => {
  const workspace = workspaceFor("two", TWO);
  const runner = new AgentToolRunner({ fake: new ScriptedAdapter([DONE, DONE]) }, 10);
  await expect(executeNamedWorkflow(workspace, { workflowId: "two", task: "Run both" }, runner)).rejects.toThrow(
    ConfigurationError,
  );
  await expect(executeNamedWorkflow(workspace, { workflowId: "two", task: "Run both" }, runner)).rejects.toThrow(
    /ambiguous next stage: a, b/,
  );
});

test("a missing output at quiescence exits 2 and continue reruns the producer", async () => {
  const workspace = workspaceFor("plan", migratedPlan());
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  const adapter = new DropPlanAdapter([DONE, APPROVED, DONE, APPROVED], ["# plan\n", null, "# plan again\n", null], 1);
  const runner = new AgentToolRunner({ fake: adapter }, 10);
  const first = await executeNamedWorkflow(workspace, { workflowId: "plan", sessionId }, runner);
  expect(first.code).toBe(2);
  expect(first.stopReason).toBe("outputs_missing");
  expect(first.status).toBe("active");
  expect(first.outputs).toEqual({});
  expect(existsSync(outputFile(workspace, sessionId, "plan.md"))).toBe(false);
  const store = new SessionStore(workspace);
  expect(store.readSessionStatus(sessionId).status).toBe("active");

  const second = await executeNamedWorkflow(workspace, { workflowId: "plan", sessionId }, runner);
  expect(second.code).toBe(0);
  expect(second.stopReason).toBe("completed");
  expect(second.status).toBe("completed");
  expect(readFileSync(outputFile(workspace, sessionId, "plan.md"), "utf8")).toBe("# plan again\n");
});

test("repair records session.completed when a version 2 graph becomes quiet", async () => {
  const workspace = workspaceFor("two", `schema_version: 2\n${TWO}`);
  const sessionId = createWorkflowSession(workspace, "two", "Run both");
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "two", sessionId },
    new AgentToolRunner({ fake: new ScriptedAdapter([DONE, DONE]) }, 10),
  );
  expect(result.stopReason).toBe("completed");
  const eventsPath = path.join(workspace, ".migent", "sessions", sessionId, "events.jsonl");
  const stripped = readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter((line) => !line.includes('"event":"session.completed"'))
    .join("\n");
  const rewritten = stripped.endsWith("\n") || stripped === "" ? stripped : `${stripped}\n`;
  expect(rewritten).not.toContain('"event":"session.completed"');
  writeFileSync(eventsPath, rewritten, "utf8");
  repairSession(workspace, sessionId);
  const completed = readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter((line) => line.includes('"event":"session.completed"'))
    .map((line) => JSON.parse(line) as { execution_id?: string; stage_id?: string });
  const quiet = new SessionStore(workspace).executionSnapshots(sessionId).find((item) => item.stageId === "b");
  expect(completed).toHaveLength(1);
  expect(completed[0]).toMatchObject({ execution_id: quiet?.executionId, stage_id: "b" });
});
