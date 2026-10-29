import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { addStageOutcomeContract, nextStage, NextStage, type ExecutionSnapshot } from "../src/index.ts";
import { version2GraphQuiet } from "../src/selection.ts";
import { migrateWorkflow, patchWorkflowText } from "../src/migration.ts";
import { parseWorkflowMapping } from "../src/workflow.ts";
import { parseYamlDocument } from "../src/yaml.ts";
import { readWorkflowFreeze, writeWorkflowFreeze } from "../src/session-freeze.ts";
import { AgentToolRunner } from "../src/agent-runner.ts";
import { executeNamedWorkflow } from "../src/execute.ts";
import { ScriptedProvider } from "./support.ts";

const decisions = [
  { approved: { when: "All requirements pass.", navigate: "complete" } },
  { "approved-with-note": { when: "Only minor findings remain. Record them in review.md.", navigate: "complete" } },
  { revise: { when: "Blocking findings remain. List required fixes.", navigate: "implement" } },
];

function mapping(decision: unknown = decisions, schemaVersion = 3) {
  return {
    schema_version: schemaVersion,
    id: "implement",
    stages: [
      { id: "implement", role: "developer", depends_on: [], max_revisions: 2 },
      { id: "review", role: "reviewer", depends_on: ["implement"], decision },
    ],
  };
}

test("v3 decisions carry agent instructions and route two approvals or a revision", () => {
  const workflow = parseWorkflowMapping(mapping(), "implement.yaml");
  const review = workflow.stages.review!;
  expect(review.decisionValues).toEqual(["approved", "approved-with-note", "revise"]);
  expect(review.decisionInstructions?.["approved-with-note"]).toContain("Record them in review.md.");
  const completed: ExecutionSnapshot[] = ["implement", "review"].map((stageId, index) => ({
    executionId: String(index), stageId, executionOrder: index + 1,
    status: "completed", outcomeStatus: "complete", outcomeDecision: null, artifactDirectory: "/unused",
  }));
  for (const decision of ["approved", "approved-with-note", "revise"]) {
    completed[1]!.outcomeDecision = decision;
    const next = nextStage(workflow, completed, "active");
    if (decision === "revise") expect(next).toEqual(new NextStage("implement"));
    else expect(version2GraphQuiet(workflow, completed, "active")).toBe(true);
  }
  const prompt = addStageOutcomeContract("Review the work.", review.decisionValues, review.decisionInstructions);
  expect(prompt).toContain("decision: approved|approved-with-note|revise");
  expect(prompt).toContain("approved-with-note: Only minor findings remain. Record them in review.md.");
});

test("v3 navigation retains routing to multiple stages", () => {
  const raw = mapping([{ approved: { when: "Ready for checks.", navigate: ["tests", "docs"] } }]);
  raw.stages.push({ id: "tests", role: "developer", depends_on: ["review"] });
  raw.stages.push({ id: "docs", role: "developer", depends_on: ["review"] });
  delete raw.stages[0]!.max_revisions;
  expect(parseWorkflowMapping(raw, "flow.yaml").stages.review?.routes.approved).toEqual(["tests", "docs"]);
});

test.each([
  [[], "non-empty list"],
  [{ values: ["approved"], routes: { approved: "complete" } }, "non-empty list"],
  [[{ approved: { navigate: "complete" } }], ".when"],
  [[{ approved: { when: "  ", navigate: "complete" } }], ".when"],
  [[{ approved: { when: "Ready." } }], ".navigate"],
  [[{ approved: { when: "Ready.", navigate: "missing" } }], "not a declared stage"],
  [[{ approved: { when: "Ready.", navigate: [] } }], "non-empty list"],
  [[{ approved: { when: "Ready.", navigate: ["complete"] } }], "cannot list complete"],
  [[{ approved: {}, revise: {} }], "exactly one decision"],
  [[{ approved: { when: "Ready.", navigate: "complete", unexpected: true } }], "not allowed"],
  [[...decisions, { Approved: { when: "Duplicate.", navigate: "complete" } }], "Duplicate decision"],
])("v3 rejects invalid decision declaration %j", (decision, message) => {
  expect(() => parseWorkflowMapping(mapping(decision), "bad.yaml")).toThrow(String(message));
});

test("v2 decisions still load without changing their contract", () => {
  const workflow = parseWorkflowMapping(mapping({ values: ["approved", "revise"], routes: { approved: "complete", revise: "implement" } }, 2), "old.yaml");
  expect(workflow.schemaVersion).toBe(2);
  expect(workflow.stages.review?.decisionInstructions).toBeUndefined();
  expect(workflow.stages.review?.routes).toEqual({ approved: "complete", revise: "implement" });
});

test.each([1, 2])("migration from v%i preserves prose, routes, outputs, and is idempotent", (version) => {
  const original = `# project workflow
schema_version: ${version}
id: flow
stages:
  - id: draft
    role: developer
    produces:
      artifact: draft.md
  - id: review
    role: reviewer
    depends_on: [draft]
    instructions:
      - Revise only for blocking findings.
    decision: { values: [approved, approved-with-note, revise], routes: { approved: complete, approved-with-note: complete, revise: [draft] } }
    produces:
      artifact: review.md
${version === 1 ? "completion:\n  stage: review\n  outputs:" : "outputs:"}
${version === 1 ? "  " : ""}  - name: draft
${version === 1 ? "  " : ""}    from_stage: draft
${version === 1 ? "  " : ""}    artifact: draft.md
`;
  // v1 only allowed a single route destination.
  const source = version === 1 ? original.replace("revise: [draft]", "revise: draft") : original;
  const raw = parseYamlDocument(source) as Record<string, unknown>;
  const notes = migrateWorkflow(raw, {}, {});
  expect(notes.some((note) => note.includes("review when instructions"))).toBe(true);
  const migrated = patchWorkflowText(source, raw);
  expect(migrated).toContain("# project workflow");
  expect(migrated).toContain("Revise only for blocking findings.");
  expect(migrated).not.toContain("values:");
  const loaded = parseWorkflowMapping(parseYamlDocument(migrated) as Record<string, unknown>, "migrated.yaml");
  expect(loaded.schemaVersion).toBe(3);
  expect(loaded.stages.review?.routes).toEqual({ approved: "complete", "approved-with-note": "complete", revise: version === 1 ? "draft" : ["draft"] });
  expect(loaded.outputs).toEqual([{ name: "draft", fromStage: "draft", artifact: "draft.md" }]);
  expect(loaded.stages.review?.artifact).toBe("review.md");
  expect(migrateWorkflow(raw, {}, {})).toEqual([]);
  expect(patchWorkflowText(migrated, raw)).toBe(migrated);
});

test("migration rejects inconsistent old decision routes instead of discarding them", () => {
  const raw = mapping({ values: ["approved"], routes: { approved: "complete", revise: "implement" } }, 2);
  expect(() => migrateWorkflow(raw, {}, {})).toThrow("routes keys must match");
});

test.each([2, 3])("freeze round-trip preserves schema v%i and its decision contract", (version) => {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-decision-"));
  try {
    mkdirSync(path.join(workspace, ".migent"));
    writeFileSync(path.join(workspace, ".migent/config.yaml"), "roles:\n  developer:\n    default_model: { provider: fake, model: fake }\n  reviewer:\n    default_model: { provider: fake, model: fake }\n");
    const raw = version === 3 ? mapping() : mapping({ values: ["approved", "revise"], routes: { approved: "complete", revise: "implement" } }, 2);
    const workflow = parseWorkflowMapping(raw, "virtual.yaml");
    writeWorkflowFreeze(workspace, workspace, workflow);
    const text = readFileSync(path.join(workspace, "workflow.frozen.yaml"), "utf8");
    expect(text).toContain(`schema_version: ${version}`);
    if (version === 3) expect(text).toContain("Only minor findings remain. Record them in review.md.");
    else expect(text).toContain("values:");
    expect(readWorkflowFreeze(workspace)?.workflow).toEqual({ ...workflow, source: path.join(workspace, "workflow.frozen.yaml") });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("the agent receives frozen decision criteria on initial, reply, and verify repair turns", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-decision-run-"));
  try {
    const workflows = path.join(workspace, ".migent", "workflows");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(path.join(workspace, ".migent/config.yaml"), "schema_version: 3\nroles:\n  reviewer:\n    default_model: { provider: fake, model: fake }\n");
    writeFileSync(path.join(workspace, "verify.cjs"), 'const fs = require("node:fs"); if (!fs.existsSync("verified.flag")) { fs.writeFileSync("verified.flag", ""); process.exit(1); }');
    const source = `schema_version: 3
id: review
stages:
  - id: review
    role: reviewer
    produces:
      artifact: review.md
    verify:
      - '${JSON.stringify(process.execPath)} verify.cjs'
    decision:
      - approved:
          when: No findings remain.
          navigate: complete
      - approved-with-note:
          when: Only minor findings remain. Record them in review.md.
          navigate: complete
`;
    const file = path.join(workflows, "review.yaml");
    writeFileSync(file, source);
    const provider = new ScriptedProvider([
      "status: blocked\nblocker: Need the task clarified.\n\nWaiting.",
      "status: complete\ndecision: approved-with-note\n\nMinor finding retained.",
      "status: complete\ndecision: approved-with-note\n\nVerification fixed; minor finding retained.",
    ], [null, "# Review\nMinor finding retained.\n", null]);
    const runner = new AgentToolRunner({ fake: provider }, 10);
    const first = await executeNamedWorkflow(workspace, { workflowId: "review", task: "Review the work" }, runner);
    expect(first.stopReason).toBe("blocked");
    const frozenFile = path.join(workspace, ".migent/sessions", first.sessionId, "workflow.frozen.yaml");
    const frozenBefore = readFileSync(frozenFile, "utf8");
    writeFileSync(file, source.replace("Only minor findings remain.", "UPDATED criteria."));
    const continued = await executeNamedWorkflow(workspace, { sessionId: first.sessionId, reply: "Use the existing task." }, runner);
    expect(continued.code).toBe(0);
    expect(continued.latestDecision).toBe("approved-with-note");
    expect(provider.calls).toHaveLength(3);
    for (const call of provider.calls) {
      expect(call.prompt).toContain("approved-with-note: Only minor findings remain. Record them in review.md.");
      expect(call.prompt).not.toContain("UPDATED criteria.");
    }
    expect(provider.calls[1]?.prompt).toContain("Use the existing task.");
    expect(provider.calls[2]?.prompt).toContain("Verify failed");
    expect(readFileSync(frozenFile, "utf8")).toBe(frozenBefore);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}, 30_000);
