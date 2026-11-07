import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { SessionLock, sha256Hex } from "@nodeint/migent-kernel";
import { main } from "../src/index.ts";
import { capture } from "./support.ts";

test("migrate upgrades session workflow.yaml and workflow.frozen.yaml", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-cli-"));
  try {
    const root = path.join(workspace, ".migent");
    const session = path.join(root, "sessions", "s1");
    mkdirSync(session, { recursive: true });
    writeFileSync(
      path.join(root, "config.yaml"),
      "schema_version: 7\nroles:\n  developer:\n    agent:\n      model: grok-4\n      client:\n        type: grok\n",
      "utf8",
    );
    const draft =
      "schema_version: 6\nid: implement\nstages:\n  - id: implement\n    role: developer\n    depends_on: []\n    produces:\n      artifact: out.md\n";
    writeFileSync(path.join(session, "workflow.yaml"), draft, "utf8");
    const frozen =
      `schema_version: 2\nsource_sha256: ${sha256Hex(draft)}\nworkflow:\n  schema_version: 6\n  id: implement\n  stages:\n` +
      "    - id: implement\n      role: developer\n      depends_on: []\n      produces:\n        artifact: out.md\n" +
      "roles:\n  developer: []\ntargets:\n  implement:\n    client: grok\n    model: grok-4\n    options: {}\n";
    writeFileSync(path.join(session, "workflow.frozen.yaml"), frozen, "utf8");

    const captured = await capture(() => main(["migrate", "--yes"], workspace));
    expect(captured.value).toBe(0);
    const newDraft = readFileSync(path.join(session, "workflow.yaml"), "utf8");
    expect(newDraft).toContain("schema_version: 7");
    expect(newDraft).not.toContain("produces");
    const newFrozen = readFileSync(path.join(session, "workflow.frozen.yaml"), "utf8");
    expect(newFrozen).toContain("schema_version: 7");
    expect(newFrozen).not.toContain("produces");
    expect(newFrozen).toContain(`source_sha256: ${sha256Hex(newDraft)}`);

    const again = await capture(() => main(["migrate", "--yes"], workspace));
    expect(again.stdout).toContain("Schema is current.");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function sessionFixture(workspace: string): { root: string; session: string; draft: string } {
  const root = path.join(workspace, ".migent");
  const session = path.join(root, "sessions", "s1");
  mkdirSync(session, { recursive: true });
  writeFileSync(
    path.join(root, "config.yaml"),
    "schema_version: 7\nroles:\n  developer:\n    agent:\n      model: grok-4\n      client:\n        type: grok\n",
    "utf8",
  );
  const draft =
    "schema_version: 6\nid: implement\nstages:\n  - id: implement\n    role: developer\n    depends_on: []\n    produces:\n      artifact: out.md\n";
  return { root, session, draft };
}

test("migrate leaves a locked session untouched and fails", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-cli-"));
  try {
    const { session, draft } = sessionFixture(workspace);
    writeFileSync(path.join(session, "workflow.yaml"), draft, "utf8");
    const lock = SessionLock.acquire(session);
    try {
      const captured = await capture(() => main(["migrate", "--yes"], workspace));
      expect(captured.value).not.toBe(0);
      expect(readFileSync(path.join(session, "workflow.yaml"), "utf8")).toBe(draft);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("migrate does not follow a symlinked session directory", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-cli-"));
  const outside = mkdtempSync(path.join(tmpdir(), "migent-outside-"));
  try {
    const { root, session, draft } = sessionFixture(workspace);
    rmSync(session, { recursive: true, force: true });
    writeFileSync(path.join(outside, "workflow.yaml"), draft, "utf8");
    symlinkSync(outside, path.join(root, "sessions", "s1"));
    await capture(() => main(["migrate", "--yes"], workspace));
    expect(readFileSync(path.join(outside, "workflow.yaml"), "utf8")).toBe(draft);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("migrate does not follow a symlinked workflow file", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-cli-"));
  const outside = mkdtempSync(path.join(tmpdir(), "migent-outside-"));
  try {
    const { session, draft } = sessionFixture(workspace);
    writeFileSync(path.join(outside, "wf.yaml"), draft, "utf8");
    symlinkSync(path.join(outside, "wf.yaml"), path.join(session, "workflow.yaml"));
    await capture(() => main(["migrate", "--yes"], workspace));
    expect(readFileSync(path.join(outside, "wf.yaml"), "utf8")).toBe(draft);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("migrate does not follow a symlinked .migent parent", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-cli-"));
  const outside = mkdtempSync(path.join(tmpdir(), "migent-outside-"));
  try {
    const { root, session, draft } = sessionFixture(workspace);
    writeFileSync(path.join(session, "workflow.yaml"), draft, "utf8");
    const moved = path.join(outside, ".migent");
    renameSync(root, moved);
    symlinkSync(moved, root);
    await capture(() => main(["migrate", "--yes"], workspace));
    expect(readFileSync(path.join(moved, "sessions", "s1", "workflow.yaml"), "utf8")).toBe(draft);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
