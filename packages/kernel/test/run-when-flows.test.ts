import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  AgentToolRunner,
  ConfigurationError,
  SessionStore,
  createWorkflowSession,
  executeNamedWorkflow,
} from "../src/index.ts";
import { repairSession } from "../src/session-repair.ts";
import { VerifyRunner } from "../src/verify-runner.ts";
import { ScriptedProvider, tempDir } from "./support.ts";

const CONFIG = `\
models:
  fake:
    provider: fake
    model: m1
roles:
  developer:
    default_model: fake
  reviewer:
    default_model: fake
`;

const DONE = "status: complete\n\ndone";
const REVISE = "status: complete\ndecision: revise\n\nagain";
const APPROVED = "status: complete\ndecision: approved\n\nok";

const RUN_WHEN = `    run_when:
      changed_paths:
        - "docs/**/*"
        - "**/README.md"
`;

const SIMPLE = `\
schema_version: 2
id: flow
stages:
  - id: implement
    role: developer
  - id: review_docs
    role: reviewer
    depends_on: [implement]
${RUN_WHEN}`;

const PARALLEL = `\
schema_version: 2
id: flow
concurrency: 2
stages:
  - id: implement
    role: developer
  - id: review_docs
    role: reviewer
    depends_on: [implement]
${RUN_WHEN}  - id: other
    role: developer
`;

const REVISION = `\
schema_version: 2
id: flow
stages:
  - id: implement
    role: developer
  - id: docs
    role: developer
    depends_on: [implement]
  - id: review_docs
    role: reviewer
    depends_on: [docs]
${RUN_WHEN}    decision:
      values: [approved, revise]
      routes:
        approved: complete
        revise: docs
  - id: final
    role: developer
    depends_on: [docs, review_docs]
`;

class EditingProvider extends ScriptedProvider {
  private hooks: Array<(() => void) | null>;

  constructor(responses: string[], hooks: Array<(() => void) | null>) {
    super(responses);
    this.hooks = [...hooks];
  }

  override parseResponse(): [string, string | null] {
    this.hooks.shift()?.();
    return super.parseResponse();
  }
}

class CountingVerifyRunner extends VerifyRunner {
  runs = 0;

  override async run(...args: Parameters<VerifyRunner["run"]>): ReturnType<VerifyRunner["run"]> {
    this.runs += 1;
    return super.run(...args);
  }
}

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdio: "ignore" },
  );
}

function workspaceFor(workflow: string): { repo: string; sessionId: string } {
  const repo = tempDir("migent-run-when-flows-");
  git(repo, "init", "-b", "main");
  writeFileSync(path.join(repo, ".gitignore"), ".migent/config.yaml\n.migent/workflows/\n");
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "initial");
  mkdirSync(path.join(repo, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(repo, ".migent", "config.yaml"), CONFIG, "utf8");
  writeFileSync(path.join(repo, ".migent", "workflows", "flow.yaml"), workflow, "utf8");
  return { repo, sessionId: createWorkflowSession(repo, "flow", "Do it") };
}

function write(repo: string, relative: string, body: string): () => void {
  return () => {
    mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
    writeFileSync(path.join(repo, relative), body, "utf8");
  };
}

function remove(repo: string, relative: string): () => void {
  return () => rmSync(path.join(repo, relative), { force: true });
}

function eventNames(repo: string, sessionId: string): string[] {
  const text = readFileSync(path.join(repo, ".migent", "sessions", sessionId, "events.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => (JSON.parse(line) as { event: string }).event);
}

function statuses(repo: string, sessionId: string, stageId: string): string[] {
  return new SessionStore(repo)
    .executionSnapshots(sessionId)
    .filter((item) => item.stageId === stageId)
    .sort((left, right) => left.executionOrder - right.executionOrder)
    .map((item) => item.status);
}

test("a skip never runs verify, and repair restores a missing execution.skipped event", async () => {
  const { repo, sessionId } = workspaceFor(SIMPLE);
  const verifyRunner = new CountingVerifyRunner();
  const provider = new EditingProvider([DONE], [write(repo, "src/x.ts", "x\n")]);
  const runner = new AgentToolRunner({ fake: provider }, 10, verifyRunner);
  const result = await executeNamedWorkflow(repo, { workflowId: "flow", sessionId }, runner);
  expect(result.status).toBe("completed");
  expect(verifyRunner.runs).toBe(0);
  expect(provider.calls).toHaveLength(1);

  const eventsPath = path.join(repo, ".migent", "sessions", sessionId, "events.jsonl");
  const lines = readFileSync(eventsPath, "utf8").split("\n");
  writeFileSync(eventsPath, lines.filter((line) => !line.includes('"execution.skipped"')).join("\n"), "utf8");
  expect(eventNames(repo, sessionId)).not.toContain("execution.skipped");
  repairSession(repo, sessionId);
  const names = eventNames(repo, sessionId);
  expect(names.filter((name) => name === "execution.skipped")).toHaveLength(1);
  expect(statuses(repo, sessionId, "review_docs")).toEqual(["skipped"]);
});

test("--stage is rejected after a skip", async () => {
  const { repo, sessionId } = workspaceFor(PARALLEL);
  const provider = new EditingProvider([DONE, DONE], [write(repo, "src/x.ts", "x\n")]);
  const runner = new AgentToolRunner({ fake: provider }, 10);
  const first = await executeNamedWorkflow(repo, { workflowId: "flow", sessionId, once: true }, runner);
  expect(first.stopReason).toBe("stage");
  const second = await executeNamedWorkflow(repo, { workflowId: "flow", sessionId, once: true }, runner);
  expect(second.code).toBe(0);
  expect(statuses(repo, sessionId, "review_docs")).toEqual(["skipped"]);
  const stage = executeNamedWorkflow(repo, { workflowId: "flow", sessionId, stageId: "review_docs", once: true }, runner);
  await expect(stage).rejects.toThrow(ConfigurationError);
  await expect(stage).rejects.toThrow(/review_docs/);
  expect(statuses(repo, sessionId, "review_docs")).toEqual(["skipped"]);
});

test("--max-dispatches 1 counts a skip as one dispatch", async () => {
  const { repo, sessionId } = workspaceFor(SIMPLE);
  const provider = new EditingProvider([DONE], [write(repo, "src/x.ts", "x\n")]);
  const runner = new AgentToolRunner({ fake: provider }, 10);
  const first = await executeNamedWorkflow(repo, { workflowId: "flow", sessionId, maxDispatches: 1 }, runner);
  expect(first.stopReason).toBe("dispatch_limit");
  expect(provider.calls).toHaveLength(1);
  const second = await executeNamedWorkflow(repo, { workflowId: "flow", sessionId, maxDispatches: 1 }, runner);
  expect(second.stages).toHaveLength(1);
  expect(second.stages[0]).toMatchObject({ execution_status: "skipped" });
  expect(second.status).toBe("completed");
  expect(provider.calls).toHaveLength(1);
  expect(statuses(repo, sessionId, "review_docs")).toEqual(["skipped"]);
});

test("a skip and a provider stage coexist at concurrency 2", async () => {
  const { repo, sessionId } = workspaceFor(PARALLEL);
  const provider = new EditingProvider([DONE, DONE], [write(repo, "src/x.ts", "x\n")]);
  const runner = new AgentToolRunner({ fake: provider }, 10);
  const result = await executeNamedWorkflow(repo, { workflowId: "flow", sessionId }, runner);
  expect(result.status).toBe("completed");
  expect(provider.calls).toHaveLength(2);
  expect(statuses(repo, sessionId, "review_docs")).toEqual(["skipped"]);
  expect(statuses(repo, sessionId, "other")).toEqual(["completed"]);
});

test("the baseline survives a blocked stage and its reply", async () => {
  const { repo, sessionId } = workspaceFor(SIMPLE);
  const provider = new EditingProvider(
    ["status: blocked\nblocker: need input\n\nnope", DONE],
    [write(repo, "src/x.ts", "x\n"), null],
  );
  const runner = new AgentToolRunner({ fake: provider }, 10);
  const first = await executeNamedWorkflow(repo, { workflowId: "flow", sessionId }, runner);
  expect(first.status).toBe("blocked");
  const second = await executeNamedWorkflow(
    repo,
    { workflowId: "flow", sessionId, stageId: "implement", reply: "here" },
    runner,
  );
  expect(second.status).toBe("active");
  const third = await executeNamedWorkflow(repo, { workflowId: "flow", sessionId }, runner);
  expect(third.status).toBe("completed");
  expect(eventNames(repo, sessionId).filter((name) => name === "baseline.captured")).toHaveLength(1);
  expect(statuses(repo, sessionId, "review_docs")).toEqual(["skipped"]);
});

test("a re-evaluated review is skipped when the changed path was restored, and final stays undispatched", async () => {
  const { repo, sessionId } = workspaceFor(REVISION);
  const provider = new EditingProvider(
    [DONE, DONE, REVISE, DONE],
    [null, write(repo, "README.md", "readme\n"), null, remove(repo, "README.md")],
  );
  const runner = new AgentToolRunner({ fake: provider }, 10);
  const result = await executeNamedWorkflow(repo, { workflowId: "flow", sessionId }, runner);
  expect(result.status).toBe("completed");
  expect(provider.calls).toHaveLength(4);
  expect(statuses(repo, sessionId, "review_docs")).toEqual(["completed", "skipped"]);
  expect(statuses(repo, sessionId, "docs")).toEqual(["completed", "completed"]);
  expect(statuses(repo, sessionId, "final")).toEqual([]);
  expect(eventNames(repo, sessionId).filter((name) => name === "baseline.captured")).toHaveLength(1);
  const again = await executeNamedWorkflow(repo, { workflowId: "flow", sessionId }, runner);
  expect(again.status).toBe("completed");
  expect(statuses(repo, sessionId, "review_docs")).toEqual(["completed", "skipped"]);
});

test("a re-evaluated review runs again while the changed path is still there", async () => {
  const { repo, sessionId } = workspaceFor(REVISION);
  const provider = new EditingProvider(
    [DONE, DONE, REVISE, DONE, APPROVED, DONE],
    [null, write(repo, "README.md", "readme\n")],
  );
  const runner = new AgentToolRunner({ fake: provider }, 10);
  const result = await executeNamedWorkflow(repo, { workflowId: "flow", sessionId }, runner);
  expect(result.status).toBe("completed");
  expect(statuses(repo, sessionId, "review_docs")).toEqual(["completed", "completed"]);
  expect(statuses(repo, sessionId, "final")).toEqual(["completed"]);
});
