import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  missingCompletionOutputNames,
  nonemptyArtifact,
  parseStageOutcome,
  publishOutputFiles,
  shouldPublishOutputs,
  StageOutcome,
  type RoleStageSpec,
  type WorkflowDocument,
} from "../src/index.ts";
import { tempDir } from "./support.ts";

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

function planReview(): WorkflowDocument {
  return {
    id: "plan",
    stages: {
      plan: stage("plan", "planner", { artifact: "plan.md" }),
      "review-plan": stage("review-plan", "reviewer", {
        decisionValues: ["approved", "revise"],
      }),
    },
    completion: {
      stage: "review-plan",
      decision: "approved",
      outputs: [{ name: "plan", fromStage: "plan", artifact: "plan.md" }],
    },
    requires: null,
    constraints: [],
    source: null,
  };
}

test("publish gate requires the completion decision", () => {
  const workflow = planReview();
  const approved = new StageOutcome("complete", null, "approved");
  expect(
    shouldPublishOutputs({
      workflowId: "plan",
      executionStatus: "completed",
      outcome: approved,
      workflow,
      stageId: "review-plan",
    }),
  ).toBe(true);
  expect(
    shouldPublishOutputs({
      workflowId: "plan",
      executionStatus: "completed",
      outcome: new StageOutcome("complete", null, "revise"),
      workflow,
      stageId: "review-plan",
    }),
  ).toBe(false);
  expect(
    shouldPublishOutputs({
      workflowId: "agent",
      executionStatus: "completed",
      outcome: approved,
      workflow,
      stageId: "review-plan",
    }),
  ).toBe(false);
});

test("approve publishes the reviewed plan artifact", () => {
  const workspace = tempDir("migent-outputs-");
  const source = path.join(workspace, "artifacts", "plan.md");
  mkdirSync(path.dirname(source), { recursive: true });
  writeFileSync(source, "# Plan v1\n", "utf8");
  const sessionDirectory = path.join(workspace, "session");
  const recorded = publishOutputFiles(
    sessionDirectory,
    { plan: [source, "0001-plan"] },
    "0002-review",
  );
  expect(readFileSync(path.join(sessionDirectory, "outputs", "plan"), "utf8")).toBe("# Plan v1\n");
  expect(recorded.plan).toEqual({
    path: "outputs/plan",
    sourceExecutionId: "0001-plan",
    publishedByExecutionId: "0002-review",
  });
});

test("missing or empty artifact fails the producing stage", () => {
  for (const body of [null, "   \n"] as const) {
    const workspace = tempDir("migent-outputs-");
    const sourceDirectory = path.join(workspace, "artifacts");
    mkdirSync(sourceDirectory, { recursive: true });
    const source = path.join(sourceDirectory, "plan.md");
    if (body !== null) writeFileSync(source, body, "utf8");
    const sessionDirectory = path.join(workspace, "session");
    const recorded = publishOutputFiles(
      sessionDirectory,
      { plan: [source, "0001-plan"] },
      "0002-review",
    );
    expect(nonemptyArtifact(source)).toBe(false);
    expect(recorded).toEqual({});
    expect(existsSync(path.join(sessionDirectory, "outputs"))).toBe(false);
  }
});

test("prose approval without a decision header fails", () => {
  expect(() =>
    parseStageOutcome("status: complete\n\nApproved.", true, ["approved", "revise"]),
  ).toThrow(/decision:/);
});

test("missing completion outputs only consider earlier executions", () => {
  const workspace = tempDir("migent-outputs-");
  const earlier = path.join(workspace, "earlier");
  const current = path.join(workspace, "current");
  mkdirSync(earlier, { recursive: true });
  mkdirSync(current, { recursive: true });
  writeFileSync(path.join(current, "plan.md"), "# current\n", "utf8");
  const workflow = planReview();
  const snapshots = [
    {
      executionId: "0001-plan",
      stageId: "plan",
      executionOrder: 1,
      status: "completed",
      outcomeStatus: "complete",
      artifactDirectory: earlier,
      outcomeDecision: null,
    },
    {
      executionId: "0002-plan",
      stageId: "plan",
      executionOrder: 2,
      status: "completed",
      outcomeStatus: "complete",
      artifactDirectory: current,
      outcomeDecision: null,
    },
  ];
  expect(
    missingCompletionOutputNames({ workflow, snapshots, beforeOrder: 2 }),
  ).toEqual(["plan"]);
  writeFileSync(path.join(earlier, "plan.md"), "# Plan v1\n", "utf8");
  expect(missingCompletionOutputNames({ workflow, snapshots, beforeOrder: 2 })).toEqual([]);
});
