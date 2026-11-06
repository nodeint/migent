import { expect, test } from "vitest";
import {
  checkWorkflowCatalog,
  collectWorkflowDraft,
  parseWorkflowMapping,
  type WorkflowDownstream,
} from "../src/index.ts";

type Mapping = Record<string, unknown>;

const stage = (id: string, extra: Mapping = {}): Mapping => ({
  id,
  role: "developer",
  depends_on: [],
  ...extra,
});

const draft = (stages: unknown[], extra: Mapping = {}): Mapping => ({
  schema_version: 4,
  id: "build",
  stages,
  ...extra,
});

test("collects independent errors of different stages and keeps their paths", () => {
  const result = collectWorkflowDraft(
    draft([stage("a", { ask: "bot" }), { id: "b", depends_on: ["a"] }], {
      downstream: [{ workflow: "nowhere", task: "go" }],
    }),
    "build.yaml",
  );
  expect(result.document).toBeNull();
  expect(result.problems.map((item) => item.path)).toEqual([
    ["stages", 0, "ask"],
    ["stages", 1, "role"],
  ]);
  // The downstream entry itself is a catalog rule; its workflow is readable.
  expect(result.downstream[0]?.workflow).toEqual({ state: "valid", value: "nowhere" });
  expect(result.catalogEntry.downstream[0]?.workflow).toEqual({ known: true, value: "nowhere" });
});

test("collects two independent errors inside one stage", () => {
  const result = collectWorkflowDraft(draft([stage("a", { ask: "bot", max_revisions: "many" })]), "build.yaml");
  expect(result.problems.map((item) => item.path)).toEqual([
    ["stages", 0, "ask"],
    ["stages", 0, "max_revisions"],
  ]);
});

test("one invalid downstream entry does not hide another entry's catalog problem", () => {
  const result = collectWorkflowDraft(
    draft([stage("a")], {
      downstream: [{ workflow: "nowhere" }, { workflow: "other", task: "go" }],
    }),
    "build.yaml",
  );
  expect(result.problems.map((item) => item.message)).toEqual(["Missing or invalid downstream.task."]);
  const catalog = checkWorkflowCatalog([result.catalogEntry]);
  expect(catalog.problems.map((item) => item.message)).toEqual([
    "build: downstream workflow nowhere is not in .migent/workflows.",
    "build: downstream workflow other is not in .migent/workflows.",
  ]);
});

test("a stage whose fields are invalid still counts as declared for depends_on", () => {
  const input = draft([stage("a", { ask: "bot" }), stage("b", { depends_on: ["a"] })]);
  const result = collectWorkflowDraft(input, "build.yaml");
  // Only the ask error: the broken stage exists, so the dependency is not "unknown".
  expect(result.problems.map((item) => item.message)).toEqual(["stages.a.ask must be human."]);
});

test("an unknown dependency is reported per stage", () => {
  const result = collectWorkflowDraft(draft([stage("a", { depends_on: ["ghost"] })]), "build.yaml");
  expect(result.problems.map((item) => item.message)).toEqual([
    "stages.a.depends_on is not a declared stage: ghost",
  ]);
});

test("every declared stage with an error still leaves stages declared", () => {
  const result = collectWorkflowDraft(
    draft([{ id: "a", ask: "bot" }, { id: "b", ask: "bot" }]),
    "build.yaml",
  );
  expect(result.stagesDeclared).toBe(true);
  expect(result.catalogEntry.stagesDeclared).toBe(true);
});

test("a duplicate stage id marks the later stage invalid without parsing it", () => {
  const result = collectWorkflowDraft(
    draft([stage("a"), stage("a", { ask: "bot" })]),
    "build.yaml",
  );
  expect(result.problems.map((item) => item.path)).toEqual([["stages", 1, "id"]]);
  expect(result.stages.map((item) => item.index)).toEqual([0]);
});

test("collecting mode reproduces the runtime's first error", () => {
  const cases: Mapping[] = [
    draft([{ id: "a", role: "developer", verify: ["true"], max_verify: 0 }]),
    draft([stage("a", { options: { "bad key": "1" } })]),
    draft([stage("a", { decision: [{ approved: {} }] })]),
    draft([stage("a"), stage("a")]),
    draft([stage("a", { depends_on: ["ghost"] })]),
    draft([stage("a", { produces: { artifact: "verify.md" }, verify: ["true"] })]),
    draft([stage("a", { decision: [{ approved: { navigate: "ghost" } }] })]),
  ];
  for (const candidate of cases) {
    let runtime: string | null = null;
    try {
      parseWorkflowMapping(candidate, "build.yaml");
    } catch (error) {
      runtime = error instanceof Error ? error.message : String(error);
    }
    expect(runtime).not.toBeNull();
    expect(collectWorkflowDraft(candidate, "build.yaml").problems[0]?.message).toBe(runtime);
  }
});

test("downstream artifacts name a declared output", () => {
  const withOutput = (outputs: unknown[], downstream: WorkflowDownstream[]) =>
    draft([stage("a", { produces: { artifact: "a.md" } })], { outputs, downstream });
  const result = collectWorkflowDraft(
    withOutput(
      [{ name: "a", from_stage: "a", artifact: "a.md" }],
      [{ workflow: "next", task: "go", artifacts: { doc: "ghost" } }],
    ),
    "build.yaml",
  );
  expect(result.problems.map((item) => item.message)).toEqual([
    "downstream.artifacts.doc: unknown output ghost.",
  ]);
});

test("a clean draft carries the parsed document", () => {
  const result = collectWorkflowDraft(draft([stage("a")]), "build.yaml");
  expect(result.problems).toEqual([]);
  expect(result.document?.stages.a?.role).toBe("developer");
  expect(result.catalogEntry).toMatchObject({ stagesDeclared: true, id: { known: true, value: "build" } });
});

test("decision routes follow the runtime's fan-out and membership rules", () => {
  const fanOut = collectWorkflowDraft(
    draft([
      stage("a", { decision: [{ approved: { navigate: ["b", "c"] } }] }),
      stage("b"),
      stage("c"),
    ]),
    "build.yaml",
  );
  expect(fanOut.problems).toEqual([]);

  const unknown = collectWorkflowDraft(
    draft([stage("a", { decision: [{ approved: { navigate: "ghost" } }] })]),
    "build.yaml",
  );
  expect(unknown.problems.map((item) => item.message)).toEqual([
    "stages.a.decision.routes.approved is not a declared stage: ghost",
  ]);
});

test("a malformed decision entry does not hide another entry's route target", () => {
  const result = collectWorkflowDraft(
    draft([stage("a", { decision: [{ approved: {} }, { rejected: { navigate: "ghost" } }] })]),
    "build.yaml",
  );
  expect(result.problems.map((item) => [item.message, item.path])).toEqual([
    ["stages.a.decision.approved.navigate is required.", ["stages", 0, "decision", 0, "approved", "navigate"]],
    ["stages.a.decision.routes.rejected is not a declared stage: ghost", ["stages", 0, "decision", 1, "rejected", "navigate"]],
  ]);
});

test("independent top-level errors are reported beside the stage errors", () => {
  const result = collectWorkflowDraft(
    draft([stage("a", { ask: "bot" })], { concurrency: 0, constraints: 5 }),
    "build.yaml",
  );
  expect(result.problems.map((item) => item.path)).toEqual([
    ["stages", 0, "ask"],
    ["concurrency"],
    ["constraints"],
  ]);

  const topOnly = collectWorkflowDraft(draft([stage("a")], { concurrency: 0, constraints: 5 }), "build.yaml");
  expect(topOnly.problems.map((item) => item.path)).toEqual([["concurrency"], ["constraints"]]);
});

test("graph checks run per field, not only when every stage parses", () => {
  const routeBack = collectWorkflowDraft(
    draft([stage("a", { ask: "bot" }), stage("b", { max_revisions: 1 })]),
    "build.yaml",
  );
  expect(routeBack.problems.map((item) => item.path)).toEqual([
    ["stages", 0, "ask"],
    ["stages", 1, "max_revisions"],
  ]);

  const conditional = collectWorkflowDraft(
    draft(
      [
        stage("a", { ask: "bot" }),
        stage("gated", { run_when: { changed_paths: ["src/**"] } }),
        stage("release", { depends_on: ["gated"], produces: { artifact: "release.md" } }),
      ],
      { outputs: [{ name: "release", from_stage: "release", artifact: "release.md" }] },
    ),
    "build.yaml",
  );
  expect(conditional.problems.map((item) => item.message)).toEqual([
    "stages.a.ask must be human.",
    "outputs 'release' comes from stages.release, which is reached through run_when stage gated; a skip would leave it missing.",
  ]);
});

test("graph validators report every independent violation", () => {
  const result = collectWorkflowDraft(
    draft([
      stage("a", { verify: ["true"] }),
      stage("b", { verify: ["true"] }),
      stage("c", { verify: ["true"], depends_on: ["a"] }),
    ]),
    "build.yaml",
  );
  expect(result.problems.map((item) => item.message)).toEqual([
    "stages.a.verify is not on every path to complete: b does not depend on a.",
    "stages.b.verify is not on every path to complete: c does not depend on b.",
    "stages.c.verify is not on every path to complete: b does not depend on c.",
  ]);
});

test("a stage without a role keeps its readable artifact for output checks", () => {
  const result = collectWorkflowDraft(
    draft(
      [
        { id: "a", produces: { artifact: "a.md" }, depends_on: [] },
        stage("b", { depends_on: ["a"] }),
      ],
      { outputs: [{ name: "a", from_stage: "a", artifact: "a.md" }] },
    ),
    "build.yaml",
  );
  expect(result.problems.map((item) => item.message)).toEqual(["stages.a.role is required."]);
});

test("catalog problems carry the downstream entry path", () => {
  const result = collectWorkflowDraft(
    draft([stage("a")], {
      downstream: [
        { workflow: "one", task: "go" },
        { workflow: "two", task: "go" },
      ],
    }),
    "build.yaml",
  );
  const catalog = checkWorkflowCatalog([result.catalogEntry]);
  expect(catalog.problems.map((item) => item.path)).toEqual([
    ["downstream", 0, "workflow"],
    ["downstream", 1, "workflow"],
  ]);
});

test("an unreadable downstream entry keeps the next entry's original index", () => {
  const result = collectWorkflowDraft(
    draft([stage("a")], { downstream: [false, { workflow: "ghost", task: "go" }] }),
    "build.yaml",
  );
  expect(result.problems.map((item) => item.path)).toEqual([["downstream", 0]]);
  const catalog = checkWorkflowCatalog([result.catalogEntry]);
  expect(catalog.problems.map((item) => item.path)).toEqual([["downstream", 1, "workflow"]]);
});

test("a broken dependency elsewhere does not hide a definite conditional violation", () => {
  const result = collectWorkflowDraft(
    draft(
      [
        stage("gated", { run_when: { changed_paths: ["src/**"] } }),
        stage("release", { depends_on: ["gated"], produces: { artifact: "release.md" } }),
        stage("broken", { depends_on: 5 }),
      ],
      { outputs: [{ name: "release", from_stage: "release", artifact: "release.md" }] },
    ),
    "build.yaml",
  );
  expect(result.problems.map((item) => item.message)).toEqual([
    "stages.broken.depends_on must be a list.",
    "outputs 'release' comes from stages.release, which is reached through run_when stage gated; a skip would leave it missing.",
  ]);
});

test("an unreadable stage id does not hide a definite conditional output", () => {
  const result = collectWorkflowDraft(
    draft(
      [
        stage("gated", { run_when: { changed_paths: ["src/**"] }, produces: { artifact: "gated.md" } }),
        { role: "developer", depends_on: [] },
      ],
      { outputs: [{ name: "gated", from_stage: "gated", artifact: "gated.md" }] },
    ),
    "build.yaml",
  );
  expect(result.problems.map((item) => item.message)).toEqual([
    "Missing or invalid stages.id.",
    "outputs 'gated' comes from run_when stage gated; a skip would leave it missing.",
  ]);
});

test("a malformed dependency does not hide an explicit-route verify bypass", () => {
  const result = collectWorkflowDraft(
    draft([
      stage("check", { verify: ["true"] }),
      stage("done", { decision: [{ approved: { navigate: "complete" } }] }),
      stage("broken", { depends_on: 5 }),
    ]),
    "build.yaml",
  );
  expect(result.problems.map((item) => item.message)).toEqual([
    "stages.broken.depends_on must be a list.",
    "stages.check.verify is not on every path to complete: done does not depend on check.",
  ]);
});

test("a route path keeps the author's key spelling", () => {
  const result = collectWorkflowDraft(
    draft([stage("a", { decision: [{ APPROVED: { navigate: "ghost" } }] })]),
    "build.yaml",
  );
  expect(result.problems.map((item) => [item.message, item.path])).toEqual([
    ["stages.a.decision.routes.approved is not a declared stage: ghost", ["stages", 0, "decision", 0, "APPROVED", "navigate"]],
  ]);
});
