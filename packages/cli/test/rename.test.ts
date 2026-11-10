import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { StageOutcome } from "@nodeint/migent-kernel";
import { SessionLock, SessionStore, createPreparedSession, createWorkflowSession } from "@nodeint/migent-session";
import { AgentToolRunner } from "@nodeint/migent-engine";
import { statusDriftMessage, readFoldedStatus } from "@nodeint/migent-session";
import { afterEach, expect, test } from "vitest";
import { main } from "../src/index.ts";
import { cliHooks } from "../src/hooks.ts";
import { ScriptedClient, capture, registryOf, removeWorkspace, writeFakeWorkflowWorkspace } from "./support.ts";

const workspaces: string[] = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) removeWorkspace(workspace);
});

function session(): { workspace: string; sessionId: string; directory: string } {
  const workspace = writeFakeWorkflowWorkspace({
    plan: "schema_version: 7\nid: plan\nstages:\n  - { id: draft, role: planner }\n",
  });
  workspaces.push(workspace);
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  return { workspace, sessionId, directory: path.join(workspace, ".migent", "sessions", sessionId) };
}

function snapshot(directory: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(directory)) {
    if (name === "title.json" || name.startsWith(".")) continue;
    try {
      out[name] = readFileSync(path.join(directory, name), "utf8");
    } catch {
      // directories are not compared
    }
  }
  return out;
}

test("rename prints text, shows in list and show, and changes only title.json", async () => {
  const { workspace, sessionId, directory } = session();
  const before = snapshot(directory);
  const result = await capture(() => main(["session", "rename", sessionId, "  Fresh title  "], workspace));
  expect(result.value).toBe(0);
  expect(result.stderr).toContain("Fresh title");
  expect(snapshot(directory)).toEqual(before);
  const list = await capture(() => main(["session", "list", "--latest", "--json"], workspace));
  expect(list.stdout).toContain("Fresh title");
  const show = await capture(() => main(["session", "show", sessionId, "--json"], workspace));
  expect(show.stdout).toContain("Fresh title");
  expect(statusDriftMessage(workspace, sessionId)).toBeNull();
  expect(readFoldedStatus(workspace, directory).title).toBe("Fresh title");
});

test("rename --json reports the previous title and works while the session lock is held", async () => {
  const { workspace, sessionId, directory } = session();
  const lock = SessionLock.acquire(directory);
  try {
    const first = await capture(() => main(["session", "rename", sessionId, "One", "--json"], workspace));
    expect(first.value).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ session_id: sessionId, title: "One" });
    const second = await capture(() => main(["session", "rename", sessionId, "Two", "--json"], workspace));
    expect(JSON.parse(second.stdout)).toEqual({ session_id: sessionId, title: "Two", previous_title: "One" });
  } finally {
    lock.release();
  }
});

test("rename rejects invalid titles without changing files", async () => {
  const { workspace, sessionId, directory } = session();
  const before = readdirSync(directory).sort();
  for (const title of ["", "   ", "a\nb", "a\n", "\nb", "a\r\nb"]) {
    const result = await capture(() => main(["session", "rename", sessionId, title], workspace));
    expect(result.value).toBe(2);
  }
  expect(readdirSync(directory).sort()).toEqual(before);
});

test("rename of an unknown session exits 2", async () => {
  const { workspace } = session();
  const result = await capture(() => main(["session", "rename", "999", "x"], workspace));
  expect(result.value).toBe(2);
});

test("a corrupt title record falls back to the creation title", async () => {
  const { workspace, sessionId, directory } = session();
  await capture(() => main(["session", "rename", sessionId, "Renamed"], workspace));
  writeFileSync(path.join(directory, "title.json"), "{nope", "utf8");
  const status = readFoldedStatus(workspace, directory);
  expect(status.title).toBe("Write a plan");
  const list = await capture(() => main(["session", "list", "--latest", "--json"], workspace));
  expect(list.stdout).toContain("Write a plan");
  expect(list.stdout).not.toContain("Renamed");
});

function allFiles(directory: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(directory, full)] = readFileSync(full, "utf8");
    }
  };
  walk(directory);
  return out;
}

function stopped(): { workspace: string; sessionId: string; directory: string } {
  const workspace = writeFakeWorkflowWorkspace({
    plan: "schema_version: 7\nid: plan\nartifacts:\n  plan: { file: plan.md }\nstages:\n  - { id: draft, role: planner, artifacts: [plan] }\n  - { id: extra, role: planner, depends_on: [draft] }\n",
  });
  workspaces.push(workspace);
  const sessionId = createWorkflowSession(workspace, "plan", "Write a plan");
  const directory = path.join(workspace, ".migent", "sessions", sessionId);
  const store = new SessionStore(workspace);
  const [record, , context] = store.loadOrCreate("fake", "model", {}, workspace, sessionId, "draft", null, null, "draft");
  const lock = SessionLock.acquire(directory);
  try {
    store.saveExecution(context, record, "running");
    writeFileSync(path.join(context.artifactDirectory, "plan.md"), "# Plan\n", "utf8");
    store.saveExecution(context, record, "completed", null, new StageOutcome("complete"));
  } finally {
    lock.release();
  }
  return { workspace, sessionId, directory };
}

test("rejected titles leave every file byte for byte unchanged", async () => {
  const { workspace, sessionId, directory } = stopped();
  const before = allFiles(directory);
  for (const title of ["", "  ", "a\nb", "a\n", "\nb"]) {
    expect((await capture(() => main(["session", "rename", sessionId, title], workspace))).value).toBe(2);
  }
  expect(allFiles(directory)).toEqual(before);
});

test("rename changes only title.json; readers see it while the lock is held; repair and continue persist it", async () => {
  const { workspace, sessionId, directory } = stopped();
  const before = allFiles(directory);
  const lock = SessionLock.acquire(directory);
  try {
    expect((await capture(() => main(["session", "rename", sessionId, "Live title"], workspace))).value).toBe(0);
    const list = await capture(() => main(["session", "list", "--latest", "--json"], workspace));
    expect(list.stdout).toContain("Live title");
    const show = await capture(() => main(["session", "show", sessionId, "--json"], workspace));
    expect(show.stdout).toContain("Live title");
    const follow = await capture(() => main(["session", "follow", sessionId, "--execution", "0001-draft--attempt-01", "--until", "--json"], workspace));
    expect(follow.stdout).toContain("Live title");
  } finally {
    lock.release();
  }
  const after = allFiles(directory);
  expect(Object.keys(after).sort()).toEqual([...Object.keys(before), "title.json"].sort());
  for (const [name, body] of Object.entries(before)) expect(after[name]).toBe(body);
  expect(JSON.parse(after["status.json"] as string).title).toBe("Write a plan");

  expect((await capture(() => main(["session", "repair", sessionId], workspace))).value).toBe(0);
  expect(JSON.parse(readFileSync(path.join(directory, "status.json"), "utf8")).title).toBe("Live title");
  expect(JSON.parse(readFileSync(path.join(directory, "title.json"), "utf8")).history).toHaveLength(1);

  cliHooks.runner = new AgentToolRunner(registryOf({ fake: new ScriptedClient(["status: complete\n\nextra done"]) }), 10);
  const continued = await capture(() => main(["session", "continue", sessionId, "--once"], workspace));
  expect(continued.value).toBe(0);
  expect(readdirSync(path.join(directory, "executions"))).toContain("0002-extra--attempt-01");
  const status = JSON.parse(readFileSync(path.join(directory, "status.json"), "utf8"));
  expect(status.latest_execution_id).toBe("0002-extra--attempt-01");
  expect(status.title).toBe("Live title");
  expect(status.task).toBe("Write a plan");
});

test("a folded renamed title does not survive a missing or multiline record", async () => {
  const { workspace, sessionId, directory } = stopped();
  await capture(() => main(["session", "rename", sessionId, "Renamed"], workspace));
  await capture(() => main(["session", "repair", sessionId], workspace));
  expect(JSON.parse(readFileSync(path.join(directory, "status.json"), "utf8")).title).toBe("Renamed");
  for (const body of [null, '{"title":"bad\\nmultiline","history":[]}']) {
    if (body === null) rmSync(path.join(directory, "title.json"));
    else writeFileSync(path.join(directory, "title.json"), body, "utf8");
    const list = await capture(() => main(["session", "list", "--latest", "--json"], workspace));
    expect(list.stdout).toContain("Write a plan");
    expect(list.stdout).not.toContain("Renamed");
    expect(list.stdout).not.toContain("multiline");
    const show = await capture(() => main(["session", "show", sessionId, "--json"], workspace));
    expect(show.stdout).not.toContain("Renamed");
    expect(statusDriftMessage(workspace, sessionId)).toBeNull();
  }
});

test("a titleless legacy manifest drops a stale cached title when the record is gone", async () => {
  const { workspace, sessionId, directory } = stopped();
  const manifestPath = path.join(directory, "manifest.yaml");
  writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace(/^title:.*\n/m, ""), "utf8");
  await capture(() => main(["session", "rename", sessionId, "Renamed"], workspace));
  await capture(() => main(["session", "repair", sessionId], workspace));
  rmSync(path.join(directory, "title.json"));
  const follow = await capture(() => main(["session", "follow", sessionId, "--execution", "0001-draft--attempt-01", "--until", "--json"], workspace));
  expect(follow.stdout).not.toContain("Renamed");
  expect(statusDriftMessage(workspace, sessionId)).toBeNull();
});

test("rename works on a prepared session and a later run still requires task.md", async () => {
  const workspace = writeFakeWorkflowWorkspace({
    plan: "schema_version: 7\nid: plan\nstages:\n  - { id: draft, role: planner }\n",
  });
  workspaces.push(workspace);
  const prepared = createPreparedSession(workspace, "Original", "plan");
  const sessionId = typeof prepared === "string" ? prepared : (prepared as { sessionId: string }).sessionId;
  expect((await capture(() => main(["session", "rename", sessionId, "Prepared new"], workspace))).value).toBe(0);
  const list = await capture(() => main(["session", "list", "--latest", "--json"], workspace));
  expect(list.stdout).toContain("Prepared new");
  const run = await capture(() => main(["session", "run", "--session", sessionId, "--once"], workspace));
  expect(run.value).toBe(2);
  expect(run.stderr).toContain("task.md");
});
