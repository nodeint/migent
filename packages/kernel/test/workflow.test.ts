import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  ConfigurationError,
  loadNamedWorkflow,
  loadWorkflowCatalog,
  loadWorkflowDocument,
} from "../src/index.ts";
import { tempDir } from "./support.ts";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "workflows");

test("loads repo instructions and constraints", () => {
  const review = loadWorkflowDocument(path.join(fixtures, "plan.yaml"));
  const implement = loadWorkflowDocument(path.join(fixtures, "plan-implement.yaml"));
  expect(review.constraints).toEqual([
    "Do not write implementation code.",
    "Do not infer decisions from review prose.",
  ]);
  expect(review.stages.plan?.instructions).toEqual([]);
  expect(implement.stages.implement?.instructions).toEqual([
    "Implement production code only.",
    "Do not add or modify test code.",
  ]);
  expect(implement.constraints).toEqual([]);
});

test("rejects non-list instructions and constraints", () => {
  const dir = tempDir("migent-flow-");
  const flow = path.join(dir, "flow.yaml");
  writeFileSync(
    flow,
    "id: broken\nconstraints: nope\nstages:\n  - id: a\n    role: r\n",
    "utf8",
  );
  expect(() => loadWorkflowDocument(flow)).toThrow(ConfigurationError);
  expect(() => loadWorkflowDocument(flow)).toThrow(/constraints must be a list/);
  writeFileSync(
    flow,
    "id: broken\nstages:\n  - id: a\n    role: r\n    instructions: nope\n",
    "utf8",
  );
  expect(() => loadWorkflowDocument(flow)).toThrow(/stages\.a\.instructions must be a list/);
});

test("loads routes, requires, and resume_from", () => {
  const dir = tempDir("migent-flow-");
  const flow = path.join(dir, "flow.yaml");
  writeFileSync(
    flow,
    `\
id: plan-implement
requires:
  workflow: plan
  decision: approved
stages:
  - id: implement
    role: developer
    depends_on: []
  - id: review-work
    role: reviewer
    depends_on:
      - implement
    decision:
      values:
        - approved
        - revise
      routes:
        approved: write-tests
        revise: implement
  - id: write-tests
    role: developer
    session:
      resume_from: implement
    depends_on:
      - implement
      - review-work
`,
    "utf8",
  );
  const document = loadWorkflowDocument(flow);
  expect(document.requires?.workflow).toBe("plan");
  expect(document.requires?.decision).toBe("approved");
  expect(document.stages["review-work"]?.routes.approved).toBe("write-tests");
  expect(document.stages["write-tests"]?.resumeFrom).toBe("implement");
});

test("resume_from must be a dependency", () => {
  const dir = tempDir("migent-flow-");
  const flow = path.join(dir, "flow.yaml");
  writeFileSync(
    flow,
    `\
id: broken
stages:
  - id: implement
    role: developer
  - id: write-tests
    role: developer
    session:
      resume_from: implement
    depends_on: []
`,
    "utf8",
  );
  expect(() => loadWorkflowDocument(flow)).toThrow(/must be a dependency/);
});

test("loads max_revisions on a route target", () => {
  const dir = tempDir("migent-flow-");
  const flow = path.join(dir, "flow.yaml");
  writeFileSync(
    flow,
    `\
id: loop
stages:
  - id: plan
    role: planner
    max_revisions: 0
  - id: review
    role: reviewer
    depends_on:
      - plan
    decision:
      values:
        - approved
        - revise
      routes:
        approved: complete
        revise: plan
`,
    "utf8",
  );
  const document = loadWorkflowDocument(flow);
  expect(document.stages.plan?.maxRevisions).toBe(0);
  expect(document.stages.review?.maxRevisions).toBeNull();
});

test("rejects max_revisions without a route back", () => {
  const dir = tempDir("migent-flow-");
  const flow = path.join(dir, "flow.yaml");
  writeFileSync(
    flow,
    `\
id: loop
stages:
  - id: plan
    role: planner
  - id: review
    role: reviewer
    max_revisions: 3
    depends_on:
      - plan
    decision:
      values:
        - revise
      routes:
        revise: plan
`,
    "utf8",
  );
  expect(() => loadWorkflowDocument(flow)).toThrow(/requires a route back to review/);
});

test("rejects a negative max_revisions", () => {
  const dir = tempDir("migent-flow-");
  const flow = path.join(dir, "flow.yaml");
  writeFileSync(
    flow,
    `\
id: loop
stages:
  - id: plan
    role: planner
    max_revisions: -1
  - id: review
    role: reviewer
    depends_on:
      - plan
    decision:
      values: [revise]
      routes:
        revise: plan
`,
    "utf8",
  );
  expect(() => loadWorkflowDocument(flow)).toThrow(/non-negative integer/);
});

test("catalog checks file ids and requires", () => {
  const workspace = tempDir("migent-catalog-");
  const workflows = path.join(workspace, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(
    path.join(workflows, "plan.yaml"),
    "id: plan\n" +
      "stages:\n" +
      "  - id: plan\n" +
      "    role: planner\n" +
      "completion:\n" +
      "  stage: plan\n" +
      "  decision: revise\n",
    "utf8",
  );
  writeFileSync(
    path.join(workflows, "other.yaml"),
    "id: renamed\nstages:\n  - id: a\n    role: planner\n",
    "utf8",
  );
  writeFileSync(
    path.join(workflows, "follow-on.yaml"),
    "id: follow-on\n" +
      "requires:\n" +
      "  workflow: plan\n" +
      "  decision: approved\n" +
      "stages:\n" +
      "  - id: implement\n" +
      "    role: developer\n",
    "utf8",
  );
  const catalog = loadWorkflowCatalog(workspace);
  expect(Object.keys(catalog.documents)).toEqual(["follow-on", "renamed", "plan"]);
  expect(catalog.problems).toContain(
    "follow-on: requires plan to complete with approved, but it completes with revise.",
  );
  expect(loadNamedWorkflow(workspace, "renamed").id).toBe("renamed");
  expect(() => loadNamedWorkflow(workspace, "other")).toThrow(ConfigurationError);
  expect(() => loadNamedWorkflow(workspace, "other")).toThrow(/Workflow not found: other/);
});

test("omitted id uses the file name", () => {
  const workspace = tempDir("migent-catalog-");
  const workflows = path.join(workspace, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  const flow = path.join(workflows, "plan.yaml");
  writeFileSync(flow, "stages:\n  - id: plan\n    role: planner\n", "utf8");
  expect(loadNamedWorkflow(workspace, "plan").id).toBe("plan");
  expect(loadWorkflowDocument(flow).id).toBe("plan");
});

test("declared id is used when the file name differs", () => {
  const workspace = tempDir("migent-catalog-");
  const workflows = path.join(workspace, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  const flow = path.join(workflows, "notes.yaml");
  writeFileSync(flow, "id: plan\nstages:\n  - id: plan\n    role: planner\n", "utf8");
  const byId = loadNamedWorkflow(workspace, "plan");
  const byPath = loadNamedWorkflow(workspace, ".migent/workflows/notes.yaml");
  expect(byId.id).toBe("plan");
  expect(byPath.id).toBe("plan");
  expect(byPath.source).toBe(flow);
});

test("duplicate ids fail lookup and a path still loads", () => {
  const workspace = tempDir("migent-catalog-");
  const workflows = path.join(workspace, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(
    path.join(workflows, "a.yaml"),
    "id: plan\nstages:\n  - id: plan\n    role: planner\n",
    "utf8",
  );
  const second = path.join(workflows, "b.yaml");
  writeFileSync(second, "id: plan\nstages:\n  - id: plan\n    role: planner\n", "utf8");
  const catalog = loadWorkflowCatalog(workspace);
  expect(catalog.documents).toEqual({});
  expect(catalog.problems).toContain("plan: id is declared by a.yaml, b.yaml.");
  expect(() => loadNamedWorkflow(workspace, "plan")).toThrow(ConfigurationError);
  expect(() => loadNamedWorkflow(workspace, "plan")).toThrow(/id is declared by a\.yaml, b\.yaml/);
  const loaded = loadNamedWorkflow(workspace, ".migent/workflows/b.yaml");
  expect(loaded.id).toBe("plan");
  expect(loaded.source).toBe(second);
});

test("rejects an empty stage model", () => {
  const dir = tempDir("migent-flow-");
  const flow = path.join(dir, "flow.yaml");
  writeFileSync(flow, 'id: broken\nstages:\n  - id: a\n    role: r\n    model: ""\n', "utf8");
  expect(() => loadWorkflowDocument(flow)).toThrow(/Missing or invalid stages\.a\.model\./);
});

function writeFlow(body: string): string {
  const dir = tempDir("migent-flow-");
  const flow = path.join(dir, "flow.yaml");
  writeFileSync(flow, body, "utf8");
  return flow;
}

test("version 2 loads a string route and top-level outputs", () => {
  const document = loadWorkflowDocument(writeFlow(`\
schema_version: 2
id: plan
stages:
  - id: plan
    role: planner
    depends_on: []
    produces:
      artifact: plan.md
  - id: review
    role: reviewer
    depends_on:
      - plan
    decision:
      values:
        - approved
      routes:
        approved: complete
outputs:
  - name: plan
    from_stage: plan
    artifact: plan.md
`));
  expect(document.schemaVersion).toBe(2);
  expect(document.concurrency).toBe(1);
  expect(document.completion).toBeNull();
  expect(document.stages.review?.routes.approved).toBe("complete");
  expect(document.outputs).toEqual([{ name: "plan", fromStage: "plan", artifact: "plan.md" }]);
});

test("version 2 loads a list route and refuses an empty list", () => {
  const document = loadWorkflowDocument(writeFlow(`\
schema_version: 2
id: plan
stages:
  - id: plan
    role: planner
    depends_on: []
  - id: review
    role: reviewer
    depends_on:
      - plan
    decision:
      values:
        - approved
      routes:
        approved:
          - plan
`));
  expect(document.stages.review?.routes.approved).toEqual(["plan"]);
  const empty = writeFlow(`\
schema_version: 2
id: plan
stages:
  - id: review
    role: reviewer
    depends_on: []
    decision:
      values:
        - approved
      routes:
        approved: []
`);
  expect(() => loadWorkflowDocument(empty)).toThrow(
    /stages\.review\.decision\.routes\.approved must be a non-empty list\./,
  );
});

test("version 2 refuses complete inside a list route", () => {
  const flow = writeFlow(`\
schema_version: 2
id: plan
stages:
  - id: review
    role: reviewer
    depends_on: []
    decision:
      values:
        - approved
      routes:
        approved:
          - complete
`);
  expect(() => loadWorkflowDocument(flow)).toThrow(
    /stages\.review\.decision\.routes\.approved cannot list complete\./,
  );
});

test("version 2 loads concurrency above 1 and refuses a non-positive value", () => {
  const document = loadWorkflowDocument(
    writeFlow("schema_version: 2\nid: plan\nconcurrency: 2\nstages:\n  - id: plan\n    role: planner\n"),
  );
  expect(document.concurrency).toBe(2);
  expect(() =>
    loadWorkflowDocument(
      writeFlow("schema_version: 2\nid: plan\nconcurrency: 0\nstages:\n  - id: plan\n    role: planner\n"),
    ),
  ).toThrow(/concurrency must be a positive integer\./);
  const one = loadWorkflowDocument(
    writeFlow("schema_version: 2\nid: plan\nconcurrency: 1\nstages:\n  - id: plan\n    role: planner\n"),
  );
  expect(one.concurrency).toBe(1);
});

test("version 1 still loads completion and a string route", () => {
  const document = loadWorkflowDocument(writeFlow(`\
schema_version: 1
id: plan
stages:
  - id: plan
    role: planner
    depends_on: []
    produces:
      artifact: plan.md
  - id: review
    role: reviewer
    depends_on:
      - plan
    decision:
      values:
        - approved
      routes:
        approved: complete
completion:
  stage: review
  decision: approved
  outputs:
    - name: plan
      from_stage: plan
      artifact: plan.md
`));
  expect(document.schemaVersion).toBe(1);
  expect(document.concurrency).toBeUndefined();
  expect(document.outputs).toBeUndefined();
  expect(document.completion).toEqual({
    stage: "review",
    decision: "approved",
    outputs: [{ name: "plan", fromStage: "plan", artifact: "plan.md" }],
  });
});
