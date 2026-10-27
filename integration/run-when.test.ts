import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  COMPLETE,
  GROK_CONFIG,
  asRecord,
  asRecords,
  installScript,
  providerInvocations,
  removeWorkspace,
  runMain,
  tempWorkspace,
  writeWorkspace,
} from "./support.ts";

const DOCS_FLOW = `\
schema_version: 2
id: docs_flow
stages:
  - id: implement
    role: planner
    produces:
      artifact: implementation.md
  - id: review_docs
    role: reviewer
    depends_on: [implement]
    run_when:
      changed_paths:
        - "docs/**/*"
        - "**/README.md"
outputs:
  - name: implementation
    from_stage: implement
    artifact: implementation.md
`;

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdio: "ignore" },
  );
}

function gitWorkspace(): string {
  const workspace = tempWorkspace();
  writeWorkspace(workspace, GROK_CONFIG, { docs_flow: DOCS_FLOW });
  writeFileSync(path.join(workspace, ".gitignore"), ".migent/config.yaml\n.migent/workflows/\n.migent-fake*\n");
  writeFileSync(path.join(workspace, "a.txt"), "a\n");
  git(workspace, "init", "-b", "main");
  git(workspace, "add", "-A");
  git(workspace, "commit", "-m", "initial");
  return workspace;
}

test("a stage with no matching change is skipped and shows in show and metrics", async () => {
  const workspace = gitWorkspace();
  try {
    installScript(workspace, [{ text: COMPLETE, write_files: { "src/x.ts": "x\n" } }]);
    const [code, objects, stderr] = await runMain(workspace, ["session", "run", "--workflow", "docs_flow", "--task", "Change code"]);
    expect(code, stderr).toBe(0);
    const result = objects[0] ?? {};
    expect(result.stop_reason).toBe("completed");
    const sessionId = String(result.session_id);
    expect(providerInvocations(workspace)).toHaveLength(1);

    const [showCode, shown] = await runMain(workspace, ["session", "show", sessionId, "--json"]);
    expect(showCode).toBe(0);
    const snapshot = shown[0] ?? {};
    expect(asRecords(snapshot.skipped_stages).map((item) => item.stage_id)).toEqual(["review_docs"]);
    expect(String(asRecord(snapshot.baseline).commit)).toMatch(/^[0-9a-f]{40}$/);

    const [metricsCode, metrics] = await runMain(workspace, ["session", "metrics", sessionId, "--json"]);
    expect(metricsCode).toBe(0);
    const totals = asRecord((metrics[0] ?? {}).totals);
    expect(totals.skipped).toBe(1);
    expect(totals.executions).toBe(1);
    const row = asRecords((metrics[0] ?? {}).executions).find((item) => item.status === "skipped");
    expect(row).toMatchObject({ turns: 0, provider: null, model: null });
  } finally {
    removeWorkspace(workspace);
  }
}, 60_000);

test("a documentation change makes the stage run", async () => {
  const workspace = gitWorkspace();
  try {
    installScript(workspace, [
      { text: COMPLETE, write_files: { "docs/guide.md": "guide\n" } },
      { text: COMPLETE },
    ]);
    const [code, objects, stderr] = await runMain(workspace, ["session", "run", "--workflow", "docs_flow", "--task", "Change docs"]);
    expect(code, stderr).toBe(0);
    expect((objects[0] ?? {}).stop_reason).toBe("completed");
    expect(providerInvocations(workspace)).toHaveLength(2);
  } finally {
    removeWorkspace(workspace);
  }
}, 60_000);

test("doctor reports an invalid run_when pattern as a workflow problem", async () => {
  const workspace = tempWorkspace();
  try {
    writeWorkspace(workspace, GROK_CONFIG, {
      docs_flow: DOCS_FLOW.replace('"docs/**/*"', '"docs/"'),
    });
    const [code, , stderr] = await runMain(workspace, ["doctor"]);
    expect(code).not.toBe(0);
    expect(stderr + JSON.stringify(await runMain(workspace, ["doctor", "--json"]))).toContain(
      "stages.review_docs.run_when.changed_paths[0]: 'docs/' (use dir/**)",
    );
  } finally {
    removeWorkspace(workspace);
  }
}, 60_000);
