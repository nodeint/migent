import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { buildStagePrompt, migrateWorkflow, patchWorkflowText, type ExecutionSnapshot } from "@nodeint/migent-kernel";
import { AgentToolRunner } from "../src/index.ts";
import { parseWorkflowMapping } from "@nodeint/migent-workflow";
import { publishNextSuggestions, resolveHandoff } from "@nodeint/migent-kernel";
import { createWorkflowSession } from "@nodeint/migent-kernel";
import { watchSnapshot } from "@nodeint/migent-kernel";
import { parseYamlDocument } from "@nodeint/migent-workflow";
import { ScriptedClient, SESSION_CONFIG, registryOf } from "./support.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "migent-v7-review-")));
  roots.push(dir);
  return dir;
}

function parse(text: string) {
  return parseWorkflowMapping(parseYamlDocument(text) as Record<string, unknown>, "t.yaml");
}

function dir(files: Record<string, string>): string {
  const base = root();
  const artifacts = path.join(base, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(artifacts, name), body);
  return artifacts;
}

function snap(stageId: string, order: number, artifactDirectory: string, decision: string | null = null, status = "completed"): ExecutionSnapshot {
  const execution = path.dirname(artifactDirectory);
  writeFileSync(path.join(execution, "response.md"), "status: complete\n");
  return {
    executionId: `e${order}`, stageId, executionOrder: order, status,
    outcomeStatus: status === "completed" ? "complete" : null, artifactDirectory, outcomeDecision: decision,
  };
}

const WORKSPACE = "/tmp/ws";

// Finding 1: an omitted downstream mapping passes every published artifact under its id.
test("omitted downstream artifacts pass every published output under its name", () => {
  const base = root();
  const workflows = path.join(base, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(base, ".migent", "config.yaml"), SESSION_CONFIG);
  writeFileSync(path.join(workflows, "plan.yaml"), `schema_version: 7
id: plan
artifacts:
  plan: { file: plan.md }
stages:
  - id: draft
    role: planner
    artifacts: [plan]
downstream:
  - workflow: implement
    task: Implement the plan
`);
  writeFileSync(path.join(workflows, "implement.yaml"), "schema_version: 7\nid: implement\nstages:\n  - { id: work, role: developer }\n");
  const prior = createWorkflowSession(base, "plan", "Plan");
  const directory = path.join(base, ".migent", "sessions", prior);
  mkdirSync(path.join(directory, "outputs"));
  writeFileSync(path.join(directory, "outputs", "plan.md"), "The plan\n");
  writeFileSync(path.join(directory, "status.json"), JSON.stringify({
    session_id: prior, workflow_id: "plan", status: "completed", outputs: { plan: { path: "outputs/plan.md" } },
  }));
  const published = publishNextSuggestions(base, prior);
  expect(published.next[0]?.artifacts).toEqual({ plan: { output: "plan", path: "outputs/plan.md" } });
  expect(Object.keys(resolveHandoff(base, "implement", prior)?.artifacts ?? {})).toEqual(["plan"]);
});

const ROUTED = `schema_version: 7
id: flow
artifacts:
  work: { file: work.md, description: The work product. }
  notes: { file: notes.md, required: false }
stages:
  - id: work
    role: developer
    artifacts: [work]
  - id: review
    role: reviewer
    depends_on: [work]
    verify: ["true"]
    decision:
      - approved:
          navigate: complete
          artifacts: [notes]
      - revise:
          navigate: work
`;

// Finding 2: route-back prompts never revive a completion a skip superseded.
test("a route back lists only the current eligible previous artifact", () => {
  const document = parse(`schema_version: 7
id: gated
artifacts:
  out: { file: out.md, required: false }
stages:
  - id: gate
    role: developer
    run_when: { changed_paths: ["src/**"] }
    artifacts: [out]
  - id: review
    role: reviewer
    depends_on: [gate]
    decision:
      - revise:
          navigate: gate
      - done:
          navigate: complete
`);
  const first = dir({ "out.md": "x" });
  const completed = snap("gate", 1, first);
  const reviewed = snap("review", 2, dir({}), "revise");
  const current = buildStagePrompt({ workflow: document, stageId: "gate", snapshots: [completed, reviewed], workspace: WORKSPACE });
  expect(current).toContain(path.join(first, "out.md"));
  // A later skip of gate supersedes its completion; the next revise round must not point at it.
  const skipped = { ...snap("gate", 3, dir({}), null, "skipped"), outcomeStatus: null };
  const revisedAgain = snap("review", 4, dir({}), "revise");
  const afterSkip = buildStagePrompt({ workflow: document, stageId: "gate", snapshots: [completed, reviewed, skipped, revisedAgain], workspace: WORKSPACE });
  expect(afterSkip).not.toContain(path.join(first, "out.md"));
});

// Findings 3 and 4: consumers see descriptions, and routed consumers get the router's verify report.
test("dependents and routed consumers receive descriptions and verify reports", () => {
  const document = parse(ROUTED);
  const workDir = dir({ "work.md": "work" });
  const reviewDir = dir({ "notes.md": "notes", "verify.md": "ok" });
  const snapshots = [snap("work", 1, workDir), snap("review", 2, reviewDir, "revise")];
  const prompt = buildStagePrompt({ workflow: document, stageId: "work", snapshots, workspace: WORKSPACE });
  // `work` is routed from `review`, which it is not a dependent of: its verify report must be listed.
  expect(prompt).toContain(`review verify report: \`${path.join(reviewDir, "verify.md")}\``);
  const review = buildStagePrompt({ workflow: document, stageId: "review", snapshots: [snapshots[0]!], workspace: WORKSPACE });
  expect(review).toContain(`work: \`${path.join(workDir, "work.md")}\` (The work product.)`);
});

test("a dependent sees the chosen decision's files and never an unselected decision's", () => {
  const document = parse(`${ROUTED}  - id: ship
    role: developer
    depends_on: [review]
`);
  const workDir = dir({ "work.md": "work" });
  const approvedDir = dir({ "notes.md": "notes", "verify.md": "ok" });
  const approved = [snap("work", 1, workDir), snap("review", 2, approvedDir, "approved")];
  const approvedPrompt = buildStagePrompt({ workflow: document, stageId: "ship", snapshots: approved, workspace: WORKSPACE });
  expect(approvedPrompt).toContain(path.join(approvedDir, "notes.md"));
  // The later revise round chose another decision: the earlier comments are not revived.
  const revised = [...approved, snap("review", 3, dir({ "verify.md": "ok" }), "revise")];
  const revisedPrompt = buildStagePrompt({ workflow: document, stageId: "ship", snapshots: revised, workspace: WORKSPACE });
  expect(revisedPrompt).not.toContain("notes.md");
});

// Finding 5: ambiguous ids are quoted so the text patch stays valid.
test("migration quotes artifact ids that YAML would read as null", () => {
  const text = `schema_version: 6
id: flow
stages:
  - id: plan
    role: planner
    produces:
      artifact: plan.md
outputs:
  - name: 'null'
    from_stage: plan
    artifact: plan.md
`;
  const raw = parseYamlDocument(text) as Record<string, unknown>;
  migrateWorkflow(raw, {});
  const patched = patchWorkflowText(text, raw);
  expect(patched).toContain('artifacts: ["null"]');
  expect(parse(patched).artifacts?.[0]?.id).toBe("null");
});

// Gate cases: multiple files, a missing chosen-decision artifact, and an unselected decision's absent file.
const GATED = `schema_version: 7
id: gated
artifacts:
  main: { file: main.md }
  extra: { file: extra.md }
  comments: { file: comments.md, required: false }
stages:
  - id: write
    role: planner
    artifacts: [main, extra]
    decision:
      - done:
          navigate: complete
          artifacts: [comments]
      - redo:
          navigate: write
          artifacts:
            findings: { file: findings.md }
`;

async function runGate(responses: string[], artifacts: Array<{ body: string; only: string[] }>) {
  const base = root();
  const workflows = path.join(base, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(base, ".migent", "config.yaml"), SESSION_CONFIG);
  writeFileSync(path.join(workflows, "gated.yaml"), GATED);
  const sessionId = createWorkflowSession(base, "gated", "Go");
  const client = new ScriptedClient(responses, artifacts);
  const result = await new AgentToolRunner(registryOf({ fake: client }), 10).run({
    client: "fake", model: "m1", prompt: "go", workspace: base, sessionId, stageId: "write",
  });
  const execution = JSON.parse(readFileSync(path.join(base, ".migent", "sessions", sessionId, "executions", result.execution_id, "execution.json"), "utf8")) as Record<string, unknown>;
  return { execution, client };
}

test("the gate requires every stage-level file", async () => {
  const { execution } = await runGate(["status: complete\ndecision: done\n\nok", "status: complete\ndecision: done\n\nok"], [{ body: "x", only: ["main.md"] }, { body: "x", only: ["main.md"] }]);
  expect(execution.status).toBe("failed");
  expect(String(execution.error)).toContain("extra.md");
});

test("the gate requires the chosen decision's required local file", async () => {
  const { execution } = await runGate(["status: complete\ndecision: redo\n\nok", "status: complete\ndecision: redo\n\nok"], [{ body: "x", only: ["main.md", "extra.md"] }, { body: "x", only: ["main.md", "extra.md"] }]);
  expect(execution.status).toBe("failed");
  expect(String(execution.error)).toContain("findings.md");
});

test("an unselected decision's absent file does not fail the gate", async () => {
  const { execution, client } = await runGate(["status: complete\ndecision: done\n\nok"], [{ body: "x", only: ["main.md", "extra.md"] }]);
  expect(execution.status).toBe("completed");
  // The producer prompt names each file with the decision that requires it.
  const prompt = client.calls[0]?.prompt ?? "";
  expect(prompt).toContain("`findings.md` (with `decision: redo`)");
  expect(prompt).toContain("`comments.md` (with `decision: done`) [optional]");
});

// Finding 7: session show lists absent optional artifacts as not produced.
test("watch snapshot reports optional artifacts that were not produced", () => {
  const base = root();
  const workflows = path.join(base, ".migent", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(base, ".migent", "config.yaml"), SESSION_CONFIG);
  writeFileSync(path.join(workflows, "gated.yaml"), GATED);
  const sessionId = createWorkflowSession(base, "gated", "Go");
  const directory = path.join(base, ".migent", "sessions", sessionId);
  expect(watchSnapshot(directory).outputs_not_produced).toEqual(["comments"]);
});
