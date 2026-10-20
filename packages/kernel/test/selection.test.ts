import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  failedStageCount,
  revisionResumeExecution,
  stageAgentExecution,
  stagePromptAlreadyDelivered,
  verifyExhaustedExecution,
  loadWorkflowDocument,
  nextStage,
  NextStage,
  NextStageError,
  revisionStop,
  stageDispatchError,
  Stop,
  type ExecutionSnapshot,
  type NextStageResult,
  type StageSpec,
  type WorkflowDocument,
} from "../src/index.ts";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "workflows");

function workflowFile(workflowId: string): WorkflowDocument {
  return loadWorkflowDocument(path.join(fixtures, `${workflowId}.yaml`));
}

function stage(id: string, role: string, extra: Partial<StageSpec> = {}): StageSpec {
  return {
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

test("plan review walk", () => {
  const workflow = workflowFile("plan");
  const cases: Array<[string, ExecutionSnapshot[], string, NextStageResult]> = [
    ["empty", [], "active", new NextStage("plan")],
    ["after plan", [snapshot("plan", 1)], "active", new NextStage("review-plan")],
    [
      "revise",
      [snapshot("plan", 1), snapshot("review-plan", 2, { decision: "revise" })],
      "active",
      new NextStage("plan"),
    ],
    [
      "after plan v2",
      [
        snapshot("plan", 1),
        snapshot("review-plan", 2, { decision: "revise" }),
        snapshot("plan", 3),
      ],
      "active",
      new NextStage("review-plan"),
    ],
    [
      "approved while active",
      [snapshot("plan", 1), snapshot("review-plan", 2, { decision: "approved" })],
      "active",
      new Stop("completed"),
    ],
    [
      "completed session",
      [snapshot("plan", 1), snapshot("review-plan", 2, { decision: "approved" })],
      "completed",
      new Stop("completed"),
    ],
  ];
  for (const [, snapshots, sessionStatus, expected] of cases) {
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
  const spent = [
    ...firstReturn,
    snapshot("plan", 3),
    snapshot("review", 4, { decision: "revise" }),
  ];
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
  expect(result).toMatchObject({ message: "ambiguous next stage: a, b" });
});

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

test("rejects a stage before its dependency", () => {
  expect(stageDispatchError(gateWorkflow(), "review-work", [])).toContain("depends on implement");
});

test("rejects a route target after revise", () => {
  const error = stageDispatchError(gateWorkflow(), "write-tests", [
    snapshot("implement", 1),
    snapshot("review-work", 2, { decision: "revise" }),
  ]);
  expect(error).toContain("not routed");
  expect(error).toBe("Stage write-tests is not routed by review-work decision 'revise'.");
});

test("allows the stage selected by the latest route", () => {
  expect(
    stageDispatchError(gateWorkflow(), "write-tests", [
      snapshot("implement", 1),
      snapshot("review-work", 2, { decision: "approved" }),
    ]),
  ).toBeNull();
});

test("revise resumes the previous visit of the routed stage", () => {
  const workflow = workflowFile("plan");
  const first = [snapshot("plan", 1), snapshot("review-plan", 2, { decision: "revise" })];
  expect(revisionResumeExecution(workflow, first, "plan")).toBe("0001-plan");
  expect(revisionResumeExecution(workflow, first, "review-plan")).toBeNull();
  const revised = [...first, snapshot("plan", 3)];
  expect(revisionResumeExecution(workflow, revised, "plan")).toBeNull();
  expect(revisionResumeExecution(workflow, revised, "review-plan")).toBeNull();
  const secondRevise = [...revised, snapshot("review-plan", 4, { decision: "revise" })];
  expect(revisionResumeExecution(workflow, secondRevise, "plan")).toBe("0003-plan");
  const failedRetry = [
    ...first,
    snapshot("plan", 3, { status: "failed", outcomeStatus: null }),
  ];
  expect(revisionResumeExecution(workflow, failedRetry, "plan")).toBe("0003-plan");
  expect(revisionResumeExecution(workflow, [snapshot("plan", 1, { status: "failed", outcomeStatus: null })], "plan")).toBeNull();
});

test("resume_from keeps the full prompt until a route returns", () => {
  const workflow: WorkflowDocument = {
    id: "resume",
    stages: {
      draft: stage("draft", "developer"),
      review: stage("review", "reviewer", {
        dependsOn: ["draft"],
        resumeFrom: "draft",
        routes: { revise: "draft", approved: "recheck" },
      }),
      recheck: stage("recheck", "reviewer", {
        dependsOn: ["review"],
        routes: { again: "review" },
      }),
    },
    completion: null,
    requires: null,
    constraints: [],
    source: null,
  };
  const opened = [snapshot("draft", 1), snapshot("review", 2, { decision: "revise" })];
  expect(stagePromptAlreadyDelivered(workflow, opened, "review")).toBe(false);
  expect(stagePromptAlreadyDelivered(workflow, opened, "draft")).toBe(true);
  const returned = [
    snapshot("draft", 1),
    snapshot("review", 2, { decision: "approved" }),
    snapshot("recheck", 3, { decision: "again" }),
  ];
  expect(stagePromptAlreadyDelivered(workflow, returned, "review")).toBe(true);
  expect(stagePromptAlreadyDelivered(workflow, [], "draft")).toBe(false);
});

test("a stage that routes to itself resumes its own agent", () => {
  const workflow: WorkflowDocument = {
    id: "self",
    stages: {
      plan: stage("plan", "planner", { routes: { revise: "plan" } }),
    },
    completion: null,
    requires: null,
    constraints: [],
    source: null,
  };
  const first = [snapshot("plan", 1, { decision: "revise" })];
  expect(revisionResumeExecution(workflow, first, "plan")).toBe("0001-plan");
  const retried = [...first, snapshot("plan", 2)];
  expect(revisionResumeExecution(workflow, retried, "plan")).toBeNull();
});

test("a stage keeps the agent from its latest execution", () => {
  const failed = [snapshot("plan", 1, { status: "failed", outcomeStatus: null })];
  expect(stageAgentExecution(failed, "plan")).toBe("0001-plan");
  const reviewed = [
    snapshot("plan", 1),
    snapshot("review-plan", 2, { decision: "revise" }),
    snapshot("plan", 3),
    snapshot("review-plan", 4, { decision: "revise" }),
  ];
  expect(stageAgentExecution(reviewed, "plan")).toBe("0003-plan");
  expect(stageAgentExecution(reviewed, "review-plan")).toBe("0004-review-plan");
  expect(stageAgentExecution(reviewed, "absent")).toBeNull();
});

test("failedStageCount ignores verify_exhausted executions", () => {
  const exhausted = { ...snapshot("a", 3, { status: "failed", outcomeStatus: null }), failureReason: "verify_exhausted" };
  const plain = snapshot("a", 2, { status: "failed", outcomeStatus: null });
  expect(failedStageCount([exhausted, plain], "a")).toBe(1);
  expect(verifyExhaustedExecution([plain, exhausted], "a")).toBe(exhausted);
  expect(verifyExhaustedExecution([exhausted, snapshot("a", 4, { status: "failed", outcomeStatus: null })], "a")).toBeNull();
});
