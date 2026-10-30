import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { formatNextCommand, publishNextSuggestions, resolveHandoff } from "../src/next-handoff.ts";
import { activatePreparedSession, createPreparedSession, createWorkflowSession } from "../src/session-records.ts";
import { loadFrozenWorkflow } from "../src/session-freeze.ts";
import { readFoldedStatus } from "../src/session-fold.ts";
import { parseWorkflowMapping } from "../src/workflow.ts";
import { SESSION_CONFIG } from "./support.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "migent-handoff-"));
  roots.push(root);
  const workflows = path.join(root, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(root, ".migent", "config.yaml"), SESSION_CONFIG);
  writeFileSync(path.join(workflows, "plan.yaml"), `schema_version: 4
id: plan
stages:
  - id: draft
    role: planner
    produces: { artifact: plan.md }
outputs:
  - { name: approved_plan, from_stage: draft, artifact: plan.md }
downstream:
  - workflow: implement
    task: Implement the plan
    artifacts: { plan: approved_plan }
`);
  writeFileSync(path.join(workflows, "implement.yaml"), "schema_version: 4\nid: implement\nstages:\n  - { id: work, role: developer }\n");
  const prior = createWorkflowSession(root, "plan", "Plan the work");
  const directory = path.join(root, ".migent", "sessions", prior);
  mkdirSync(path.join(directory, "outputs"));
  writeFileSync(path.join(directory, "outputs", "plan.md"), "The approved plan\n");
  // Completed-source fixture; no provider process is invoked by these lifecycle tests.
  writeFileSync(path.join(directory, "status.json"), JSON.stringify({
    session_id: prior, workflow_id: "plan", status: "completed",
    outputs: { approved_plan: { path: "outputs/plan.md" } },
  }));
  return { root, prior, directory, workflows };
}

test("suggestions have explicit mappings and argv, no hashes; source edits do not change them", () => {
  const { root, prior, directory, workflows } = setup();
  const result = publishNextSuggestions(root, prior);
  const original = readFileSync(result.path!, "utf8");
  expect(result.next[0]).toMatchObject({ workflow: "implement", task: "Implement the plan", artifacts: { plan: { output: "approved_plan", path: "outputs/plan.md" } } });
  expect(JSON.parse(original)).toMatchObject({ schema_version: 1, source_session_id: prior });
  expect(original).not.toMatch(/sha256|timestamp/);
  expect(result.next[0].argv).toEqual(["migent", "session", "run", "--workflow", "implement", "--prior", prior]);
  writeFileSync(path.join(workflows, "plan.yaml"), "broken: [");
  writeFileSync(path.join(directory, "next.json"), "tampered");
  expect(publishNextSuggestions(root, prior).next).toEqual(result.next);
  expect(readFileSync(result.path!, "utf8")).toBe(original);
});

test("target loads current workflow and snapshots mapped artifacts with durable provenance", () => {
  const { root, prior, workflows, directory } = setup();
  writeFileSync(path.join(workflows, "implement.yaml"), "schema_version: 4\nid: implement\nstages:\n  - { id: changed, role: developer }\n");
  const target = createWorkflowSession(root, "implement", null, prior);
  const targetDir = path.join(root, ".migent", "sessions", target);
  expect(loadFrozenWorkflow(targetDir)?.stages.changed).toBeDefined();
  const status = readFoldedStatus(root, targetDir) as any;
  expect(status.task).toBe("Implement the plan");
  expect(status.handoff.source_session_id).toBe(prior);
  const artifact = status.handoff.artifacts.plan;
  expect(artifact.output).toBe("approved_plan");
  expect(artifact.sha256).toBe(createHash("sha256").update("The approved plan\n").digest("hex"));
  expect(readFileSync(path.join(targetDir, "manifest.yaml"), "utf8")).toContain(artifact.sha256);
  writeFileSync(path.join(directory, "outputs", "plan.md"), "Changed after start");
  expect(readFileSync(path.join(targetDir, artifact.path), "utf8")).toBe("The approved plan\n");
  expect((readFoldedStatus(root, targetDir) as any).handoff).toEqual(status.handoff);
  const overridden = createWorkflowSession(root, "implement", "Explicit task", prior);
  expect(readFoldedStatus(root, path.join(root, ".migent", "sessions", overridden)).task).toBe("Explicit task");
});

test("fallback --prior passes all outputs, while consumers run standalone", () => {
  const { root, prior, workflows } = setup();
  writeFileSync(path.join(workflows, "other.yaml"), "schema_version: 4\nid: other\nstages:\n  - { id: work, role: developer }\n");
  expect(() => createWorkflowSession(root, "other", null, prior)).toThrow(/requires --task/);
  const fallback = createWorkflowSession(root, "other", "Independent task", prior);
  const status = readFoldedStatus(root, path.join(root, ".migent", "sessions", fallback)) as any;
  expect(status.handoff.artifacts.approved_plan.output).toBe("approved_plan");
  expect(createWorkflowSession(root, "implement", "Standalone work")).toBeTruthy();
});

test("invalid prior sources fail before allocating a target session", () => {
  const { root, prior, directory } = setup();
  const sessions = path.join(root, ".migent", "sessions");
  const before = readdirSync(sessions);
  expect(() => createWorkflowSession(root, "implement", null, "missing")).toThrow(/not found/);
  rmSync(path.join(directory, "outputs", "plan.md"));
  expect(() => createWorkflowSession(root, "implement", null, prior)).toThrow(/missing or empty/);
  writeFileSync(path.join(directory, "status.json"), JSON.stringify({ status: "active" }));
  expect(() => createWorkflowSession(root, "implement", "Task", prior)).toThrow(/not completed/);
  expect(readdirSync(sessions)).toEqual(before);
});

test("prepare defers workflow and handoff snapshots until run, and binding failure stays prepared", () => {
  const { root, prior, workflows, directory } = setup();
  const prepared = createPreparedSession(root, "Prepared target", "implement", prior);
  const targetDir = path.join(root, ".migent", "sessions", prepared);
  expect(existsSync(path.join(targetDir, "workflow.frozen.yaml"))).toBe(false);
  expect(existsSync(path.join(targetDir, "handoff"))).toBe(false);
  writeFileSync(path.join(targetDir, "task.md"), "A manually prepared task\n");
  writeFileSync(path.join(workflows, "implement.yaml"), "schema_version: 4\nid: implement\nstages:\n  - { id: changed, role: developer }\n");
  rmSync(path.join(directory, "outputs", "plan.md"));
  expect(() => activatePreparedSession(root, prepared)).toThrow(/missing or empty/);
  expect(readFoldedStatus(root, targetDir).status).toBe("prepared");
  writeFileSync(path.join(directory, "outputs", "plan.md"), "Updated before run\n");
  activatePreparedSession(root, prepared);
  expect(loadFrozenWorkflow(targetDir)?.stages.changed).toBeDefined();
  const status = readFoldedStatus(root, targetDir) as any;
  expect(status.status).toBe("active");
  expect(readFileSync(path.join(targetDir, status.handoff.artifacts.plan.path), "utf8")).toBe("Updated before run\n");
  expect(readFileSync(path.join(targetDir, "task.md"), "utf8")).toBe("A manually prepared task\n");
});

test("next publication errors preserve completion and can be retried", () => {
  const { root, prior, directory } = setup();
  mkdirSync(path.join(directory, "next.json"));
  const result = publishNextSuggestions(root, prior);
  expect(result.path).toBeNull();
  expect(result.next).toHaveLength(1);
  expect(JSON.parse(readFileSync(path.join(directory, "status.json"), "utf8")).status).toBe("completed");
  rmSync(path.join(directory, "next.json"), { recursive: true });
  expect(publishNextSuggestions(root, prior).path).toBe(path.join(directory, "next.json"));
});

test("schema rejects ambiguous or invalid downstream contracts and retains historical requires", () => {
  const base = { schema_version: 4, id: "plan", stages: [{ id: "draft", role: "planner", produces: { artifact: "plan.md" } }], outputs: [{ name: "plan", from_stage: "draft", artifact: "plan.md" }] };
  const entry = { workflow: "implement", task: "Implement", artifacts: { plan: "plan" } };
  for (const downstream of [[entry, entry], [{ ...entry, task: "one\ntwo" }], [{ ...entry, workflow: "./implement.yaml" }], [{ ...entry, artifacts: { plan: "missing" } }], [{ ...entry, artifacts: { "bad/name": "plan" } }]]) {
    expect(() => parseWorkflowMapping({ ...base, downstream }, "test.yaml")).toThrow();
  }
  expect(() => parseWorkflowMapping({ ...base, requires: { workflow: "plan" } }, "test.yaml")).toThrow(/requires was removed/);
  expect(parseWorkflowMapping({ ...base, schema_version: 3, requires: { workflow: "plan" } }, "test.yaml").requires?.workflow).toBe("plan");
});

test("commands quote shell metacharacters without interpolation", () => {
  expect(formatNextCommand(["migent", "--workflow", "work ' $x;"], true)).toBe("migent --workflow 'work '' $x;'");
  expect(formatNextCommand(["migent", "--workflow", "work ' $x;"], false)).toBe("migent --workflow 'work '\\'' $x;'");
});
