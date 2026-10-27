import { expect, test } from "vitest";
import { conditionalReach, conditionalStages, parseWorkflowMapping } from "../src/workflow.ts";
import { parseYamlDocument } from "../src/yaml.ts";

function parseText(text: string) {
  return parseWorkflowMapping(parseYamlDocument(text) as Record<string, unknown>, "t.yaml");
}

function runWhenWorkflow(stageExtra: string): string {
  return `\
schema_version: 2
id: t
stages:
  - id: docs
    role: developer
    produces:
      artifact: docs.md
  - id: review_docs
    role: reviewer
    depends_on: [docs]
${stageExtra}`;
}

const GOOD_RUN_WHEN = `\
    run_when:
      changed_paths:
        - "docs/**/*"
        - "**/README.md"
`;

test("run_when parses onto the stage", () => {
  const document = parseText(runWhenWorkflow(GOOD_RUN_WHEN));
  expect(document.stages.review_docs?.runWhen).toEqual({ changedPaths: ["docs/**/*", "**/README.md"] });
  expect(document.stages.docs?.runWhen).toBeNull();
});

test("run_when null means absent and a decision on a run_when stage is accepted", () => {
  expect(parseText(runWhenWorkflow("    run_when: null\n")).stages.review_docs?.runWhen).toBeNull();
  const decided = runWhenWorkflow(
    `${GOOD_RUN_WHEN}    decision:\n      values: [approved, revise]\n      routes:\n        approved: complete\n        revise: docs\n`,
  );
  expect(parseText(decided).stages.review_docs?.runWhen).not.toBeNull();
});

test("run_when errors", () => {
  const cases: Array<[string, string]> = [
    ["    run_when: nope\n", "stages.review_docs.run_when must be a mapping."],
    ["    run_when: {}\n", "stages.review_docs.run_when.changed_paths is required."],
    ["    run_when:\n      changed_paths: null\n", "stages.review_docs.run_when.changed_paths is required."],
    ["    run_when:\n      changed_paths: [a]\n      other: 1\n", "stages.review_docs.run_when.other is not supported."],
    ["    run_when:\n      changed_paths: docs\n", "stages.review_docs.run_when.changed_paths must be a list."],
    ["    run_when:\n      changed_paths: []\n", "stages.review_docs.run_when.changed_paths must be a non-empty list."],
    ['    run_when:\n      changed_paths: [""]\n', "Missing or invalid stages.review_docs.run_when.changed_paths[0]."],
    ["    run_when:\n      changed_paths: [a, a]\n", "Duplicate stages.review_docs.run_when.changed_paths item: a"],
    [
      '    run_when:\n      changed_paths: ["a**"]\n',
      "Invalid stages.review_docs.run_when.changed_paths[0]: 'a**' (** must be a whole segment).",
    ],
    [`${GOOD_RUN_WHEN}    verify: [pnpm test]\n`, "stages.review_docs.run_when cannot be combined with verify."],
  ];
  for (const [extra, message] of cases) {
    expect(() => parseText(runWhenWorkflow(extra)), extra).toThrow(message);
  }
  const verifyOnly = `\
schema_version: 2
id: t
stages:
  - id: check
    verify: [pnpm test]
    run_when:
      changed_paths: ["a"]
`;
  expect(() => parseText(verifyOnly)).toThrow("stages.check.run_when cannot be combined with verify.");
  const version1 = `\
id: t
stages:
  - id: a
    role: developer
    run_when:
      changed_paths: ["a"]
`;
  expect(() => parseText(version1)).toThrow("stages.a.run_when requires schema_version 2.");
});

const CONDITIONAL_BASE = `\
schema_version: 2
id: t
stages:
  - id: base
    role: developer
    produces:
      artifact: base.md
  - id: r
    role: reviewer
    depends_on: [base]
    produces:
      artifact: r.md
    run_when:
      changed_paths: ["docs/**/*"]
    decision:
      values: [approved, revise]
      routes:
        approved: complete
        revise: x
  - id: x
    role: developer
    produces:
      artifact: x.md
  - id: y
    role: developer
    depends_on: [x]
    produces:
      artifact: y.md
`;

test("outputs from the conditional set are rejected", () => {
  const withOutput = (stage: string) =>
    `${CONDITIONAL_BASE}outputs:\n  - name: ${stage}\n    from_stage: ${stage}\n    artifact: ${stage}.md\n`;
  expect(() => parseText(withOutput("x"))).toThrow(
    "outputs 'x' comes from stages.x, which is reached through run_when stage r; a skip would leave it missing.",
  );
  expect(() => parseText(withOutput("y"))).toThrow(
    "outputs 'y' comes from stages.y, which is reached through run_when stage r; a skip would leave it missing.",
  );
  expect(() => parseText(withOutput("r"))).toThrow(
    "outputs 'r' comes from run_when stage r; a skip would leave it missing.",
  );
  expect(() => parseText(withOutput("base"))).not.toThrow();
});

test("a forward route chain and a verify stage in the conditional set are rejected", () => {
  const chain = `\
schema_version: 2
id: t
stages:
  - id: r
    role: reviewer
    run_when:
      changed_paths: ["a"]
    decision:
      values: [go, stop]
      routes:
        go: x
        stop: complete
  - id: x
    role: developer
    decision:
      values: [go, stop]
      routes:
        go: w
        stop: complete
  - id: w
    role: developer
    produces:
      artifact: w.md
outputs:
  - name: w
    from_stage: w
    artifact: w.md
`;
  expect(() => parseText(chain)).toThrow(
    "outputs 'w' comes from stages.w, which is reached through run_when stage r; a skip would leave it missing.",
  );
  const verifyRouted = `\
schema_version: 2
id: t
stages:
  - id: r
    role: reviewer
    run_when:
      changed_paths: ["a"]
    decision:
      values: [go, stop]
      routes:
        go: v
        stop: complete
  - id: v
    verify: [pnpm test]
`;
  expect(() => parseText(verifyRouted)).toThrow(
    "stages.v.verify is reached through run_when stage r; a skip would bypass this verify.",
  );
});

test("a route back is not in the conditional set and the motivating workflow keeps its outputs", () => {
  const motivating = `\
schema_version: 2
id: t
stages:
  - id: implement
    role: developer
    produces:
      artifact: impl.md
  - id: docs
    role: developer
    depends_on: [implement]
    produces:
      artifact: docs.md
    decision:
      values: [updated, no-docs]
      routes:
        updated: review_docs
        no-docs: complete
  - id: review_docs
    role: reviewer
    depends_on: [docs]
    run_when:
      changed_paths: ["docs/**/*", "**/README.md"]
    decision:
      values: [approved, revise]
      routes:
        approved: complete
        revise: docs
outputs:
  - name: impl
    from_stage: implement
    artifact: impl.md
  - name: docs
    from_stage: docs
    artifact: docs.md
`;
  const document = parseText(motivating);
  expect([...conditionalReach(document.stages, "review_docs")]).toEqual(["review_docs"]);
  expect([...conditionalStages(document.stages).keys()]).toEqual(["review_docs"]);
});

test("the first run_when stage in declaration order names overlapping members", () => {
  const text = `\
schema_version: 2
id: t
stages:
  - id: a
    role: developer
    run_when:
      changed_paths: ["a"]
  - id: b
    role: developer
    run_when:
      changed_paths: ["b"]
  - id: c
    role: developer
    depends_on: [a, b]
    produces:
      artifact: c.md
outputs:
  - name: c
    from_stage: c
    artifact: c.md
`;
  expect(() => parseText(text)).toThrow(
    "outputs 'c' comes from stages.c, which is reached through run_when stage a; a skip would leave it missing.",
  );
});

test("conditionalReach covers dependents, forward targets, route backs, and diamonds", () => {
  const text = `\
schema_version: 2
id: t
stages:
  - id: a
    role: developer
  - id: b
    role: developer
    depends_on: [a]
    run_when:
      changed_paths: ["b"]
    decision:
      values: [ok, again, other]
      routes:
        ok: complete
        again: a
        other: t1
  - id: c
    role: developer
    depends_on: [b]
  - id: c2
    role: developer
    depends_on: [b]
  - id: d
    role: developer
    depends_on: [c, c2]
  - id: t1
    role: developer
  - id: t2
    role: developer
    depends_on: [t1]
`;
  const document = parseText(text);
  expect([...conditionalReach(document.stages, "b")].sort()).toEqual(["b", "c", "c2", "d", "t1", "t2"]);
  expect(conditionalReach(document.stages, "b").has("a")).toBe(false);
  expect([...conditionalReach(document.stages, "c")].sort()).toEqual(["c", "d"]);
});
