import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { WorkspaceLocationError, locateWorkspace } from "../src/workspace.ts";
import { makeWorkspace } from "./support.ts";

test("parent walk finds the root from an absolute path", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "registry-ws-"));
  const workspace = makeWorkspace(tmp);
  const nested = path.join(workspace, "src", "pkg");
  mkdirSync(nested, { recursive: true });
  expect(locateWorkspace(nested)).toBe(realpathSync(workspace));
});

test("directory without config fails", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "registry-ws-"));
  const empty = path.join(tmp, "empty");
  mkdirSync(empty);
  try {
    locateWorkspace(empty);
    throw new Error("expected WorkspaceLocationError");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceLocationError);
    expect((error as WorkspaceLocationError).reason).toBe("not_workspace");
  }
});

test("file path fails", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "registry-ws-"));
  const target = path.join(tmp, "notes.txt");
  writeFileSync(target, "x");
  try {
    locateWorkspace(target);
    throw new Error("expected WorkspaceLocationError");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceLocationError);
    expect((error as WorkspaceLocationError).reason).toBe("file");
  }
});

test("relative path is rejected before the walk and before cwd join", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "registry-ws-"));
  const workspace = makeWorkspace(tmp);
  const previous = process.cwd();
  process.chdir(workspace);
  try {
    try {
      locateWorkspace("src");
      throw new Error("expected WorkspaceLocationError");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceLocationError);
      expect((error as WorkspaceLocationError).reason).toBe("relative");
    }
  } finally {
    process.chdir(previous);
  }
});
