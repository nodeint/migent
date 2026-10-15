import { realpathSync, statSync } from "node:fs";
import path from "node:path";

export class WorkspaceLocationError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "WorkspaceLocationError";
    this.reason = reason;
  }
}

function resolveExisting(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function walk(start: string): string[] {
  const found = [start];
  let current = start;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) break;
    found.push(parent);
    current = parent;
  }
  return found;
}

export function locateWorkspace(input: string): string {
  if (typeof input !== "string" || input === "" || input.includes("\0") || !path.isAbsolute(input)) {
    throw new WorkspaceLocationError("relative", "Workspace path is not absolute.");
  }
  const start = resolveExisting(input);
  let stats;
  try {
    stats = statSync(start);
  } catch {
    throw new WorkspaceLocationError("not_directory", "Workspace path is not a directory.");
  }
  if (stats.isFile()) throw new WorkspaceLocationError("file", "Workspace path is a file.");
  if (!stats.isDirectory()) {
    throw new WorkspaceLocationError("not_directory", "Workspace path is not a directory.");
  }
  for (const candidate of walk(start)) {
    if (isFile(path.join(candidate, ".migent", "config.yaml"))) {
      try {
        return realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
  }
  throw new WorkspaceLocationError(
    "not_workspace",
    "Could not find .migent/config.yaml in this directory or its parents.",
  );
}
