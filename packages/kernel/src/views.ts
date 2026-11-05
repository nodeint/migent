import path from "node:path";
import {
  LOCAL_CONFIG_FILE,
  hasLocalConfig,
  loadModelTarget,
  loadRoleInstructions,
  loadWorkspaceConfig,
  loadYamlMapping,
  resolveRoleCascade,
  resolveStageSpec,
  type StageTarget,
} from "./config.js";
import { selectSessionWorkflow } from "./session-selection.js";
import { ConfigurationError } from "./errors.js";
import type { ProviderResolver } from "./provider-contract.js";
import { isRecord } from "./record.js";
import {
  isRoleStage,
  loadNamedWorkflow,
  loadWorkflowCatalog,
  type StageSpec,
  type WorkflowDocument,
} from "./workflow.js";

/**
 * Read-only views of what a project defines. They are the public contract of `migent get`: plain,
 * JSON-safe objects in the authored snake_case vocabulary. Nothing here writes, locks, or spawns.
 */
export type View = Record<string, unknown>;

/** The workspace-relative path of the machine-specific config. */
export const LOCAL_CONFIG_LABEL = `.migent/${LOCAL_CONFIG_FILE}`;

/** Names of the models entries that `config.local.yaml` sets. */
export function localModelNames(workspace: string): string[] {
  const local = loadYamlMapping(path.join(workspace, ".migent", LOCAL_CONFIG_FILE));
  const models = local.models;
  return isRecord(models) ? Object.keys(models).sort() : [];
}

interface Loaded {
  config: Record<string, unknown> | null;
  problem: string | null;
}

function tryConfig(workspace: string): Loaded {
  try {
    return { config: loadWorkspaceConfig(workspace), problem: null };
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    return { config: null, problem: error.message };
  }
}

function message(error: unknown): string {
  if (error instanceof ConfigurationError) return error.message;
  throw error;
}

function targetView(target: StageTarget): View {
  return {
    provider: target.provider,
    model: target.model,
    client: target.client ?? null,
    options: { ...target.options },
  };
}

function display(workspace: string, target: string): string {
  const relative = path.relative(workspace, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return target;
  return relative.split(path.sep).join("/");
}

// ---------------------------------------------------------------- workflows

export type WorkflowSourceKind = "project" | "draft" | "frozen" | "live";

interface WorkflowOrigin {
  kind: WorkflowSourceKind;
  path: string | null;
  session?: string;
  /** Pinned stage targets of a frozen session; they are what will actually run. */
  frozenTargets?: Record<string, StageTarget>;
  /** Role instructions pinned by a frozen session. */
  frozenRoles?: Record<string, string[]>;
  problems?: readonly string[];
}

function stageView(stage: StageSpec, config: Loaded, origin: WorkflowOrigin, resolve?: ProviderResolver): View {
  const problems: string[] = [];
  let target: View | null = null;
  if (isRoleStage(stage)) {
    const pinned = origin.frozenTargets?.[stage.id];
    if (pinned !== undefined) target = targetView(pinned);
    else if (origin.frozenTargets !== undefined) problems.push(`No pinned target for stage ${stage.id}.`);
    else if (config.config === null) problems.push(config.problem ?? "Config could not be loaded.");
    else {
      try {
        target = targetView(resolveStageSpec(config.config, stage, null, resolve));
      } catch (error) {
        problems.push(message(error));
      }
    }
  }
  return {
    id: stage.id,
    role: isRoleStage(stage) ? stage.role : null,
    description: stage.description,
    depends_on: [...stage.dependsOn],
    model: stage.modelName,
    options: { ...stage.options },
    artifact: stage.artifact,
    decisions: stage.decisionValues.map((value) => ({
      value,
      when: stage.decisionInstructions?.[value] ?? null,
      navigate: stage.routes[value] ?? null,
    })),
    max_revisions: stage.maxRevisions,
    resume_from: stage.resumeFrom,
    verify: [...stage.verify],
    max_verify: stage.maxVerify,
    verify_timeout: stage.verifyTimeoutSec,
    run_when: stage.runWhen === null || stage.runWhen === undefined ? null : { changed_paths: [...stage.runWhen.changedPaths] },
    ask: stage.ask ?? null,
    target,
    problems,
  };
}

function roleNames(document: WorkflowDocument): string[] {
  const names: string[] = [];
  for (const stage of Object.values(document.stages)) {
    if (isRoleStage(stage) && !names.includes(stage.role)) names.push(stage.role);
  }
  return names;
}

function roleInstructions(
  config: Loaded,
  roles: readonly string[],
  origin: WorkflowOrigin,
  problems: string[],
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const role of roles) {
    if (origin.frozenRoles !== undefined) {
      result[role] = [...(origin.frozenRoles[role] ?? [])];
      continue;
    }
    result[role] = [];
    if (config.config === null) continue;
    try {
      result[role] = loadRoleInstructions(config.config, role);
    } catch (error) {
      problems.push(`role ${role}: ${message(error)}`);
    }
  }
  return result;
}

function workflowView(
  workspace: string,
  document: WorkflowDocument,
  origin: WorkflowOrigin,
  resolve?: ProviderResolver,
): View {
  const config = tryConfig(workspace);
  const stages = Object.values(document.stages).map((stage) => stageView(stage, config, origin, resolve));
  const instructionProblems: string[] = [];
  const instructions = roleInstructions(config, roleNames(document), origin, instructionProblems);
  const view: View = {
    kind: "workflow",
    name: document.id,
    file: document.source === null ? origin.path : display(workspace, document.source),
    source: { kind: origin.kind, path: origin.path },
  };
  if (origin.session !== undefined) view.session = origin.session;
  Object.assign(view, {
    concurrency: document.concurrency ?? 1,
    constraints: [...document.constraints],
    stages,
    outputs: (document.outputs ?? []).map((output) => ({
      name: output.name,
      from_stage: output.fromStage,
      artifact: output.artifact,
    })),
    requires: document.requires === null ? null : { workflow: document.requires.workflow },
    downstream: (document.downstream ?? []).map((next) => ({
      workflow: next.workflow,
      task: next.task,
      artifacts: { ...next.artifacts },
    })),
    role_instructions: instructions,
    warnings: [...(document.warnings ?? [])],
    problems: [...(origin.problems ?? []), ...instructionProblems, ...stages.flatMap((stage) => (stage.problems as string[]).map((p) => `${String(stage.id)}: ${p}`))],
  });
  return view;
}

/** Catalog messages that only say the project has no workflows; an empty list says the same. */
const EMPTY_DIRECTORY_PROBLEMS = ["No workflows in ", "Workflows directory not found"];

/** The file name a catalog problem starts with (`broken.yaml: ...`), or null. */
function problemFile(problem: string): string | null {
  const name = problem.split(":", 1)[0] ?? "";
  return name.endsWith(".yaml") || name.endsWith(".yml") ? name : null;
}

/** Summaries of every workflow in the project. A broken file is listed with its problems. */
export function listWorkflowViews(workspace: string): View[] {
  const catalog = loadWorkflowCatalog(workspace, { quiet: true });
  const documents = Object.values(catalog.documents);
  const claimed = new Set<string>();
  const views: View[] = documents.map((document) => {
    const file = document.source === null ? null : display(workspace, document.source);
    const base = document.source === null ? null : path.basename(document.source);
    const problems = catalog.problems.filter(
      (problem) => problem.startsWith(`${document.id}:`) || (base !== null && problemFile(problem) === base),
    );
    for (const problem of problems) claimed.add(problem);
    return {
      kind: "workflow",
      name: document.id,
      file,
      stages: Object.keys(document.stages),
      roles: roleNames(document),
      problems,
    };
  });
  const broken = new Map<string, string[]>();
  for (const problem of catalog.problems) {
    const file = problemFile(problem);
    if (claimed.has(problem) || file === null) continue;
    broken.set(file, [...(broken.get(file) ?? []), problem]);
  }
  for (const [file, problems] of broken) {
    for (const problem of problems) claimed.add(problem);
    views.push({
      kind: "workflow",
      name: path.parse(file).name,
      file: `.migent/workflows/${file}`,
      stages: [],
      roles: [],
      problems,
    });
  }
  for (const problem of catalog.problems) {
    if (EMPTY_DIRECTORY_PROBLEMS.some((prefix) => problem.startsWith(prefix))) continue;
    if (!claimed.has(problem)) views.push({ kind: "workflow", name: null, file: null, stages: [], roles: [], problems: [problem] });
  }
  return views;
}

function notFound(label: string, name: string, available: readonly string[]): ConfigurationError {
  const list = available.length > 0 ? ` Available: ${available.join(", ")}.` : "";
  return new ConfigurationError(`${label} not found: ${name}.${list}`);
}

/** The project workflow file named `name` (an id). A file that cannot be parsed throws. */
export function getWorkflowView(workspace: string, name: string, resolve?: ProviderResolver): View {
  const catalog = loadWorkflowCatalog(workspace, { quiet: true });
  if (!Object.hasOwn(catalog.documents, name)) {
    const failed = catalog.problems.find(
      (problem) => problem.startsWith(`${name}:`) || problemFile(problem) === `${name}.yaml` || problemFile(problem) === `${name}.yml`,
    );
    if (failed !== undefined) throw new ConfigurationError(failed);
    throw notFound("Workflow", name, Object.keys(catalog.documents));
  }
  const document = loadNamedWorkflow(workspace, name, { quiet: true });
  const file = document.source === null ? null : display(workspace, document.source);
  return workflowView(workspace, document, { kind: "project", path: file }, resolve);
}

/** The workflow a session runs: its draft, its frozen copy, or the live project file. */
export function getSessionWorkflowView(
  workspace: string,
  sessionId: string,
  name: string | null,
  resolve?: ProviderResolver,
): View {
  const selection = selectSessionWorkflow(workspace, sessionId);
  const document = selection.document;
  if (document === null || selection.source === null) {
    throw new ConfigurationError(selection.problems[0] ?? `Session workflow could not be read: ${sessionId}.`);
  }
  if (name !== null && name !== document.id) {
    throw new ConfigurationError(`Session ${sessionId} runs workflow ${document.id}, not ${name}.`);
  }
  const origin: WorkflowOrigin = {
    kind: selection.source.kind,
    path: selection.source.path,
    session: sessionId,
    problems: [...selection.problems],
  };
  if (selection.freeze !== null) {
    origin.frozenTargets = selection.freeze.targets;
    origin.frozenRoles = selection.freeze.roles;
  }
  const view = workflowView(workspace, document, origin, resolve);
  view.file = selection.source.path;
  view.warnings = [...(view.warnings as string[]), ...selection.warnings];
  return view;
}

// -------------------------------------------------------------------- roles

function projectWorkflows(workspace: string): WorkflowDocument[] {
  return Object.values(loadWorkflowCatalog(workspace, { quiet: true }).documents);
}

function configRecord(workspace: string, key: "roles" | "models"): { config: Record<string, unknown>; table: Record<string, unknown> } {
  const config = loadWorkspaceConfig(workspace);
  const table = config[key];
  return { config, table: isRecord(table) ? table : {} };
}

function roleView(
  workspace: string,
  config: Record<string, unknown>,
  name: string,
  role: unknown,
  workflows: readonly WorkflowDocument[],
  resolve?: ProviderResolver,
): View {
  const problems: string[] = [];
  const selection = isRecord(role) ? role.default_model : undefined;
  let defaultModel: unknown = null;
  if (typeof selection === "string") defaultModel = selection;
  else if (isRecord(selection)) defaultModel = { inline: true };
  let target: View | null = null;
  try {
    target = targetView(resolveRoleCascade(config, name, undefined, resolve));
  } catch (error) {
    problems.push(message(error));
  }
  let instructions: string[] = [];
  try {
    instructions = loadRoleInstructions(config, name);
  } catch (error) {
    problems.push(message(error));
  }
  const usedBy: View[] = [];
  for (const workflow of workflows) {
    for (const stage of Object.values(workflow.stages)) {
      if (isRoleStage(stage) && stage.role === name) usedBy.push({ workflow: workflow.id, stage: stage.id });
    }
  }
  return { kind: "role", name, default_model: defaultModel, target, instructions, used_by: usedBy, problems };
}

export function listRoleViews(workspace: string, resolve?: ProviderResolver): View[] {
  const { config, table } = configRecord(workspace, "roles");
  const workflows = projectWorkflows(workspace);
  return Object.entries(table).map(([name, role]) => roleView(workspace, config, name, role, workflows, resolve));
}

export function getRoleView(workspace: string, name: string, resolve?: ProviderResolver): View {
  const { config, table } = configRecord(workspace, "roles");
  if (!Object.hasOwn(table, name)) throw notFound("Role", name, Object.keys(table));
  return roleView(workspace, config, name, table[name], projectWorkflows(workspace), resolve);
}

// ------------------------------------------------------------------- models

function modelView(
  config: Record<string, unknown>,
  name: string,
  roles: Record<string, unknown>,
  workflows: readonly WorkflowDocument[],
  local: ReadonlySet<string>,
  resolve?: ProviderResolver,
): View {
  const problems: string[] = [];
  let target: StageTarget | null = null;
  try {
    target = loadModelTarget(config, name, resolve);
  } catch (error) {
    problems.push(message(error));
  }
  const definition = isRecord(config.models) && isRecord(config.models[name]) ? config.models[name] : {};
  const effort = isRecord(definition) && typeof definition.effort === "string" ? definition.effort : null;
  const usedBy: View[] = [];
  for (const [role, value] of Object.entries(roles)) {
    if (isRecord(value) && value.default_model === name) usedBy.push({ role });
  }
  for (const workflow of workflows) {
    for (const stage of Object.values(workflow.stages)) {
      if (isRoleStage(stage) && stage.modelName === name) usedBy.push({ workflow: workflow.id, stage: stage.id });
    }
  }
  return {
    kind: "model",
    name,
    provider: target?.provider ?? (isRecord(definition) && typeof definition.provider === "string" ? definition.provider : null),
    model: target?.model ?? (isRecord(definition) && typeof definition.model === "string" ? definition.model : null),
    client: target?.client ?? (isRecord(definition) && typeof definition.client === "string" ? definition.client : null),
    effort,
    options: target === null ? {} : { ...target.options },
    local: local.has(name),
    used_by: usedBy,
    problems,
  };
}

function modelViews(workspace: string, resolve?: ProviderResolver): { views: View[] } {
  const { config, table } = configRecord(workspace, "models");
  const roles = isRecord(config.roles) ? config.roles : {};
  const workflows = projectWorkflows(workspace);
  const local = new Set(hasLocalConfig(workspace) ? localModelNames(workspace) : []);
  return { views: Object.keys(table).map((name) => modelView(config, name, roles, workflows, local, resolve)) };
}

export function listModelViews(workspace: string, resolve?: ProviderResolver): View[] {
  return modelViews(workspace, resolve).views;
}

export function getModelView(workspace: string, name: string, resolve?: ProviderResolver): View {
  const views = modelViews(workspace, resolve).views;
  const found = views.find((view) => view.name === name);
  if (found === undefined) throw notFound("Model", name, views.map((view) => String(view.name)));
  return found;
}

// ------------------------------------------------------------------- config

/** The effective config. The data is exactly what `loadWorkspaceConfig` returns. */
export function getConfigView(workspace: string): View {
  const local = hasLocalConfig(workspace);
  return {
    kind: "config",
    name: "config",
    local_file: local ? LOCAL_CONFIG_LABEL : null,
    local_models: local ? localModelNames(workspace) : [],
    config: loadWorkspaceConfig(workspace),
  };
}
