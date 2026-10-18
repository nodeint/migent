import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  buildStagePrompt,
  loadWorkflowDocument,
  type ExecutionSnapshot,
  type StageSpec,
  type WorkflowDocument,
} from "../src/index.ts";
import { tempDir } from "./support.ts";

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
  directory: string,
  extra: {
    status?: string;
    outcomeStatus?: string | null;
    decision?: string | null;
  } = {},
): ExecutionSnapshot {
  return {
    executionId: `${String(order).padStart(4, "0")}-${stageId}`,
    stageId,
    executionOrder: order,
    status: extra.status ?? "completed",
    outcomeStatus: extra.outcomeStatus === undefined ? "complete" : extra.outcomeStatus,
    artifactDirectory: directory,
    outcomeDecision: extra.decision === undefined ? null : extra.decision,
  };
}

/** pathlib.Path.resolve: realpath of the longest existing prefix. */
function resolved(target: string): string {
  const absolute = path.resolve(target);
  let cursor = absolute;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cursor);
      return suffix.length === 0 ? real : path.join(real, ...suffix);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return absolute;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

test("populated prompt matches the template snapshot", () => {
  const workspace = tempDir("migent-prompt-");
  const upstream = path.join(workspace, "upstream");
  mkdirSync(upstream);
  const workflow: WorkflowDocument = {
    id: "sample",
    stages: {
      plan: stage("plan", "planner", { artifact: "plan.md" }),
      implement: stage("implement", "developer", {
        dependsOn: ["plan"],
        instructions: ["Implement production code only.", "Do not add or modify test code."],
        artifact: "implementation-result.md",
      }),
    },
    completion: null,
    requires: null,
    constraints: [
      "Do not write implementation code.",
      "Do not infer decisions from review prose.",
    ],
    source: null,
  };
  const prompt = buildStagePrompt({
    workflow,
    stageId: "implement",
    task: "Do work",
    snapshots: [snapshot("plan", 1, upstream)],
    workspace,
    priorSessionId: "prior-1",
    priorOutputs: { plan: { path: "outputs/plan" } },
  });
  const planPath = resolved(path.join(upstream, "plan.md"));
  const priorPath = resolved(
    path.join(workspace, ".migent", "sessions", "prior-1", "outputs", "plan"),
  );
  expect(prompt).toBe(
    [
      "Task: Do work",
      "Stage: implement (role: developer)",
      "Instructions:\n- Implement production code only.\n- Do not add or modify test code.",
      "Constraints:\n- Do not write implementation code.\n- Do not infer decisions from review prose.",
      `Upstream artifacts on this session:\n- plan: ${planPath}`,
      `Required prior workflow result:\n- session: prior-1\n- outputs: ${priorPath}`,
      "Write the file artifact as `implementation-result.md` in the execution artifacts directory.",
    ].join("\n\n"),
  );
});

test("plan includes artifact sentence and constraints", () => {
  const prompt = buildStagePrompt({
    workflow: workflowFile("plan"),
    stageId: "plan",
    task: "Write a plan",
    snapshots: [],
    workspace: "/tmp",
  });
  expect(prompt).toContain("Write the file artifact as `plan.md`");
  expect(prompt).toContain("Do not write implementation code.");
  expect(prompt).not.toContain("Upstream artifacts");
});

test("review omits artifact sentence", () => {
  const root = tempDir("migent-prompt-");
  const planDir = path.join(root, "plan-v1");
  mkdirSync(planDir);
  const prompt = buildStagePrompt({
    workflow: workflowFile("plan"),
    stageId: "review-plan",
    task: "Write a plan",
    snapshots: [snapshot("plan", 1, planDir)],
    workspace: root,
  });
  expect(prompt).not.toContain("Write the file artifact");
  expect(prompt).toContain("Upstream artifacts on this session:");
  expect(prompt).toContain(resolved(path.join(planDir, "plan.md")));
});

test("review uses the latest plan attempt after revise", () => {
  const root = tempDir("migent-prompt-");
  const first = path.join(root, "plan-v1");
  const second = path.join(root, "plan-v2");
  mkdirSync(first);
  mkdirSync(second);
  const prompt = buildStagePrompt({
    workflow: workflowFile("plan"),
    stageId: "review-plan",
    task: "Write a plan",
    snapshots: [
      snapshot("plan", 1, first),
      snapshot("review-plan", 2, root, { decision: "revise" }),
      snapshot("plan", 3, second),
    ],
    workspace: root,
  });
  expect(prompt).toContain(resolved(path.join(second, "plan.md")));
  expect(prompt).not.toContain(resolved(path.join(first, "plan.md")));
});

test("write tests uses latest successful implement artifact", () => {
  const root = tempDir("migent-prompt-");
  const failed = path.join(root, "implement-failed");
  const ok = path.join(root, "implement-ok");
  const review = path.join(root, "review-work");
  mkdirSync(failed);
  mkdirSync(ok);
  mkdirSync(review);
  writeFileSync(path.join(review, "response.md"), "status: complete\ndecision: approved\n", "utf8");
  const prompt = buildStagePrompt({
    workflow: workflowFile("plan-implement"),
    stageId: "write-tests",
    task: "Do work",
    snapshots: [
      snapshot("implement", 1, failed, { status: "failed", outcomeStatus: null }),
      snapshot("implement", 2, ok),
      snapshot("review-work", 3, path.join(review, "artifacts"), { decision: "approved" }),
    ],
    workspace: root,
  });
  expect(prompt).toContain(resolved(path.join(ok, "implementation-result.md")));
  expect(prompt).not.toContain(resolved(path.join(failed, "implementation-result.md")));
  expect(prompt).toContain("Write the file artifact as `test-result.md`");
  expect(prompt).toContain(resolved(path.join(review, "response.md")));
});

test("revision references latest review and previous artifact", () => {
  const workspace = tempDir("migent-prompt-");
  const plan = path.join(workspace, "plan-1", "artifacts");
  const review = path.join(workspace, "review-1");
  mkdirSync(plan, { recursive: true });
  mkdirSync(review);
  writeFileSync(path.join(plan, "plan.md"), "initial plan", "utf8");
  writeFileSync(
    path.join(review, "response.md"),
    "status: complete\ndecision: revise\n\nFix the plan.",
    "utf8",
  );
  const prompt = buildStagePrompt({
    workflow: workflowFile("plan"),
    stageId: "plan",
    task: "Write a plan",
    snapshots: [
      snapshot("plan", 1, plan),
      snapshot("review-plan", 2, path.join(review, "artifacts"), { decision: "revise" }),
    ],
    workspace,
  });
  expect(prompt).toContain(resolved(path.join(review, "response.md")));
  expect(prompt).toContain(resolved(path.join(plan, "plan.md")));
  expect(prompt).toContain("Read this response and use its decision and feedback");
});

test("revision retry keeps the review that requested it", () => {
  const workspace = tempDir("migent-prompt-");
  const oldReview = path.join(workspace, "review-1");
  const newReview = path.join(workspace, "review-2");
  mkdirSync(oldReview);
  mkdirSync(newReview);
  writeFileSync(path.join(oldReview, "response.md"), "old", "utf8");
  writeFileSync(path.join(newReview, "response.md"), "new", "utf8");
  const prompt = buildStagePrompt({
    workflow: workflowFile("plan"),
    stageId: "plan",
    task: "Write a plan",
    snapshots: [
      snapshot("plan", 1, path.join(workspace, "plan-1")),
      snapshot("review-plan", 2, path.join(oldReview, "artifacts"), { decision: "revise" }),
      snapshot("plan", 3, path.join(workspace, "plan-2")),
      snapshot("review-plan", 4, path.join(newReview, "artifacts"), { decision: "revise" }),
      snapshot("plan", 5, path.join(workspace, "failed-plan"), {
        status: "failed",
        outcomeStatus: null,
      }),
    ],
    workspace,
  });
  expect(prompt).toContain(resolved(path.join(newReview, "response.md")));
  expect(prompt).not.toContain(resolved(path.join(oldReview, "response.md")));
});

test("routed stage requires its decision response", () => {
  const workspace = tempDir("migent-prompt-");
  expect(() =>
    buildStagePrompt({
      workflow: workflowFile("plan"),
      stageId: "plan",
      task: "Write a plan",
      snapshots: [
        snapshot("plan", 1, path.join(workspace, "plan-1")),
        snapshot("review-plan", 2, path.join(workspace, "review", "artifacts"), {
          decision: "revise",
        }),
      ],
      workspace,
    }),
  ).toThrow(/Routed stage response is missing/);
});

test("includes prior session published outputs", () => {
  const workspace = tempDir("migent-prompt-");
  const prompt = buildStagePrompt({
    workflow: workflowFile("plan-implement"),
    stageId: "implement",
    task: "Do work",
    snapshots: [],
    workspace,
    priorSessionId: "prior-1",
    priorOutputs: { plan: { path: "outputs/plan" } },
  });
  expect(prompt).toContain("- session: prior-1");
  const expected = path.join(workspace, ".migent", "sessions", "prior-1", "outputs", "plan");
  expect(prompt).toContain(resolved(expected));
});

test("rejects an undeclared stage", () => {
  expect(() =>
    buildStagePrompt({
      workflow: workflowFile("plan"),
      stageId: "missing",
      task: "Write a plan",
      snapshots: [],
      workspace: "/tmp",
    }),
  ).toThrow(/Stage is not declared: missing/);
});
