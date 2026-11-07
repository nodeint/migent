import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SessionLock,
  AgentToolRunner,
  appendLifecycleEvent,
  activatePreparedSession,
  createPreparedSession,
  executeNamedWorkflow,
  sha256Hex,
} from "@nodeint/migent-kernel";
import { afterEach, beforeEach, expect, test } from "vitest";
import { main } from "../src/index.ts";
import { setInvocationCwd } from "../src/workspace.ts";
import { capture, FakeClient, registryOf } from "./support.ts";

const CONFIG = `schema_version: 6
agents:
  fast:
    client:
      type: grok
    model: grok-4.6
roles:
  developer:
    agent: fast
`;

const WORKFLOW = `schema_version: 6
id: build
stages:
  - id: implement
    role: developer
    depends_on: []
`;

const EDITED = `${WORKFLOW}  - id: verify
    role: developer
    depends_on:
      - implement
`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "migent-authoring-session-"));
  mkdirSync(path.join(root, ".migent", "workflows"), { recursive: true });
  writeFileSync(path.join(root, ".migent", "config.yaml"), CONFIG);
  writeFileSync(path.join(root, ".migent", "workflows", "build.yaml"), WORKFLOW);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function run(argv: string[], stdin?: string) {
  const draft = stdin === undefined ? null : path.join(root, "draft.in");
  if (draft !== null) writeFileSync(draft, stdin);
  const args = argv.map((arg) => (arg === "@draft" ? draft! : arg));
  const result = await capture(() => main(args, root));
  const lastLine = result.stdout.trim();
  return { code: result.value as number, out: result.stdout, json: lastLine.startsWith("{") ? JSON.parse(lastLine) : null };
}

const sessionDir = (id: string): string => path.join(root, ".migent", "sessions", id);
const draftFile = (id: string): string => path.join(sessionDir(id), "workflow.yaml");
const draftLabel = (id: string): string => `.migent/sessions/${id}/workflow.yaml`;
const read = (file: string): string => readFileSync(file, "utf8");
const codes = (json: { diagnostics: { code: string }[] }): string[] => json.diagnostics.map((item) => item.code);

function prepare(): string {
  return createPreparedSession(root, "Session task", "build");
}

/** Prepared session whose task is filled in and that was then started: it owns a freeze. */
function startedSession(): string {
  const id = prepare();
  writeFileSync(path.join(sessionDir(id), "task.md"), "do the work\n");
  activatePreparedSession(root, id);
  return id;
}

function snapshot(id: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(sessionDir(id)).sort()) {
    if (name === "workflow.yaml" || name === "session.lock") continue;
    const file = path.join(sessionDir(id), name);
    try {
      out[name] = read(file);
    } catch {
      out[name] = "<dir>";
    }
  }
  return out;
}

test("validate, render and save work on a prepared session draft, from stdin and from a file", async () => {
  const id = prepare();
  const before = read(draftFile(id));
  const file = path.join(root, "edited.yaml");
  writeFileSync(file, EDITED);
  const fromFile = await run(["workflow", "validate", file, "--session", id, "--json"]);
  expect(fromFile.code).toBe(0);
  expect(fromFile.json).toMatchObject({ command: "workflow.validate", valid: true });

  const rendered = await run(["workflow", "render", file, "--session", id, "--json"]);
  expect(rendered.code).toBe(0);
  expect(rendered.json.rendered).toBe(EDITED);
  expect(read(draftFile(id))).toBe(before);

  const saved = await run(["workflow", "save", file, "--session", id, "--base-hash", sha256Hex(before), "--json"]);
  expect(saved.code).toBe(0);
  expect(saved.json).toMatchObject({ written: true, file: draftLabel(id), hash: sha256Hex(EDITED) });
  expect(read(draftFile(id))).toBe(EDITED);
});

test("stdin input goes through the same path", async () => {
  const id = prepare();
  const draft = read(draftFile(id));
  const stdin = async (mode: string, extra: string[] = []) => {
    setInvocationCwd(root);
    const result = await capture(async () => {
      const { runAuthoring } = await import("../src/commands/authoring.ts");
      return runAuthoring({ kind: "workflow", mode: mode as "validate", draft: "-", format: "yaml", session: id, asJson: true, readStdin: () => EDITED, ...(extra.length > 0 ? { baseHash: extra[0]! } : {}) });
    });
    return { code: result.value as number, json: JSON.parse(result.stdout.trim()) };
  };
  expect((await stdin("validate")).code).toBe(0);
  expect((await stdin("render")).json.rendered).toBe(EDITED);
  const saved = await stdin("save", [sha256Hex(draft)]);
  expect(saved.code).toBe(0);
  expect(read(draftFile(id))).toBe(EDITED);
});

test("a session draft may share its id with its project template and is not a catalog entry", async () => {
  const id = prepare();
  const ok = await run(["workflow", "validate", "@draft", "--session", id, "--format", "yaml", "--json"], EDITED);
  expect(ok.code).toBe(0);
  expect(codes(ok.json)).not.toContain("duplicate-id");
  // Project authoring is unchanged: the same id under another name is still a duplicate.
  const project = await run(["workflow", "validate", "@draft", "--target", "other.yaml", "--format", "yaml", "--json"], EDITED);
  expect(project.code).toBe(1);
  expect(codes(project.json)).toContain("duplicate-id");
});

test("a changed id is a mismatch with the recorded workflow id", async () => {
  const id = prepare();
  const res = await run(["workflow", "validate", "@draft", "--session", id, "--format", "yaml", "--json"], EDITED.replace("id: build", "id: other"));
  expect(res.code).toBe(1);
  expect(res.json.diagnostics.find((d: { code: string }) => d.code === "session-workflow-id-mismatch")).toMatchObject({
    source: "workflow", file: draftLabel(id), draft: true, path: ["id"],
  });
  expect(res.json.diagnostics.find((d: { code: string }) => d.code === "session-workflow-id-mismatch").line).toBeTypeOf("number");
});

test("document, binding and downstream errors point at the session draft", async () => {
  const id = prepare();
  const document = await run(["workflow", "validate", "@draft", "--session", id, "--format", "yaml", "--json"], EDITED.replace("schema_version: 6", "schema_version: 6\nbogus: 1"));
  expect(document.json.diagnostics.some((d: { code: string; severity: string }) => d.severity === "warning" || d.severity === "error")).toBe(true);

  const binding = await run(["workflow", "validate", "@draft", "--session", id, "--format", "yaml", "--json"], EDITED.replace("role: developer\n    depends_on:\n      - implement", "role: ghost\n    depends_on:\n      - implement"));
  expect(binding.code).toBe(1);
  expect(binding.json.diagnostics[0]).toMatchObject({ source: "workflow", file: draftLabel(id), draft: true, path: ["stages", 1, "role"] });

  const downstream = await run(["workflow", "validate", "@draft", "--session", id, "--format", "yaml", "--json"], `${EDITED}downstream:\n  - workflow: missing\n`);
  expect(downstream.code).toBe(1);
  expect(downstream.json.diagnostics.find((d: { code: string }) => d.code === "unknown-downstream")).toMatchObject({
    file: draftLabel(id), draft: true, path: ["downstream", 0, "workflow"],
  });
  const known = await run(["workflow", "validate", "@draft", "--session", id, "--format", "yaml", "--json"], `${EDITED}downstream:\n  - workflow: build\n`);
  expect(codes(known.json)).not.toContain("unknown-downstream");

  // Aggregate: several independent problems come back together.
  const many = await run(["workflow", "validate", "@draft", "--session", id, "--format", "yaml", "--json"], `${EDITED.replace("role: developer\n    depends_on:\n      - implement", "role: ghost\n    depends_on:\n      - implement")}downstream:\n  - workflow: missing\n`);
  expect(codes(many.json)).toEqual(expect.arrayContaining(["unknown-role", "unknown-downstream"]));

  // A broken config blocks the live bindings check.
  writeFileSync(path.join(root, ".migent", "config.yaml"), "roles: [\n");
  const config = await run(["workflow", "validate", "@draft", "--session", id, "--format", "yaml", "--json"], EDITED);
  expect(config.code).toBe(1);
});

test("session metadata and destination are validated", async () => {
  const check = async (args: string[], code: string) => {
    const res = await run(["workflow", "validate", "@draft", ...args, "--format", "yaml", "--json"], EDITED);
    expect(res.code).toBe(2);
    expect(res.json.diagnostics[0].code).toBe(code);
  };
  await check(["--session", "nope"], "session-not-found");
  await check(["--session", ".."], "invalid-session-id");
  await check(["--session", "../x"], "invalid-session-id");
  await check(["--session", "a/b"], "invalid-session-id");
  await check(["--session", "/etc"], "invalid-session-id");

  // Role session.
  const roleDir = sessionDir("role-one");
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(path.join(roleDir, "manifest.yaml"), "session_id: role-one\nworkflow_id: agent\nrole: developer\nschema_version: 2\n");
  await check(["--session", "role-one"], "session-not-workflow");

  // Project-file source.
  const projectDir = sessionDir("project-src");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, "manifest.yaml"), "session_id: project-src\nworkflow_id: build\nworkflow_path: .migent/workflows/build.yaml\nschema_version: 2\n");
  await check(["--session", "project-src"], "session-source-unsupported");

  // Missing and corrupt metadata.
  mkdirSync(sessionDir("no-manifest"), { recursive: true });
  await check(["--session", "no-manifest"], "session-metadata-missing");
  mkdirSync(sessionDir("bad-manifest"), { recursive: true });
  writeFileSync(path.join(sessionDir("bad-manifest"), "manifest.yaml"), "- not\n- a mapping\n");
  await check(["--session", "bad-manifest"], "session-metadata-corrupt");
  mkdirSync(sessionDir("no-id"), { recursive: true });
  writeFileSync(path.join(sessionDir("no-id"), "manifest.yaml"), "session_id: no-id\nworkflow_path: .migent/sessions/no-id/workflow.yaml\nschema_version: 2\n");
  await check(["--session", "no-id"], "session-metadata-missing");

  // Missing draft.
  const id = prepare();
  rmSync(draftFile(id));
  await check(["--session", id], "session-draft-missing");
  expect(existsSync(draftFile(id))).toBe(false);
});

test("a symlinked session directory or draft is refused", async () => {
  const id = prepare();
  const outside = mkdtempSync(path.join(tmpdir(), "migent-outside-"));
  try {
    writeFileSync(path.join(outside, "target.yaml"), WORKFLOW);
    rmSync(draftFile(id));
    symlinkSync(path.join(outside, "target.yaml"), draftFile(id));
    const draft = await run(["workflow", "save", "@draft", "--session", id, "--format", "yaml", "--base-hash", sha256Hex(WORKFLOW), "--json"], EDITED);
    expect(draft.code).toBe(2);
    expect(draft.json.diagnostics[0].code).toBe("session-draft-invalid");
    expect(read(path.join(outside, "target.yaml"))).toBe(WORKFLOW);

    symlinkSync(outside, sessionDir("linked"));
    const linked = await run(["workflow", "save", "@draft", "--session", "linked", "--format", "yaml", "--base-hash", sha256Hex(WORKFLOW), "--json"], EDITED);
    expect(linked.code).toBe(2);
    expect(linked.json.diagnostics[0].code).toBe("session-not-found");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("invocation rules: --session excludes --target and applies to workflow only", async () => {
  const id = prepare();
  const both = await run(["workflow", "validate", "@draft", "--session", id, "--target", "build.yaml", "--format", "yaml", "--json"], EDITED);
  expect(both.code).toBe(2);
  expect(both.json.diagnostics[0].code).toBe("invalid-invocation");
  const config = await run(["config", "validate", "@draft", "--session", id, "--format", "yaml", "--json"], CONFIG);
  expect(config.code).toBe(2);
});

test("base hash: current, missing and stale; rejected saves leave the draft unchanged", async () => {
  const id = prepare();
  const original = read(draftFile(id));
  const missing = await run(["workflow", "save", "@draft", "--session", id, "--format", "yaml", "--json"], EDITED);
  expect(missing.code).toBe(3);
  expect(codes(missing.json)).toContain("already-exists");
  const stale = await run(["workflow", "save", "@draft", "--session", id, "--format", "yaml", "--base-hash", "0".repeat(64), "--json"], EDITED);
  expect(stale.code).toBe(3);
  expect(codes(stale.json)).toContain("stale-base");
  expect(stale.json.current_hash).toBe(sha256Hex(original));
  const stalePreserved = await run(["workflow", "save", "@draft", "--session", id, "--format", "yaml", "--preserve-comments", "--base-hash", "0".repeat(64), "--json"], EDITED);
  expect(stalePreserved.code).toBe(3);
  expect(read(draftFile(id))).toBe(original);
  const invalid = await run(["workflow", "save", "@draft", "--session", id, "--format", "yaml", "--base-hash", sha256Hex(original), "--json"], EDITED.replace("id: build", "id: other"));
  expect(invalid.code).toBe(1);
  expect(read(draftFile(id))).toBe(original);
  const ok = await run(["workflow", "save", "@draft", "--session", id, "--format", "yaml", "--base-hash", sha256Hex(original), "--json"], EDITED);
  expect(ok.code).toBe(0);
  expect(ok.json.hash).toBe(sha256Hex(read(draftFile(id))));
  expect(readdirSync(sessionDir(id)).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([]);
});

test("--preserve-comments uses the session draft as the formatting base", async () => {
  const id = prepare();
  const original = read(draftFile(id));
  expect(original.startsWith("# Session workflow draft.")).toBe(true);
  const rendered = await run(["workflow", "render", "@draft", "--session", id, "--format", "yaml", "--preserve-comments", "--json"], EDITED);
  expect(rendered.code).toBe(0);
  expect(rendered.json.rendered).toContain("# Session workflow draft.");
  const saved = await run(["workflow", "save", "@draft", "--session", id, "--format", "yaml", "--preserve-comments", "--base-hash", sha256Hex(original), "--json"], EDITED);
  expect(saved.code).toBe(0);
  expect(read(draftFile(id))).toBe(rendered.json.rendered);
  expect(codes(saved.json)).not.toContain("comments-dropped");
  const plain = await run(["workflow", "save", "@draft", "--session", id, "--format", "yaml", "--base-hash", sha256Hex(read(draftFile(id))), "--json"], EDITED);
  expect(plain.code).toBe(0);
});

test("save is refused while the session lock is held, and the lock is released afterwards", async () => {
  const id = prepare();
  const original = read(draftFile(id));
  const lock = SessionLock.tryAcquire(sessionDir(id));
  expect(lock).not.toBeNull();
  // Same process holds it, so the save cannot take it either.
  const held = await run(["workflow", "save", "@draft", "--session", id, "--format", "yaml", "--base-hash", sha256Hex(original), "--json"], EDITED);
  expect(held.code).toBe(3);
  expect(held.json.diagnostics[0].code).toBe("session-locked");
  expect(read(draftFile(id))).toBe(original);
  // Validate and render ignore the lock and are read-only.
  expect((await run(["workflow", "validate", "@draft", "--session", id, "--format", "yaml", "--json"], EDITED)).code).toBe(0);
  lock!.release();

  const failed = await run(["workflow", "save", "@draft", "--session", id, "--format", "yaml", "--base-hash", "1".repeat(64), "--json"], EDITED);
  expect(failed.code).toBe(3);
  expect(existsSync(path.join(sessionDir(id), "session.lock"))).toBe(false);
  const ok = await run(["workflow", "save", "@draft", "--session", id, "--format", "yaml", "--base-hash", sha256Hex(original), "--json"], EDITED);
  expect(ok.code).toBe(0);
  expect(existsSync(path.join(sessionDir(id), "session.lock"))).toBe(false);
  const unresolved = await run(["workflow", "save", "@draft", "--session", "missing", "--format", "yaml", "--base-hash", "1".repeat(64), "--json"], EDITED);
  expect(unresolved.code).toBe(2);
});

test("validate and render do not take the lock or modify the session", async () => {
  const id = prepare();
  const before = snapshot(id);
  const draft = read(draftFile(id));
  await run(["workflow", "validate", "@draft", "--session", id, "--format", "yaml", "--json"], EDITED);
  await run(["workflow", "render", "@draft", "--session", id, "--format", "yaml", "--preserve-comments", "--json"], EDITED);
  expect(snapshot(id)).toEqual(before);
  expect(read(draftFile(id))).toBe(draft);
  expect(existsSync(path.join(sessionDir(id), "session.lock"))).toBe(false);
});

test("a stopped started session accepts a save; terminal or unrefreshable sessions do not", async () => {
  const id = startedSession();
  const status = JSON.parse(read(path.join(sessionDir(id), "status.json"))) as { status: string };
  expect(status.status).toBe("active");
  const draft = read(draftFile(id));
  const frozen = read(path.join(sessionDir(id), "workflow.frozen.yaml"));
  const projectBytes = read(path.join(root, ".migent", "workflows", "build.yaml"));
  const others = snapshot(id);
  const saved = await run(["workflow", "save", "@draft", "--session", id, "--format", "yaml", "--base-hash", sha256Hex(draft), "--json"], EDITED);
  expect(saved.code).toBe(0);
  expect(read(draftFile(id))).toBe(EDITED);
  expect(read(path.join(sessionDir(id), "workflow.frozen.yaml"))).toBe(frozen);
  expect(read(path.join(root, ".migent", "workflows", "build.yaml"))).toBe(projectBytes);
  // Manifest, events, status and every other session file are byte-identical.
  expect(snapshot(id)).toEqual(others);

  for (const terminal of ["completed", "cancelled"]) {
    const statusFile = path.join(sessionDir(id), "status.json");
    const current = JSON.parse(read(statusFile)) as Record<string, unknown>;
    writeFileSync(statusFile, JSON.stringify({ ...current, status: terminal }));
    const res = await run(["workflow", "save", "@draft", "--session", id, "--format", "yaml", "--base-hash", sha256Hex(EDITED), "--json"], WORKFLOW);
    expect(res.code).toBe(2);
    expect(res.json.diagnostics[0].code).toBe("session-terminal");
    expect(read(draftFile(id))).toBe(EDITED);
    // Validation is still available for a terminal session.
    expect((await run(["workflow", "validate", "@draft", "--session", id, "--format", "yaml", "--json"], WORKFLOW)).code).toBe(0);
    writeFileSync(statusFile, JSON.stringify(current));
  }

  // A started session without a freeze cannot adopt the draft by refresh.
  rmSync(path.join(sessionDir(id), "workflow.frozen.yaml"));
  const nofreeze = await run(["workflow", "save", "@draft", "--session", id, "--format", "yaml", "--base-hash", sha256Hex(EDITED), "--json"], WORKFLOW);
  expect(nofreeze.code).toBe(2);
  expect(nofreeze.json.diagnostics[0].code).toBe("session-not-savable");

  // Missing and corrupt status files are metadata errors.
  rmSync(path.join(sessionDir(id), "status.json"));
  const nostatus = await run(["workflow", "save", "@draft", "--session", id, "--format", "yaml", "--base-hash", sha256Hex(EDITED), "--json"], WORKFLOW);
  expect(nostatus.json.diagnostics[0].code).toBe("session-metadata-corrupt");
});

test("startup adopts a saved prepared draft; a started session keeps its freeze until refresh", async () => {
  const prepared = prepare();
  writeFileSync(path.join(sessionDir(prepared), "task.md"), "work\n");
  const saved = await run(["workflow", "save", "@draft", "--session", prepared, "--format", "yaml", "--base-hash", sha256Hex(read(draftFile(prepared))), "--json"], EDITED);
  expect(saved.code).toBe(0);
  activatePreparedSession(root, prepared);
  const frozen = path.join(sessionDir(prepared), "workflow.frozen.yaml");
  expect(read(frozen)).toContain("id: verify");

  // Edit again after start: the freeze stays until an explicit refresh.
  const frozenBefore = read(frozen);
  const again = await run(["workflow", "save", "@draft", "--session", prepared, "--format", "yaml", "--base-hash", sha256Hex(EDITED), "--json"], `${EDITED}  - id: extra\n    role: developer\n    depends_on:\n      - verify\n`);
  expect(again.code).toBe(0);
  expect(read(frozen)).toBe(frozenBefore);
  await expect(
    executeNamedWorkflow(root, { sessionId: prepared, once: true, stageId: "nope", refreshWorkflow: true }, new AgentToolRunner(registryOf({ grok: new FakeClient() }))),
  ).rejects.toThrow();
  expect(read(frozen)).toContain("id: extra");
  expect(read(frozen)).not.toBe(frozenBefore);
});

test("parent symlinks, wrong manifest identity and a corrupt freeze are rejected without writing", async () => {
  const save = (id: string, body = EDITED) =>
    run(["workflow", "save", "@draft", "--session", id, "--format", "yaml", "--base-hash", sha256Hex(read(draftFile(id))), "--json"], body);

  const identity = prepare();
  const manifest = path.join(sessionDir(identity), "manifest.yaml");
  const original = read(manifest);
  const draftBefore = read(draftFile(identity));
  writeFileSync(manifest, original.replace(/^session_id: .*\n/m, ""));
  expect((await save(identity)).json.diagnostics[0].code).toBe("session-metadata-missing");
  writeFileSync(manifest, original.replace(/^session_id: .*$/m, "session_id: someone-else"));
  expect((await save(identity)).json.diagnostics[0].code).toBe("session-metadata-corrupt");
  expect(read(draftFile(identity))).toBe(draftBefore);
  writeFileSync(manifest, original);

  const started = startedSession();
  writeFileSync(path.join(sessionDir(started), "workflow.frozen.yaml"), "not: a freeze\n");
  const frozenDraft = read(draftFile(started));
  const corrupt = await save(started);
  expect(corrupt.code).toBe(2);
  expect(corrupt.json.diagnostics[0].code).toBe("session-metadata-corrupt");
  expect(read(draftFile(started))).toBe(frozenDraft);

  // A symlinked sessions directory that leaves the workspace.
  const outside = mkdtempSync(path.join(tmpdir(), "migent-outside-"));
  try {
    const stolen = prepare();
    cpSync(sessionDir(stolen), path.join(outside, stolen), { recursive: true });
    const outsideDraft = path.join(outside, stolen, "workflow.yaml");
    const outsideBefore = read(outsideDraft);
    rmSync(path.join(root, ".migent", "sessions"), { recursive: true, force: true });
    symlinkSync(outside, path.join(root, ".migent", "sessions"));
    const res = await run(["workflow", "save", "@draft", "--session", stolen, "--format", "yaml", "--base-hash", sha256Hex(outsideBefore), "--json"], EDITED);
    expect(res.code).toBe(2);
    expect(res.json.diagnostics[0].code).toBe("session-path-escape");
    expect(read(outsideDraft)).toBe(outsideBefore);
    expect(existsSync(path.join(outside, stolen, "session.lock"))).toBe(false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a stale status.json cannot hide a terminal or inconsistent event history", async () => {
  const id = startedSession();
  const draft = read(draftFile(id));
  const save = () =>
    run(["workflow", "save", "@draft", "--session", id, "--format", "yaml", "--base-hash", sha256Hex(draft), "--json"], EDITED);
  const statusFile = path.join(sessionDir(id), "status.json");
  const persisted = read(statusFile);

  // status.json still says active while the events say completed.
  const lock = SessionLock.acquire(sessionDir(id));
  try {
    appendLifecycleEvent(sessionDir(id), { event: "session.completed", timestamp: new Date().toISOString(), data: {} });
  } finally {
    lock.release();
  }
  expect(read(statusFile)).toBe(persisted);
  const terminal = await save();
  expect(terminal.code).toBe(2);
  expect(terminal.json.diagnostics[0].code).toBe("session-terminal");
  expect(read(draftFile(id))).toBe(draft);
  expect(existsSync(path.join(sessionDir(id), "session.lock"))).toBe(false);

  // status.json disagrees with a non-terminal fold: unresolved, refused.
  const other = startedSession();
  const otherStatus = path.join(sessionDir(other), "status.json");
  writeFileSync(otherStatus, JSON.stringify({ ...JSON.parse(read(otherStatus)), status: "blocked" }));
  const otherDraft = read(draftFile(other));
  const inconsistent = await run(["workflow", "save", "@draft", "--session", other, "--format", "yaml", "--base-hash", sha256Hex(otherDraft), "--json"], EDITED);
  expect(inconsistent.code).toBe(2);
  expect(inconsistent.json.diagnostics[0].code).toBe("session-status-inconsistent");
  expect(read(draftFile(other))).toBe(otherDraft);
  expect(existsSync(path.join(sessionDir(other), "session.lock"))).toBe(false);
});
