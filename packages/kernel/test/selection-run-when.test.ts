import { expect, test } from "vitest";
import {
  revisionResumeExecution,
  revisionStop,
  stageAgentExecution,
  stageDispatchError,
  readyStages,
  type ExecutionSnapshot,
  type WorkflowDocument,
} from "../src/index.ts";
import {
  currentCompleteByStage,
  latestCompleteByStage,
  schedulableStageIds,
  version2GraphQuiet,
} from "../src/selection.ts";
import { parseWorkflowMapping } from "../src/workflow.ts";
import { parseYamlDocument } from "../src/yaml.ts";

function workflowFrom(text: string): WorkflowDocument {
  return parseWorkflowMapping(parseYamlDocument(text) as Record<string, unknown>, "t.yaml");
}

function done(stageId: string, order: number, decision: string | null = null): ExecutionSnapshot {
  return {
    executionId: `${String(order).padStart(4, "0")}-${stageId}`,
    stageId,
    executionOrder: order,
    status: "completed",
    outcomeStatus: "complete",
    artifactDirectory: "/tmp",
    outcomeDecision: decision,
  };
}

function skip(stageId: string, order: number): ExecutionSnapshot {
  return { ...done(stageId, order), status: "skipped", outcomeStatus: null };
}

function ready(workflow: WorkflowDocument, snapshots: ExecutionSnapshot[]): string[] {
  return readyStages(workflow, snapshots, "active");
}

const CHAIN = `\
schema_version: 2
id: chain
stages:
  - id: A
    role: developer
  - id: B
    role: developer
    depends_on: [A]
    run_when:
      changed_paths: ["docs/**/*"]
  - id: C
    role: developer
    depends_on: [B]
  - id: E
    role: developer
  - id: F
    role: developer
    depends_on: [E]
  - id: D
    role: developer
    depends_on: [C, E]
`;

test("a skipped stage is not selected again until a dependency is newer", () => {
  const workflow = workflowFrom(CHAIN);
  const snapshots = [done("A", 1), skip("B", 2)];
  expect(ready(workflow, snapshots)).not.toContain("B");
  expect(stageDispatchError(workflow, "C", snapshots)).toBe("Stage C depends on B, which was skipped by run_when.");
  expect(ready(workflow, [...snapshots, done("A", 3)])).toContain("B");
});

test("(a)(b) a dependent of a stage that completed, was reached again, and was skipped does not run", () => {
  const workflow = workflowFrom(`\
schema_version: 2
id: join
stages:
  - id: A
    role: developer
  - id: B
    role: developer
    depends_on: [A]
    run_when:
      changed_paths: ["x"]
  - id: D
    role: developer
    depends_on: [A, B]
`);
  const snapshots = [done("A", 1), done("B", 2), done("D", 3), done("A", 5), skip("B", 6)];
  expect(stageDispatchError(workflow, "D", snapshots)).toBe("Stage D depends on B, which was skipped by run_when.");
  expect(ready(workflow, snapshots)).not.toContain("D");
  expect(currentCompleteByStage(workflow, snapshots).B).toBeUndefined();
  // (f) a newer A makes B a candidate again. D waits for B.
  const again = [...snapshots, done("A", 8)];
  expect(ready(workflow, again)).toContain("B");
  expect(ready(workflow, again)).not.toContain("D");
  const recovered = [...again, done("B", 9)];
  expect(ready(workflow, recovered)).toContain("D");
});

test("(c) a stale route decision of a skipped router is never read", () => {
  const workflow = workflowFrom(`\
schema_version: 2
id: route
stages:
  - id: Z
    role: developer
  - id: R
    role: reviewer
    run_when:
      changed_paths: ["x"]
    decision:
      values: [approved, revise]
      routes:
        approved: complete
        revise: X
  - id: X
    role: developer
    depends_on: [Z]
`);
  const stale = [done("R", 4, "revise"), skip("R", 6), done("Z", 7)];
  expect(stageDispatchError(workflow, "X", stale)).toBe("Stage X is not routed by R: R was skipped by run_when.");
  expect(ready(workflow, stale)).not.toContain("X");
  const control = [done("R", 4, "revise"), done("Z", 7)];
  expect(ready(workflow, control)).toContain("X");
});

test("(d) a skipped router does not send its route-back target again and the graph goes quiet", () => {
  const workflow = workflowFrom(`\
schema_version: 2
id: back
stages:
  - id: docs
    role: developer
  - id: review
    role: reviewer
    depends_on: [docs]
    run_when:
      changed_paths: ["x"]
    decision:
      values: [approved, revise]
      routes:
        approved: complete
        revise: docs
`);
  const snapshots = [done("docs", 1), done("review", 4, "revise"), done("docs", 5), skip("review", 6)];
  expect(ready(workflow, snapshots)).toEqual([]);
  expect(version2GraphQuiet(workflow, snapshots, "active")).toBe(true);
  const solo = workflowFrom(`\
schema_version: 2
id: solo
stages:
  - id: only
    role: developer
    run_when:
      changed_paths: ["x"]
`);
  expect(version2GraphQuiet(solo, [skip("only", 1)], "active")).toBe(true);
});

test("(e) a forward route target is blocked by a skipped router", () => {
  const workflow = workflowFrom(`\
schema_version: 2
id: forward
stages:
  - id: docs
    role: developer
  - id: R
    role: reviewer
    run_when:
      changed_paths: ["x"]
    decision:
      values: [approved, revise]
      routes:
        approved: complete
        revise: fix
  - id: fix
    role: developer
    depends_on: [docs]
`);
  const snapshots = [done("R", 2, "revise"), done("docs", 4), skip("R", 5)];
  expect(ready(workflow, snapshots)).not.toContain("fix");
  expect(stageDispatchError(workflow, "fix", snapshots)).toBe("Stage fix is not routed by R: R was skipped by run_when.");
});

test("(h) a transitive completion in the reach of a skip stays superseded", () => {
  const workflow = workflowFrom(CHAIN);
  const snapshots = [
    done("A", 1),
    done("B", 2),
    done("C", 3),
    done("E", 4),
    done("D", 5),
    done("A", 6),
    skip("B", 7),
    done("E", 8),
  ];
  expect(stageDispatchError(workflow, "D", snapshots)).toBe(
    "Stage D depends on C, whose completion predates the run_when skip of B.",
  );
  expect(ready(workflow, snapshots)).not.toContain("D");
  expect(ready(workflow, snapshots)).not.toContain("C");
  expect(schedulableStageIds(workflow, snapshots, "active", null, null, new Set())).not.toContain("D");
  const control = snapshots.filter((item) => item.status !== "skipped");
  expect(ready(workflow, control)).toContain("D");
});

test("(i) the reach recovers once the skipped stage and then its dependents complete again", () => {
  const workflow = workflowFrom(CHAIN);
  const base = [
    done("A", 1),
    done("B", 2),
    done("C", 3),
    done("E", 4),
    done("D", 5),
    done("A", 6),
    skip("B", 7),
    done("E", 8),
  ];
  const afterB = [...base, done("A", 9), done("B", 10)];
  expect(ready(workflow, afterB)).toContain("C");
  expect(ready(workflow, afterB)).not.toContain("D");
  const afterC = [...afterB, done("C", 11)];
  expect(ready(workflow, afterC)).toContain("D");
  expect(stageDispatchError(workflow, "D", afterC)).toBeNull();
});

test("(j) a forward target and its dependents are superseded by a later skip of the router", () => {
  const workflow = workflowFrom(`\
schema_version: 2
id: forward2
stages:
  - id: Z
    role: developer
  - id: R
    role: reviewer
    run_when:
      changed_paths: ["x"]
    decision:
      values: [approved, revise]
      routes:
        approved: complete
        revise: T
  - id: T
    role: developer
    depends_on: [Z]
  - id: E
    role: developer
  - id: U
    role: developer
    depends_on: [T, E]
`);
  const snapshots = [done("Z", 1), done("R", 2, "revise"), done("T", 3), done("E", 4), done("U", 5), skip("R", 7), done("E", 8)];
  expect(stageDispatchError(workflow, "U", snapshots)).toBe(
    "Stage U depends on T, whose completion predates the run_when skip of R.",
  );
  expect(ready(workflow, snapshots)).not.toContain("U");
  expect(ready(workflow, snapshots)).not.toContain("T");
  const control = [done("Z", 1), done("R", 2, "revise"), done("T", 3), done("E", 4), done("U", 5), done("E", 8)];
  expect(ready(workflow, control)).toContain("U");
});

test("(k) a stage outside the reach is unaffected", () => {
  const workflow = workflowFrom(CHAIN);
  const snapshots = [
    done("A", 1),
    done("B", 2),
    done("C", 3),
    done("E", 4),
    done("F", 5),
    done("D", 6),
    done("A", 7),
    skip("B", 8),
    done("E", 9),
  ];
  expect(ready(workflow, snapshots)).toContain("F");
});

test("(g) without skips the current map equals the latest completions", () => {
  const workflow = workflowFrom(CHAIN);
  const snapshots = [done("A", 1), done("B", 2), done("C", 3)];
  expect(currentCompleteByStage(workflow, snapshots)).toEqual(latestCompleteByStage(snapshots));
});

test("skips do not hold agents, resume sessions, or count as revisions", () => {
  const workflow = workflowFrom(`\
schema_version: 2
id: rev
stages:
  - id: docs
    role: developer
  - id: review
    role: reviewer
    depends_on: [docs]
    max_revisions: 1
    run_when:
      changed_paths: ["x"]
    decision:
      values: [approved, revise]
      routes:
        approved: complete
        revise: review
`);
  const snapshots = [done("review", 2, "revise"), skip("review", 3), skip("review", 4)];
  expect(stageAgentExecution(snapshots, "review")).toBe("0002-review");
  expect(stageAgentExecution([skip("review", 1)], "review")).toBeNull();
  expect(revisionResumeExecution(workflow, [skip("review", 1)], "review")).toBeNull();
  expect(revisionStop(workflow, snapshots, "review")).toBe(false);
});
