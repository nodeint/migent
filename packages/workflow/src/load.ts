import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ConfigurationError } from "./errors.js";
import { isRecord } from "./record.js";
import { parseYamlDocument } from "./yaml.js";
import { catalogEntryFromDocument, checkWorkflowCatalog } from "./catalog.js";
import { isPathReference } from "./model.js";
import type { StageSpec, WorkflowCatalog, WorkflowDocument } from "./model.js";
import { parseWorkflowMapping } from "./parse.js";
import { fail } from "./stage-fields.js";

export function workflowsDirectory(workspace: string): string {
  return path.join(workspace, ".migent", "workflows");
}

/** `quiet` keeps authoring warnings off stderr; they remain on `document.warnings`. */
export interface LoadWorkflowOptions {
  quiet?: boolean;
}

export function loadNamedWorkflow(
  workspace: string,
  workflowId: string,
  options: LoadWorkflowOptions = {},
): WorkflowDocument {
  if (isPathReference(workflowId)) {
    const filePath = resolveWorkflowPath(workspace, workflowId);
    if (filePath === null) fail(`Workflow not found: ${workflowId}`);
    return requireStages(loadWorkflowDocument(filePath, options));
  }
  const matches = readWorkflowDirectory(workspace, options).loaded.filter((entry) => entry.document.id === workflowId);
  if (matches.length > 1) {
    const names = matches.map((entry) => path.basename(entry.path)).join(", ");
    fail(`${workflowId}: id is declared by ${names}.`);
  }
  if (matches.length === 0) fail(`Workflow not found: ${workflowId}`);
  return requireStages(loadWorkflowDocument(matches[0]!.path, options));
}

export function loadWorkflowCatalog(workspace: string, options: LoadWorkflowOptions = {}): WorkflowCatalog {
  const { loaded, problems } = readWorkflowDirectory(workspace, options);
  if (loaded.length === 0) return { documents: {}, problems };
  const checked = checkWorkflowCatalog(
    loaded.map((entry) => catalogEntryFromDocument(path.basename(entry.path), entry.document)),
    unreadableWorkflowIds(problems),
  );
  return { documents: checked.documents, problems: [...problems, ...checked.problems.map((problem) => problem.message)] };
}

export function loadWorkflowDocument(filePath: string, options: LoadWorkflowOptions = {}): WorkflowDocument {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`Unable to read workflow: ${filePath} (${reason})`);
  }
  const data = parseYamlDocument(text);
  if (!isRecord(data)) throw new ConfigurationError(`Workflow must be a mapping: ${filePath}`);
  const document = parseWorkflowMapping(data, filePath);
  if (options.quiet !== true) for (const warning of document.warnings ?? []) warnOnce(`${path.basename(filePath)}: ${warning}`);
  return document;
}

export const reportedWarnings = new Set<string>();

export function warnOnce(message: string): void {
  if (reportedWarnings.has(message)) return;
  reportedWarnings.add(message);
  process.stderr.write(`warning: ${message}\n`);
}

export function loadStage(
  workspace: string,
  workflowPath: string,
  stageId: string,
): StageSpec | null {
  const filePath = path.join(workspace, workflowPath);
  if (!isFile(filePath)) return null;
  try {
    return loadWorkflowDocument(filePath).stages[stageId] ?? null;
  } catch (error) {
    if (error instanceof ConfigurationError) return null;
    throw error;
  }
}

export function stageArtifactName(
  workspace: string,
  workflowPath: string,
  stageId: string,
): string | null {
  const stage = loadStage(workspace, workflowPath, stageId);
  return stage === null ? null : (stage.artifacts[0]?.file ?? null);
}

export interface LoadedWorkflow {
  path: string;
  document: WorkflowDocument;
}

export function readWorkflowDirectory(workspace: string, options: LoadWorkflowOptions = {}): { loaded: LoadedWorkflow[]; problems: string[] } {
  const directory = workflowsDirectory(workspace);
  if (!isDir(directory)) {
    return { loaded: [], problems: ["Workflows directory not found: .migent/workflows"] };
  }
  const paths = readdirSync(directory)
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => path.join(directory, name))
    .filter((filePath) => isFile(filePath))
    .sort();
  if (paths.length === 0) {
    return { loaded: [], problems: ["No workflows in .migent/workflows."] };
  }
  const loaded: LoadedWorkflow[] = [];
  const problems: string[] = [];
  for (const filePath of paths) {
    try {
      loaded.push({ path: filePath, document: loadWorkflowDocument(filePath, options) });
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      problems.push(`${path.basename(filePath)}: ${error.message}`);
    }
  }
  return { loaded, problems };
}

export function unreadableWorkflowIds(problems: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const problem of problems) {
    const name = problem.split(":", 1)[0] ?? "";
    if (name.endsWith(".yaml") || name.endsWith(".yml")) found.add(path.parse(name).name);
  }
  return found;
}

export function requireStages(document: WorkflowDocument): WorkflowDocument {
  if (Object.keys(document.stages).length === 0) fail(`${document.id}: declares no stages.`);
  return document;
}

export function resolveWorkflowPath(workspace: string, reference: string): string | null {
  if (path.isAbsolute(reference)) return isFile(reference) ? reference : null;
  const relative = path.join(workspace, reference);
  if (isFile(relative)) return relative;
  if (path.dirname(reference) === ".") {
    const named = path.join(workflowsDirectory(workspace), path.basename(reference));
    if (isFile(named)) return named;
  }
  return null;
}

export function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function isDir(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}
