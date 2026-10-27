import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  AgentToolRunner,
  ConfigurationError,
  SessionStore,
  createPreparedSession,
  createWorkflowSession,
  executeNamedWorkflow,
  migrateWorkflow,
  patchWorkflowText,
  repairSession,
} from "../src/index.ts";
import { parseYamlDocument } from "../src/yaml.ts";
import { PLAN_REVIEW_WORKFLOW, ScriptedProvider, tempDir } from "./support.ts";

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

class DropPlanProvider extends ScriptedProvider {
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
    new AgentToolRunner({ fake: new ScriptedProvider(responses, artifacts) }, 10),
  );
  const second = await executeNamedWorkflow(
    version2,
    { workflowId: "plan", task: "Write a plan" },
    new AgentToolRunner({ fake: new ScriptedProvider([...responses], [...artifacts]) }, 10),
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
    new AgentToolRunner({ fake: new ScriptedProvider([DONE, DONE]) }, 10),
  );
  expect(result.code).toBe(0);
  expect(result.stopReason).toBe("completed");
  expect(new SessionStore(workspace).executionSnapshots(sessionId).map((item) => item.stageId)).toEqual(["a", "b"]);
});

test("version 1 two roots are still ambiguous", async () => {
  const workspace = workspaceFor("two", TWO);
  const runner = new AgentToolRunner({ fake: new ScriptedProvider([DONE, DONE]) }, 10);
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
  const provider = new DropPlanProvider([DONE, APPROVED, DONE, APPROVED], ["# plan\n", null, "# plan again\n", null], 1);
  const runner = new AgentToolRunner({ fake: provider }, 10);
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
    new AgentToolRunner({ fake: new ScriptedProvider([DONE, DONE]) }, 10),
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

const FIX_BACK = `\
schema_version: 2
id: fixback
stages:
  - id: implement
    role: developer
    depends_on: []
  - id: review_work
    role: reviewer
    depends_on: [implement]
    decision:
      values: [approved, revise]
      routes:
        approved: write_tests
        revise: implement
  - id: write_tests
    role: developer
    depends_on: [implement, review_work]
  - id: review_tests
    role: reviewer
    depends_on: [review_work, write_tests]
    decision:
      values: [approved, revise, fix_production]
      routes:
        approved: complete
        revise: write_tests
        fix_production: implement
`;

class StatusProvider extends ScriptedProvider {
  statuses: unknown[] = [];

  constructor(
    responses: string[],
    private readonly store: SessionStore,
    private readonly sessionId: string,
  ) {
    super(responses);
  }

  override parseResponse(): [string, string | null] {
    this.statuses.push(this.store.readSessionStatus(this.sessionId).status);
    return super.parseResponse();
  }
}

test("a route back to a completed stage dispatches it and its dependents", async () => {
  const workspace = workspaceFor("fixback", FIX_BACK);
  const sessionId = createWorkflowSession(workspace, "fixback", "Fix back");
  const store = new SessionStore(workspace);
  const FIX_PRODUCTION = "status: complete\ndecision: fix_production\n\nproduction defect";
  const provider = new StatusProvider(
    [DONE, APPROVED, DONE, FIX_PRODUCTION, DONE, APPROVED, DONE, APPROVED],
    store,
    sessionId,
  );
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "fixback", sessionId },
    new AgentToolRunner({ fake: provider }, 10),
  );
  expect(result.stopReason).toBe("completed");
  expect(store.executionSnapshots(sessionId).map((item) => item.stageId)).toEqual([
    "implement",
    "review_work",
    "write_tests",
    "review_tests",
    "implement",
    "review_work",
    "write_tests",
    "review_tests",
  ]);
  expect(provider.statuses[4]).toBe("active");
  expect(provider.calls[4]!.prompt).toContain("review_tests (fix_production)");
  const events = readFileSync(path.join(workspace, ".migent", "sessions", sessionId, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, any>);
  const fixIndex = events.findIndex((event) => event.data?.outcome?.decision === "fix_production");
  expect(fixIndex).toBeGreaterThanOrEqual(0);
  expect(events[fixIndex]!.data.session_status).toBe("active");
  const next = events.slice(fixIndex + 1).find((event) => event.event === "execution.started");
  expect(next!.stage_id).toBe("implement");
  expect(next!.data.stage_attempt).toBe(2);
});

test("a prepared session captures its baseline at the first dispatch, not at prepare", async () => {
  const workspace = workspaceFor("solo", `schema_version: 2\nid: solo\nstages:\n  - id: a\n    role: developer\n`);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], {
      cwd: workspace,
      encoding: "utf8",
    }).trim();
  git("init", "-b", "main");
  writeFileSync(path.join(workspace, ".gitignore"), ".migent/config.yaml\n.migent/workflows/\n");
  git("add", "-A");
  git("commit", "-m", "initial");
  const sessionId = createPreparedSession(workspace, "wave-1", "solo");
  writeFileSync(path.join(workspace, "later.txt"), "x\n");
  git("add", "-A");
  git("commit", "-m", "between prepare and run");
  const later = git("rev-parse", "HEAD");
  writeFileSync(path.join(workspace, ".migent", "sessions", sessionId, "task.md"), "Run it", "utf8");
  const result = await executeNamedWorkflow(
    workspace,
    { workflowId: "solo", sessionId, task: "Run it", startPrepared: true },
    new AgentToolRunner({ fake: new ScriptedProvider([DONE]) }, 10),
  );
  expect(result.status).toBe("completed");
  const status = new SessionStore(workspace).readSessionStatus(sessionId);
  expect((status.baseline as { commit: string }).commit).toBe(later);
});
