import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import {
  AgentToolRunner,
  SessionStore,
  createWorkflowSession,
  executeNamedWorkflow,
  readFoldedStatus,
  sessionMetrics,
  statusDriftMessage,
  watchSnapshot,
} from "../src/index.ts";
import { loadFrozenWorkflow } from "../src/session-freeze.ts";
import { ScriptedProvider, tempDir } from "./support.ts";

// Git setup and wrapper/provider process startup can exceed 10 seconds on Windows CI.
vi.setConfig({ testTimeout: 60_000 });

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

const WORKFLOW = `\
schema_version: 2
id: flow
stages:
  - id: implement
    role: developer
    produces:
      artifact: impl.md
  - id: review_docs
    role: reviewer
    depends_on: [implement]
    run_when:
      changed_paths:
        - "docs/**/*"
        - "**/README.md"
outputs:
  - name: impl
    from_stage: implement
    artifact: impl.md
`;

const DONE = "status: complete\n\ndone";

/** Runs each hook when the matching provider call is parsed, so a test can edit files mid-session. */
class EditingProvider extends ScriptedProvider {
  private hooks: Array<() => void>;

  constructor(responses: string[], artifacts: Array<string | null>, hooks: Array<() => void>) {
    super(responses, artifacts);
    this.hooks = [...hooks];
  }

  override parseResponse(): [string, string | null] {
    const hook = this.hooks.shift();
    if (hook !== undefined) hook();
    return super.parseResponse();
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
}

function workspace(): { repo: string; sessionId: string; base: string } {
  const repo = tempDir("migent-run-when-session-");
  git(repo, "init", "-b", "main");
  writeFileSync(path.join(repo, ".gitignore"), ".migent/config.yaml\n.migent/workflows/\n");
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "initial");
  mkdirSync(path.join(repo, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(repo, ".migent", "config.yaml"), CONFIG, "utf8");
  writeFileSync(path.join(repo, ".migent", "workflows", "flow.yaml"), WORKFLOW, "utf8");
  const sessionId = createWorkflowSession(repo, "flow", "Do it");
  return { repo, sessionId, base: git(repo, "rev-parse", "HEAD") };
}

function write(repo: string, relative: string, body: string): () => void {
  return () => {
    mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
    writeFileSync(path.join(repo, relative), body, "utf8");
  };
}

function runner(provider: ScriptedProvider): AgentToolRunner {
  return new AgentToolRunner({ fake: provider }, 10);
}

function eventNames(repo: string, sessionId: string): string[] {
  const text = readFileSync(path.join(repo, ".migent", "sessions", sessionId, "events.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => (JSON.parse(line) as { event: string }).event);
}

test("a stage whose paths did not change is skipped and the session completes", async () => {
  const { repo, sessionId, base } = workspace();
  const provider = new EditingProvider([DONE], ["# impl\n"], [write(repo, "src/x.ts", "x\n")]);
  const result = await executeNamedWorkflow(repo, { workflowId: "flow", sessionId }, runner(provider));
  expect(result.code).toBe(0);
  expect(result.stopReason).toBe("completed");
  expect(result.status).toBe("completed");
  expect(provider.calls).toHaveLength(1);
  const snapshots = new SessionStore(repo).executionSnapshots(sessionId);
  expect(snapshots.map((item) => [item.stageId, item.status])).toEqual([
    ["implement", "completed"],
    ["review_docs", "skipped"],
  ]);
  const skipped = snapshots.find((item) => item.status === "skipped")!;
  const record = JSON.parse(readFileSync(path.join(path.dirname(skipped.artifactDirectory), "execution.json"), "utf8"));
  expect(record).toMatchObject({
    kind: "skip",
    status: "skipped",
    provider: null,
    skip: {
      reason: "no changed path matches run_when.changed_paths",
      baseline: base,
      patterns: ["docs/**/*", "**/README.md"],
      changed_paths: 1,
    },
  });
  expect(Object.keys(result.outputs)).toEqual(["impl"]);

  const status = readFoldedStatus(repo, path.join(repo, ".migent", "sessions", sessionId));
  expect(status.baseline).toMatchObject({ commit: base });
  expect(status.skipped_stages).toEqual([{ stage_id: "review_docs", execution_id: skipped.executionId }]);
  expect(statusDriftMessage(repo, sessionId)).toBeNull();
  const snapshot = watchSnapshot(path.join(repo, ".migent", "sessions", sessionId));
  expect(snapshot.skipped_stages).toEqual(status.skipped_stages);
  expect(snapshot.baseline).toMatchObject({ commit: base });

  const metrics = sessionMetrics(repo, sessionId, { fake: provider });
  expect(metrics.totals).toMatchObject({ executions: 1, skipped: 1 });
  expect((metrics.stages as Record<string, unknown>).review_docs).toMatchObject({ executions: 0, skipped: 1 });
  const row = (metrics.executions as Array<Record<string, unknown>>).find((item) => item.status === "skipped")!;
  expect(row).toMatchObject({ provider: null, model: null, turns: 0, verify: null });
  expect(row.skip).toMatchObject({ baseline: base });

  const frozen = loadFrozenWorkflow(path.join(repo, ".migent", "sessions", sessionId));
  expect(frozen?.stages.review_docs?.runWhen).toEqual({ changedPaths: ["docs/**/*", "**/README.md"] });

  const again = await executeNamedWorkflow(repo, { workflowId: "flow", sessionId }, runner(provider));
  expect(again.status).toBe("completed");
  expect(new SessionStore(repo).executionSnapshots(sessionId)).toHaveLength(2);
  const names = eventNames(repo, sessionId);
  expect(names.filter((name) => name === "execution.skipped")).toHaveLength(1);
  expect(names.filter((name) => name === "baseline.captured")).toHaveLength(1);
});

test("a stage whose paths changed runs", async () => {
  const { repo, sessionId } = workspace();
  const provider = new EditingProvider([DONE, DONE], ["# impl\n", null], [write(repo, "docs/a.md", "doc\n")]);
  const result = await executeNamedWorkflow(repo, { workflowId: "flow", sessionId }, runner(provider));
  expect(result.status).toBe("completed");
  expect(provider.calls).toHaveLength(2);
  expect(new SessionStore(repo).executionSnapshots(sessionId).map((item) => item.status)).toEqual([
    "completed",
    "completed",
  ]);
});

test("the root README alone matches the OR pattern", async () => {
  const { repo, sessionId } = workspace();
  const provider = new EditingProvider([DONE, DONE], ["# impl\n", null], [write(repo, "README.md", "root\n")]);
  await executeNamedWorkflow(repo, { workflowId: "flow", sessionId }, runner(provider));
  expect(provider.calls).toHaveLength(2);
});

test("a committed change also matches, and the baseline stays at the first dispatch", async () => {
  const { repo, sessionId, base } = workspace();
  const commit = () => {
    write(repo, "docs/committed.md", "c\n")();
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "doc");
  };
  const provider = new EditingProvider([DONE, DONE], ["# impl\n", null], [commit]);
  await executeNamedWorkflow(repo, { workflowId: "flow", sessionId }, runner(provider));
  expect(provider.calls).toHaveLength(2);
  const status = readFoldedStatus(repo, path.join(repo, ".migent", "sessions", sessionId));
  expect(status.baseline).toMatchObject({ commit: base });
});

test("--once exits 0 on a skip", async () => {
  const { repo, sessionId } = workspace();
  const provider = new EditingProvider([DONE], ["# impl\n"], [write(repo, "src/x.ts", "x\n")]);
  const first = await executeNamedWorkflow(repo, { workflowId: "flow", sessionId, once: true }, runner(provider));
  expect(first.stopReason).toBe("stage");
  const second = await executeNamedWorkflow(repo, { workflowId: "flow", sessionId, once: true }, runner(provider));
  expect(second.code).toBe(0);
  expect(second.stages[0]).toMatchObject({ execution_status: "skipped" });
  expect(second.status).toBe("completed");
});

test("a Git failure stops the command without a skip and recovers once Git is back", async () => {
  const { repo, sessionId } = workspace();
  const away = path.join(repo, ".git-away");
  const hide = () => renameSync(path.join(repo, ".git"), away);
  const provider = new EditingProvider([DONE], ["# impl\n"], [hide]);
  await expect(executeNamedWorkflow(repo, { workflowId: "flow", sessionId }, runner(provider))).rejects.toThrow(
    /stages\.review_docs\.run_when: the workspace is not in a Git work tree/,
  );
  const store = new SessionStore(repo);
  expect(store.executionSnapshots(sessionId).map((item) => item.stageId)).toEqual(["implement"]);
  expect(store.readSessionStatus(sessionId).status).toBe("active");
  expect(provider.calls).toHaveLength(1);
  renameSync(away, path.join(repo, ".git"));
  const result = await executeNamedWorkflow(repo, { workflowId: "flow", sessionId }, runner(provider));
  expect(result.status).toBe("completed");
  expect(store.executionSnapshots(sessionId).map((item) => item.status)).toEqual(["completed", "skipped"]);
  rmSync(away, { recursive: true, force: true });
});

test("a run_when workflow in a non-Git workspace fails before any execution", async () => {
  const repo = tempDir("migent-run-when-nogit-session-");
  mkdirSync(path.join(repo, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(repo, ".migent", "config.yaml"), CONFIG, "utf8");
  writeFileSync(path.join(repo, ".migent", "workflows", "flow.yaml"), WORKFLOW, "utf8");
  const sessionId = createWorkflowSession(repo, "flow", "Do it");
  const provider = new EditingProvider([DONE], ["# impl\n"], []);
  await expect(executeNamedWorkflow(repo, { workflowId: "flow", sessionId }, runner(provider))).rejects.toThrow(
    new RegExp(`^Session ${sessionId} needs a Git commit for run_when: `),
  );
  expect(new SessionStore(repo).executionSnapshots(sessionId)).toEqual([]);
  expect(provider.calls).toHaveLength(0);
});

const TRANSITIVE = `\
schema_version: 2
id: flow
stages:
  - id: implement
    role: developer
    decision:
      values: [done, again]
      routes:
        done: B
        again: B
  - id: B
    role: developer
    depends_on: [implement]
    run_when:
      changed_paths: ["docs/**/*"]
  - id: C
    role: developer
    depends_on: [B]
  - id: E
    role: developer
    depends_on: [implement]
  - id: D
    role: developer
    depends_on: [C, E]
  - id: check
    role: reviewer
    depends_on: [D]
    decision:
      values: [approved, revise]
      routes:
        approved: complete
        revise: implement
`;

test("a skip stops the transitive downstream stages that completed before it", async () => {
  const { repo } = workspace();
  writeFileSync(path.join(repo, ".migent", "workflows", "flow.yaml"), TRANSITIVE, "utf8");
  const sessionId = createWorkflowSession(repo, "flow", "Do it");
  const docs = path.join(repo, "docs", "x.md");
  const restore = () => rmSync(docs, { force: true });
  const provider = new EditingProvider(
    [
      "status: complete\ndecision: done\n\nok", // implement
      DONE, // B
      DONE, // C
      DONE, // E
      DONE, // D
      "status: complete\ndecision: revise\n\nrevise", // check
      "status: complete\ndecision: done\n\nok", // implement again
      DONE, // E again
    ],
    [],
    [write(repo, "docs/x.md", "doc\n"), () => {}, () => {}, () => {}, () => {}, () => {}, restore],
  );
  const result = await executeNamedWorkflow(repo, { workflowId: "flow", sessionId }, runner(provider));
  expect(result.status).toBe("completed");
  const snapshots = new SessionStore(repo).executionSnapshots(sessionId);
  const order = snapshots.map((item) => `${item.stageId}:${item.status}`);
  const skipIndex = order.indexOf("B:skipped");
  expect(skipIndex).toBeGreaterThan(0);
  const after = order.slice(skipIndex + 1);
  expect(after.some((entry) => entry.startsWith("C:") || entry.startsWith("D:") || entry.startsWith("check:"))).toBe(
    false,
  );
  const status = readFoldedStatus(repo, path.join(repo, ".migent", "sessions", sessionId));
  expect(status.skipped_stages).toEqual([expect.objectContaining({ stage_id: "B" })]);
});
