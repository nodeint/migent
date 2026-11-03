import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { ExecutionSnapshot } from "../src/outputs.ts";
import { buildStagePrompt, buildStageReplyPrompt, buildStageResumePrompt, buildVerifyRepairPrompt } from "../src/prompt.ts";
import { flattenHistory, renderProviderPrompt } from "../src/runtime.ts";
import { parseWorkflowMapping } from "../src/workflow.ts";

// Neutral fixture: no role or stage instructions, so every prompt line below comes from the engine.
const workflow = parseWorkflowMapping({
  schema_version: 3,
  id: "neutral",
  stages: [
    { id: "make", role: "worker", depends_on: [], max_revisions: 2, ask: "human", verify: ["check-one", "check-two"], produces: { artifact: "make.md" } },
    {
      id: "check", role: "checker", depends_on: ["make"],
      decision: [{ approved: { when: "A.", navigate: "complete" } }, { revise: { when: "B.", navigate: "make" } }],
    },
    { id: "again", role: "worker", depends_on: ["make"], session: { resume_from: "make" }, produces: { artifact: "again.md" } },
  ],
}, "neutral.yaml");

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "migent-baseline-"))); // macOS tmp is a symlink; prompts print resolved paths
  const session = path.join(root, ".migent", "sessions", "s1");
  const execution = (name: string, artifacts: boolean) => {
    const dir = path.join(session, "executions", name);
    mkdirSync(path.join(dir, "artifacts"), { recursive: true });
    writeFileSync(path.join(dir, "response.md"), "status: complete\n");
    if (artifacts) writeFileSync(path.join(dir, "artifacts", "make.md"), "x");
    return path.join(dir, "artifacts");
  };
  const snap = (executionId: string, stageId: string, order: number, artifactDirectory: string, outcomeStatus: string, decision: string | null = null): ExecutionSnapshot =>
    ({ executionId, stageId, executionOrder: order, status: "completed", outcomeStatus, outcomeDecision: decision, artifactDirectory });
  const snapshots = [
    snap("e1", "make", 1, execution("e1", true), "complete"),
    snap("e2", "check", 2, execution("e2", false), "complete", "revise"),
  ];
  return { root, session, snapshots };
}

const normalize = (text: string, root: string) =>
  text.split(root).join("<ROOT>").split(root.replaceAll("\\", "/")).join("<ROOT>").replaceAll("\\", "/");

function turn(prompt: string, stageId: string) {
  const stage = workflow.stages[stageId]!;
  return renderProviderPrompt(prompt, {
    contract: true, decisionValues: stage.decisionValues, decisionInstructions: stage.decisionInstructions,
    ask: stage.ask ?? null, questionFile: "<QFILE>", artifactDirectory: "<ART>", artifactName: stage.artifact ?? null,
  });
}

test("prompt kinds under native resume, history replay and resume_from", () => {
  const { root, session, snapshots } = fixture();
  const base = { workflow, workspace: root, sessionDirectory: session, taskFile: path.join(session, "task.md"), roleInstructions: [] as string[] };
  const kinds: Record<string, string> = {};
  const record = (name: string, stageId: string, body: string) => {
    kinds[`${name} / native`] = turn(body, stageId);
    kinds[`${name} / replay`] = flattenHistory([
      { role: "user", content: "(earlier turn)" }, { role: "assistant", content: "(earlier response)" },
      { role: "user", content: turn(body, stageId) },
    ]);
  };
  record("first turn", "make", buildStagePrompt({ ...base, stageId: "make", snapshots: [] }));
  record("re-entry after revise", "make", buildStageResumePrompt({ ...base, stageId: "make", snapshots }));
  record("first turn (resume_from)", "again", buildStagePrompt({ ...base, stageId: "again", snapshots }));
  record("re-entry (resume_from)", "again", buildStageResumePrompt({ ...base, stageId: "again", snapshots }));
  record("reply to human answer", "make", buildStageReplyPrompt("A", "Pick one?"));
  record("reply to cancelled stage", "make", buildStageReplyPrompt("go on", undefined, "e9"));
  record("verify repair", "make", buildVerifyRepairPrompt("check-one failed\n", 1, 3, path.join(session, "make.md"), base.taskFile, session));

  const normalized = Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, normalize(v, root)]));
  expect(normalized).toMatchSnapshot();
  console.log("PROMPT SIZES", JSON.stringify(Object.fromEntries(Object.entries(normalized).map(([k, v]) => [k, v.length]))));
});
