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
  readyStages,
  runnableNow,
  NextStage,
  NextStageError,
  revisionStop,
  stageDispatchError,
  Stop,
  type ExecutionSnapshot,
  type NextStageResult,
  type RoleStageSpec,
  type WorkflowDocument,
  type VerifyOnlyStageSpec,
} from "../src/index.ts";
import { schedulableStageIds, version2IdleReason } from "../src/selection.ts";

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

function snapshot(
  stageId: string,
  order: number,
  extra: {
    decision?: string | null;
    status?: string;
    outcomeStatus?: string | null;
    artifactDirectory?: string;
  } = {},
): ExecutionSnapshot {
  return {
    executionId: `${String(order).padStart(4, "0")}-${stageId}`,
    stageId,
    executionOrder: order,
    status: extra.status ?? "completed",
    outcomeStatus: extra.outcomeStatus === undefined ? "complete" : extra.outcomeStatus,
    artifactDirectory: extra.artifactDirectory ?? "/tmp",
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

test("failed latest stays stopped until continue marks that execution", () => {
  const failed = [snapshot("plan", 1), snapshot("review-plan", 2, { status: "failed", outcomeStatus: null })];
  const workflow = workflowFile("plan");
  expectResult(nextStage(workflow, failed, "active"), new Stop("stage_failed"));
  const executionId = failed[1]!.executionId;
  expectResult(
    nextStage(workflow, failed, "active", [
      { event: "session.active", executionId, data: { from: "failed" } },
    ]),
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

test("readyStages omits a running stage and keeps declaration order", () => {
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
  const running = [snapshot("a", 1, { status: "running", outcomeStatus: null })];
  expect(readyStages(workflow, running, "active")).toEqual(["b"]);
  expect(readyStages(workflow, [], "active")).toEqual(["a", "b"]);
  const blocked = [snapshot("a", 1, { status: "completed", outcomeStatus: "blocked" })];
  expect(readyStages(workflow, blocked, "active")).toEqual(["b"]);
  const executionId = blocked[0]!.executionId;
  const resumed = [{ event: "session.active", executionId, data: { from: "blocked" } }];
  expect(readyStages(workflow, blocked, "active", null, resumed)).toEqual(["a", "b"]);
  expect(readyStages(workflow, blocked, "blocked", null, resumed)).toEqual(["b"]);
  const failed = [snapshot("a", 1, { status: "failed", outcomeStatus: null })];
  expect(readyStages(workflow, failed, "active")).toEqual(["b"]);
  expect(
    readyStages(workflow, failed, "active", null, [
      { event: "session.active", executionId: failed[0]!.executionId, data: { from: "failed" } },
    ]),
  ).toEqual(["a", "b"]);
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

test("version 2 runs roots in declaration order", () => {
  const workflow: WorkflowDocument = {
    id: "two",
    schemaVersion: 2,
    stages: {
      a: stage("a", "developer"),
      b: stage("b", "developer"),
    },
    completion: null,
    requires: null,
    constraints: [],
    source: null,
  };
  expectResult(nextStage(workflow, [], "active"), new NextStage("a"));
  expectResult(nextStage(workflow, [snapshot("a", 1)], "active"), new NextStage("b"));
});

test("version 2 reruns a missing producer when the latest route is not dispatchable", () => {
  const workflow: WorkflowDocument = {
    id: "plan",
    schemaVersion: 2,
    stages: {
      draft: stage("draft", "planner", { artifact: "plan.md" }),
      review: stage("review", "reviewer", {
        dependsOn: ["draft"],
        decisionValues: ["approved"],
        routes: { approved: "missing" },
      }),
    },
    completion: null,
    requires: null,
    constraints: [],
    source: null,
    outputs: [{ name: "plan", fromStage: "draft", artifact: "plan.md" }],
  };
  const snapshots = [
    snapshot("draft", 1, { artifactDirectory: "/no/such/migent-output" }),
    snapshot("review", 2, { decision: "approved", artifactDirectory: "/no/such/migent-output" }),
  ];
  expectResult(nextStage(workflow, snapshots, "active"), new NextStage("draft"));
});

test("version 2 keeps a bad route when no output is missing", () => {
  const workflow: WorkflowDocument = {
    id: "plan",
    schemaVersion: 2,
    stages: {
      draft: stage("draft", "planner"),
      review: stage("review", "reviewer", {
        dependsOn: ["draft"],
        decisionValues: ["approved"],
        routes: { approved: "missing" },
      }),
      tail: stage("tail", "developer"),
    },
    completion: null,
    requires: null,
    constraints: [],
    source: null,
    outputs: [{ name: "plan", fromStage: "draft", artifact: "plan.md" }],
  };
  const ran = [
    snapshot("draft", 1, { artifactDirectory: "/no/such/migent-output" }),
    snapshot("review", 2, { decision: "approved", artifactDirectory: "/no/such/migent-output" }),
  ];
  const settled = {
    ...workflow,
    stages: { draft: workflow.stages.draft!, review: workflow.stages.review! },
    outputs: [] as WorkflowDocument["outputs"],
  };
  expectResult(nextStage(settled, ran, "active"), new NextStageError("Stage is not declared: missing."));
  expectResult(nextStage(workflow, ran, "active"), new NextStageError("Stage is not declared: missing."));
});

test("version 2 route to complete leaves another root ready", () => {
  const workflow: WorkflowDocument = {
    id: "two",
    schemaVersion: 2,
    stages: {
      a: stage("a", "developer", { decisionValues: ["done"], routes: { done: "complete" } }),
      b: stage("b", "developer"),
    },
    completion: null,
    requires: null,
    constraints: [],
    source: null,
  };
  expectResult(nextStage(workflow, [snapshot("a", 1, { decision: "done" })], "active"), new NextStage("b"));
});

test("version 2 requires every router that finished since the stage", () => {
  const workflow: WorkflowDocument = {
    id: "fan",
    schemaVersion: 2,
    stages: {
      left: stage("left", "reviewer", {
        decisionValues: ["yes", "no"],
        routes: { yes: "join", no: "left" },
      }),
      right: stage("right", "reviewer", {
        decisionValues: ["yes", "no"],
        routes: { yes: "join", no: "right" },
      }),
      join: stage("join", "developer"),
    },
    completion: null,
    requires: null,
    constraints: [],
    source: null,
  };
  expect(stageDispatchError(workflow, "join", [snapshot("left", 1, { decision: "yes" })])).toBeNull();
  expect(
    stageDispatchError(workflow, "join", [
      snapshot("left", 1, { decision: "no" }),
      snapshot("right", 2, { decision: "yes" }),
    ]),
  ).toContain("not routed by left");
  expect(
    stageDispatchError(workflow, "join", [
      snapshot("left", 1, { decision: "yes" }),
      snapshot("right", 2, { decision: "yes" }),
    ]),
  ).toBeNull();
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

function bareWorkflow(stages: Record<string, RoleStageSpec>, schemaVersion = 2): WorkflowDocument {
  return {
    id: "sched",
    schemaVersion,
    stages,
    completion: null,
    requires: null,
    constraints: [],
    source: null,
  };
}

test("runnableNow suspends a downstream stage while its upstream is ready", () => {
  const workflow = bareWorkflow({
    a: stage("a", "developer"),
    b: stage("b", "developer", { dependsOn: ["a"] }),
  });
  expect(runnableNow(workflow, ["b", "a"], [], 2)).toEqual(["a"]);
});

test("runnableNow runs a resume_from stage only alone", () => {
  const followFirst = bareWorkflow({
    follow: stage("follow", "developer", { dependsOn: ["draft"], resumeFrom: "draft" }),
    other: stage("other", "developer"),
    draft: stage("draft", "developer"),
  });
  expect(runnableNow(followFirst, ["follow", "other"], [], 2)).toEqual(["follow"]);
  expect(runnableNow(followFirst, ["follow"], ["other"], 2)).toEqual([]);
  const otherFirst = bareWorkflow({
    other: stage("other", "developer"),
    follow: stage("follow", "developer", { dependsOn: ["draft"], resumeFrom: "draft" }),
    draft: stage("draft", "developer"),
  });
  expect(runnableNow(otherFirst, ["follow", "other"], [], 2)).toEqual(["other"]);
  const revisited = bareWorkflow({
    follow: stage("follow", "developer", { dependsOn: ["draft"], resumeFrom: "draft" }),
    review: stage("review", "reviewer", { decisionValues: ["revise"], routes: { revise: "follow" } }),
    other: stage("other", "developer"),
    draft: stage("draft", "developer"),
  });
  const routedBack = [snapshot("follow", 1), snapshot("review", 2, { decision: "revise" })];
  expect(runnableNow(revisited, ["follow", "other"], [], 2, routedBack)).toEqual(["follow", "other"]);
});

test("runnableNow does not start a stage twice", () => {
  const workflow = bareWorkflow({
    a: stage("a", "developer"),
    b: stage("b", "developer"),
  });
  expect(runnableNow(workflow, ["a", "a", "b"], [], 2)).toEqual(["a", "b"]);
  expect(runnableNow(workflow, ["b", "a"], ["a"], 2)).toEqual(["b"]);
  expect(runnableNow(workflow, ["a", "b"], ["a"], 1)).toEqual([]);
});

test("stageDispatchError rejects a stage when one of two routers decides fail", () => {
  const workflow = bareWorkflow({
    left: stage("left", "reviewer", { decisionValues: ["ok", "fail"], routes: { ok: "join", fail: "left" } }),
    right: stage("right", "reviewer", { decisionValues: ["ok", "fail"], routes: { ok: "join", fail: "right" } }),
    join: stage("join", "developer"),
  });
  const error = stageDispatchError(workflow, "join", [
    snapshot("left", 1, { decision: "fail" }),
    snapshot("right", 2, { decision: "ok" }),
  ]);
  expect(error).toContain("not routed by left");
  expect(error).toContain("'fail'");
});

test("verify_failed keeps dependents stopped and is schedulable once", () => {
  const prepare: VerifyOnlyStageSpec = {
    kind: "verify",
    id: "prepare",
    role: null,
    description: null,
    artifact: null,
    decisionValues: [],
    dependsOn: [],
    resumeFrom: null,
    instructions: [],
    modelName: null,
    options: {},
    maxRevisions: null,
    routes: {},
    verify: ["pnpm test"],
    maxVerify: 0,
    verifyTimeoutSec: null,
  };
  const workflow = bareWorkflow({
    implement: stage("implement", "developer", { dependsOn: ["prepare"] }),
  });
  workflow.stages.prepare = prepare;
  const failed = {
    ...snapshot("prepare", 1, { status: "failed", outcomeStatus: null }),
    failureReason: "verify_failed",
  };
  expect(readyStages(workflow, [failed], "active")).toEqual([]);
  expect(schedulableStageIds(workflow, [failed], "active", null, null, new Set())).toEqual(["prepare"]);
  expect(schedulableStageIds(workflow, [failed], "active", null, null, new Set(), new Set(["prepare"]))).toEqual([]);
  expect(version2IdleReason(workflow, [failed], "active")).toBe("verify_failed");
  expect(failedStageCount([failed], "prepare")).toBe(0);
  expect(failedStageCount([failed], "implement")).toBe(0);
});

test("failedStageCount ignores verify_exhausted executions", () => {
  const exhausted = { ...snapshot("a", 3, { status: "failed", outcomeStatus: null }), failureReason: "verify_exhausted" };
  const plain = snapshot("a", 2, { status: "failed", outcomeStatus: null });
  expect(failedStageCount([exhausted, plain], "a")).toBe(1);
  expect(verifyExhaustedExecution([plain, exhausted], "a")).toBe(exhausted);
  expect(verifyExhaustedExecution([exhausted, snapshot("a", 4, { status: "failed", outcomeStatus: null })], "a")).toBeNull();
});
