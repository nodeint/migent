import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  loadWorkflowDocument,
  nextStage,
  NextStage,
  NextStageError,
  requireAgentSession,
  resolvePriorSessionId,
  resolveResumeExecution,
  revisionStop,
  stageDispatchError,
  Stop,
  type ExecutionSnapshot,
  type NextStageResult,
  type RoleStageSpec,
  type WorkflowDocument,
} from "../src/index.ts";
import { tempDir } from "./support.ts";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "workflows");

function workflowFile(workflowId: string): WorkflowDocument {
  return loadWorkflowDocument(path.join(fixtures, `${workflowId}.yaml`));
}

function stage(id: string, role: string, extra: Partial<RoleStageSpec> = {}): RoleStageSpec {
  return {
    kind: "role",
    description: null,
    id,
    role,
    artifact: null,
    decisionValues: [],
    dependsOn: [],
    resumeFrom: null,
    instructions: [],
    modelName: null,
    options: {},
    maxRevisions: null,
    verify: [],
    maxVerify: 3,
    verifyTimeoutSec: null,
    routes: {},
    ...extra,
    kind: "role",
    role,
  };
}

function gateWorkflow(): WorkflowDocument {
  return {
    id: "plan-implement",
    stages: {
      implement: stage("implement", "developer"),
      "review-work": stage("review-work", "reviewer", {
        dependsOn: ["implement"],
        routes: { approved: "write-tests", revise: "implement" },
      }),
      "write-tests": stage("write-tests", "developer", {
        dependsOn: ["implement", "review-work"],
        resumeFrom: "implement",
      }),
    },
    completion: null,
    requires: { workflow: "plan", decision: "approved" },
    constraints: [],
    source: null,
  };
}

function snapshot(
  stageId: string,
  order: number,
  extra: { decision?: string | null; status?: string; outcomeStatus?: string | null } = {},
): ExecutionSnapshot {
  return {
    executionId: `${String(order).padStart(4, "0")}-${stageId}`,
    stageId,
    executionOrder: order,
    status: extra.status ?? "completed",
    outcomeStatus: extra.outcomeStatus === undefined ? "complete" : extra.outcomeStatus,
    artifactDirectory: "/tmp",
    outcomeDecision: extra.decision === undefined ? null : extra.decision,
  };
}

function expectResult(actual: NextStageResult, expected: NextStageResult): void {
  expect(actual.constructor).toBe(expected.constructor);
  if (actual instanceof NextStage && expected instanceof NextStage) {
    expect(actual.stageId).toBe(expected.stageId);
    return;
  }
  if (actual instanceof Stop && expected instanceof Stop) {
    expect(actual.reason).toBe(expected.reason);
    return;
  }
  if (actual instanceof NextStageError && expected instanceof NextStageError) {
    expect(actual.message).toBe(expected.message);
  }
}

test("rejects a stage before its dependency", () => {
  const error = stageDispatchError(gateWorkflow(), "review-work", []);
  expect(error).not.toBeNull();
  expect(error).toContain("depends on implement");
});

test("rejects a route target after revise", () => {
  const error = stageDispatchError(gateWorkflow(), "write-tests", [
    snapshot("implement", 1),
    snapshot("review-work", 2, { decision: "revise" }),
  ]);
  expect(error).not.toBeNull();
  expect(error).toContain("not routed");
});

test("allows the stage selected by the latest route", () => {
  expect(
    stageDispatchError(gateWorkflow(), "write-tests", [
      snapshot("implement", 1),
      snapshot("review-work", 2, { decision: "approved" }),
    ]),
  ).toBeNull();
});

test("requires a completed matching prior session", () => {
  const workflow = gateWorkflow();
  const workspace = tempDir("migent-prior-");
  expect(() => resolvePriorSessionId(workspace, workflow, null)).toThrow(/pass --prior/);
  expect(() => resolvePriorSessionId(workspace, workflow, "missing")).toThrow(/Required session not found/);
  const sessionDirectory = path.join(workspace, ".migent", "sessions", "prior");
  mkdirSync(sessionDirectory, { recursive: true });
  const statusPath = path.join(sessionDirectory, "status.json");
  writeFileSync(
    statusPath,
    JSON.stringify({ workflow_id: "plan", status: "completed", latest_decision: "revise" }),
    "utf8",
  );
  expect(() => resolvePriorSessionId(workspace, workflow, "prior")).toThrow(/decision is 'revise'/);
  writeFileSync(
    statusPath,
    JSON.stringify({ workflow_id: "plan", status: "completed", latest_decision: "approved" }),
    "utf8",
  );
  expect(resolvePriorSessionId(workspace, workflow, "prior")).toBe("prior");
});

test("version 2 requires a completed prior session", () => {
  const workflow: WorkflowDocument = {
    ...gateWorkflow(),
    schemaVersion: 2,
    requires: { workflow: "plan", decision: null },
  };
  const workspace = tempDir("migent-prior-v2-");
  expect(() => resolvePriorSessionId(workspace, workflow, null)).toThrow(
    /Workflow plan-implement requires completed plan; pass --prior/,
  );
  const sessionDirectory = path.join(workspace, ".migent", "sessions", "prior");
  mkdirSync(sessionDirectory, { recursive: true });
  const statusPath = path.join(sessionDirectory, "status.json");
  writeFileSync(
    statusPath,
    JSON.stringify({ workflow_id: "plan", status: "active", latest_decision: "approved" }),
    "utf8",
  );
  expect(() => resolvePriorSessionId(workspace, workflow, "prior")).toThrow(/is active, not completed/);
  writeFileSync(
    statusPath,
    JSON.stringify({ workflow_id: "plan", status: "completed", latest_decision: "revise" }),
    "utf8",
  );
  expect(resolvePriorSessionId(workspace, workflow, "prior")).toBe("prior");
});

test("resume from selects the source stage session", () => {
  const workspace = tempDir("migent-resume-");
  const execution = path.join(
    workspace,
    ".migent",
    "sessions",
    "run-1",
    "executions",
    "0001-implement--attempt-01",
  );
  mkdirSync(execution, { recursive: true });
  writeFileSync(
    path.join(execution, "execution.json"),
    JSON.stringify({
      execution_id: "0001-implement--attempt-01",
      stage_id: "implement",
      execution_order: 1,
      status: "completed",
      outcome: { status: "complete" },
    }),
    "utf8",
  );
  expect(resolveResumeExecution(workspace, gateWorkflow(), "run-1", "write-tests")).toBe(
    "0001-implement--attempt-01",
  );
});

test("rejects a named workflow session as an agent session", () => {
  const workspace = tempDir("migent-agent-");
  const sessionDirectory = path.join(workspace, ".migent", "sessions", "wf");
  mkdirSync(sessionDirectory, { recursive: true });
  writeFileSync(path.join(sessionDirectory, "status.json"), JSON.stringify({ workflow_id: "plan" }), "utf8");
  expect(() => requireAgentSession(workspace, "wf")).toThrow(/was not created by agent/);
});

test("plan review walk", () => {
  const workflow = workflowFile("plan");
  const cases: Array<[ExecutionSnapshot[], string, NextStageResult]> = [
    [[], "active", new NextStage("plan")],
    [[snapshot("plan", 1)], "active", new NextStage("review-plan")],
    [
      [snapshot("plan", 1), snapshot("review-plan", 2, { decision: "revise" })],
      "active",
      new NextStage("plan"),
    ],
    [
      [
        snapshot("plan", 1),
        snapshot("review-plan", 2, { decision: "revise" }),
        snapshot("plan", 3),
      ],
      "active",
      new NextStage("review-plan"),
    ],
    [
      [snapshot("plan", 1), snapshot("review-plan", 2, { decision: "approved" })],
      "active",
      new Stop("completed"),
    ],
    [
      [snapshot("plan", 1), snapshot("review-plan", 2, { decision: "approved" })],
      "completed",
      new Stop("completed"),
    ],
  ];
  for (const [snapshots, sessionStatus, expected] of cases) {
    expectResult(nextStage(workflow, snapshots, sessionStatus), expected);
  }
});

test("plan implement walk", () => {
  const workflow = workflowFile("plan-implement");
  const afterImplement = [snapshot("implement", 1)];
  const afterRevise = [snapshot("implement", 1), snapshot("review-work", 2, { decision: "revise" })];
  const afterApproved = [
    snapshot("implement", 1),
    snapshot("review-work", 2, { decision: "approved" }),
  ];
  const afterTests = [...afterApproved, snapshot("write-tests", 3)];
  const cases: Array<[ExecutionSnapshot[], string, NextStageResult]> = [
    [[], "active", new NextStage("implement")],
    [afterImplement, "active", new NextStage("review-work")],
    [afterRevise, "active", new NextStage("implement")],
    [[...afterRevise, snapshot("implement", 3)], "active", new NextStage("review-work")],
    [afterApproved, "active", new NextStage("write-tests")],
    [afterTests, "active", new NextStage("review-tests")],
    [
      [...afterTests, snapshot("review-tests", 4, { decision: "revise" })],
      "active",
      new NextStage("write-tests"),
    ],
    [
      [...afterTests, snapshot("review-tests", 4, { decision: "approved" })],
      "completed",
      new Stop("completed"),
    ],
  ];
  for (const [snapshots, sessionStatus, expected] of cases) {
    expectResult(nextStage(workflow, snapshots, sessionStatus), expected);
  }
});

test("failed latest retries that stage", () => {
  expectResult(
    nextStage(
      workflowFile("plan"),
      [snapshot("plan", 1), snapshot("review-plan", 2, { status: "failed", outcomeStatus: null })],
      "active",
    ),
    new NextStage("review-plan"),
  );
});

test("terminal session status wins over a failed snapshot", () => {
  const failed = [snapshot("implement", 1, { status: "failed", outcomeStatus: null })];
  const workflow = workflowFile("plan-implement");
  expectResult(nextStage(workflow, failed, "blocked"), new Stop("blocked"));
  expectResult(nextStage(workflow, failed, "cancelled"), new Stop("cancelled"));
});

test("running execution is an error", () => {
  expectResult(
    nextStage(
      workflowFile("plan"),
      [snapshot("plan", 1, { status: "running", outcomeStatus: null })],
      "active",
    ),
    new NextStageError("an execution is still running"),
  );
});

test("revision stop counts successful returns per stage", () => {
  const workflow: WorkflowDocument = {
    id: "loop",
    stages: {
      plan: stage("plan", "planner", { maxRevisions: 1 }),
      review: stage("review", "reviewer", {
        dependsOn: ["plan"],
        routes: { approved: "complete", revise: "plan" },
      }),
      "write-tests": stage("write-tests", "developer", { maxRevisions: 0 }),
    },
    completion: null,
    requires: null,
    constraints: [],
    source: null,
  };
  const firstReturn = [snapshot("plan", 1), snapshot("review", 2, { decision: "revise" })];
  expect(revisionStop(workflow, firstReturn, "plan")).toBe(false);
  expect(revisionStop(workflow, firstReturn, "plan", { plan: 0 })).toBe(false);
  expect(revisionStop(workflow, firstReturn, "review")).toBe(false);
  const spent = [...firstReturn, snapshot("plan", 3), snapshot("review", 4, { decision: "revise" })];
  expect(revisionStop(workflow, spent, "plan")).toBe(true);
  expect(revisionStop(workflow, spent, "plan", { plan: 2 })).toBe(false);
  const retry = [...firstReturn, snapshot("plan", 3, { status: "failed", outcomeStatus: null })];
  expect(revisionStop(workflow, retry, "plan")).toBe(false);
  expect(revisionStop(workflow, [snapshot("write-tests", 1)], "write-tests")).toBe(true);
  expect(revisionStop(workflow, [], "write-tests")).toBe(false);
});

test("two roots are ambiguous", () => {
  const workflow: WorkflowDocument = {
    id: "two",
    stages: {
      a: stage("a", "developer"),
      b: stage("b", "developer"),
    },
    completion: null,
    requires: null,
    constraints: [],
    source: null,
  };
  const result = nextStage(workflow, [], "active");
  expect(result).toBeInstanceOf(NextStageError);
  if (result instanceof NextStageError) expect(result.message).toContain("ambiguous next stage");
});
