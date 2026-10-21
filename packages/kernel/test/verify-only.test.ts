import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { AgentToolRunner, executeNamedWorkflow, loadWorkflowDocument } from "../src/index.ts";
import { ScriptedAdapter, tempDir } from "./support.ts";

const CONFIG = `\
models:
  fake:
    provider: fake
    model: m1
roles:
  developer:
    default_model: fake
`;

const OK = "status: complete\n\ndone";

function setup(commands: string[]): { workspace: string } {
  const workspace = tempDir("migent-verify-only-");
  mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), CONFIG, "utf8");
  writeFileSync(
    path.join(workspace, ".migent", "workflows", "wf.yaml"),
    `\
schema_version: 2
id: wf
stages:
  - id: prepare
    description: Check the tree.
    verify:
${commands.map((item) => `      - ${JSON.stringify(item)}\n`).join("")}    depends_on: []
  - id: implement
    role: developer
    depends_on: [prepare]
    produces:
      artifact: notes.md
outputs:
  - name: notes
    from_stage: implement
    artifact: notes.md
`,
    "utf8",
  );
  return { workspace };
}

function execution(workspace: string, sessionId: string, executionId: string): Record<string, unknown> {
  const file = path.join(workspace, ".migent", "sessions", sessionId, "executions", executionId, "execution.json");
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

test("a passing verify-only stage publishes verify.md and then starts the role stage", async () => {
  const { workspace } = setup([`node -e "process.exit(0)"`]);
  const adapter = new ScriptedAdapter([OK], ["# notes\n"]);
  const runner = new AgentToolRunner({ fake: adapter }, 10);
  const result = await executeNamedWorkflow(workspace, { workflowId: "wf", task: "go" }, runner);
  expect(result.code).toBe(0);
  expect(result.status).toBe("completed");
  expect(adapter.calls).toHaveLength(1);
  const session = result.sessionId;
  const executions = path.join(workspace, ".migent", "sessions", session, "executions");
  const names = readFileSync(path.join(executions, "0001-prepare--attempt-01", "execution.json"), "utf8");
  const prepare = JSON.parse(names) as Record<string, unknown>;
  expect(prepare.kind).toBe("verify");
  expect(prepare.provider).toBeNull();
  expect(prepare.status).toBe("completed");
  expect(existsSync(path.join(executions, "0001-prepare--attempt-01", "prompt.md"))).toBe(false);
  expect(existsSync(path.join(executions, "0001-prepare--attempt-01", "artifacts", "verify.md"))).toBe(true);
  expect(adapter.calls[0]?.prompt).toContain("prepare verify:");
  const document = loadWorkflowDocument(path.join(workspace, ".migent", "workflows", "wf.yaml"));
  expect(document.stages.prepare?.kind).toBe("verify");
});

test("a red verify-only stage exits 7 and does not start the role stage", async () => {
  const { workspace } = setup([
    `node -e "process.exit(0)"`,
    `node -e "console.error('red'); process.exit(1)"`,
    `node -e "process.exit(2)"`,
  ]);
  const adapter = new ScriptedAdapter([OK], ["# notes\n"]);
  const runner = new AgentToolRunner({ fake: adapter }, 10);
  const result = await executeNamedWorkflow(workspace, { workflowId: "wf", task: "go" }, runner);
  expect(result.code).toBe(7);
  expect(result.stopReason).toBe("verify_failed");
  expect(result.status).toBe("active");
  expect(adapter.calls).toHaveLength(0);
  const record = execution(workspace, result.sessionId, "0001-prepare--attempt-01");
  expect(record.failure_reason).toBe("verify_failed");
  expect(record.status).toBe("failed");
  const report = readFileSync(
    path.join(workspace, ".migent", "sessions", result.sessionId, "executions", "0001-prepare--attempt-01", "turns", "01", "verify.md"),
    "utf8",
  );
  expect(report).toContain("[pass]");
  expect(report).toContain("[fail]");
  expect(report).toContain("[skipped]");
  expect(existsSync(path.join(workspace, ".migent", "sessions", result.sessionId, "executions", "0002-implement--attempt-01"))).toBe(
    false,
  );
});

test("continue after a red verify-only stage reruns verify and then starts the role", async () => {
  const workspace = tempDir("migent-verify-only-continue-");
  mkdirSync(workspace, { recursive: true });
  const script = path.join(workspace, "gate.cjs");
  const count = path.join(workspace, "count");
  writeFileSync(
    script,
    `const fs=require("fs");const f=${JSON.stringify(count)};const n=fs.existsSync(f)?Number(fs.readFileSync(f,"utf8")):0;fs.writeFileSync(f,String(n+1));if(n<1)process.exit(1);`,
    "utf8",
  );
  const command = `"${process.execPath}" "${script}"`;
  mkdirSync(path.join(workspace, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(workspace, ".migent", "config.yaml"), CONFIG, "utf8");
  writeFileSync(
    path.join(workspace, ".migent", "workflows", "wf.yaml"),
    `\
schema_version: 2
id: wf
stages:
  - id: prepare
    verify:
      - ${JSON.stringify(command)}
    depends_on: []
  - id: implement
    role: developer
    depends_on: [prepare]
    produces:
      artifact: notes.md
outputs:
  - name: notes
    from_stage: implement
    artifact: notes.md
`,
    "utf8",
  );
  const adapter = new ScriptedAdapter([OK], ["# notes\n"]);
  const runner = new AgentToolRunner({ fake: adapter }, 10);
  const failed = await executeNamedWorkflow(workspace, { workflowId: "wf", task: "go" }, runner);
  expect(failed.code).toBe(7);
  expect(adapter.calls).toHaveLength(0);
  const continued = await executeNamedWorkflow(workspace, { sessionId: failed.sessionId, resetRevisions: true }, runner);
  expect(continued.code).toBe(0);
  expect(adapter.calls).toHaveLength(1);
  expect(existsSync(path.join(workspace, ".migent", "sessions", failed.sessionId, "executions", "0002-prepare--attempt-02"))).toBe(
    true,
  );
});
