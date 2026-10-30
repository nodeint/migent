import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AskTarget } from "./stage-outcome.js";
import { ConfigurationError } from "./errors.js";
import { documentVersion, isRecord, pyRepr } from "./record.js";
import { compileChangedPathPattern } from "./run-when.js";
import { parseYamlDocument } from "./yaml.js";

export const VERIFY_ARTIFACT = "verify.md";

const optionKey = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/** Run the stage only when a changed Git path matches one of the globs. */
export interface RunWhen {
  changedPaths: string[];
}

interface StageFields {
  ask?: AskTarget;
  id: string;
  description: string | null;
  artifact: string | null;
  decisionValues: string[];
  decisionInstructions?: Record<string, string>;
  dependsOn: string[];
  resumeFrom: string | null;
  instructions: string[];
  modelName: string | null;
  options: Record<string, string>;
  maxRevisions: number | null;
  routes: Record<string, string | string[]>;
  verify: string[];
  maxVerify: number;
  verifyTimeoutSec: number | null;
  runWhen: RunWhen | null;
}

export interface RoleStageSpec extends StageFields {
  kind: "role";
  role: string;
}

export interface VerifyOnlyStageSpec extends StageFields {
  kind: "verify";
  role: null;
  verify: string[];
  maxVerify: 0;
}

export type StageSpec = RoleStageSpec | VerifyOnlyStageSpec;

export function isRoleStage(stage: StageSpec): stage is RoleStageSpec {
  return stage.kind === "role";
}

export interface WorkflowOutput {
  name: string;
  fromStage: string;
  artifact: string;
}

export interface WorkflowCompletion {
  stage: string;
  decision: string | null;
  outputs: WorkflowOutput[];
}

/** Historical schema <=3 only; retained for frozen-session compatibility. */
export interface WorkflowRequires {
  workflow: string;
  decision: string | null;
}

export interface WorkflowDownstream {
  workflow: string;
  task: string;
  artifacts: Record<string, string>;
}

export interface WorkflowDocument {
  id: string;
  stages: Record<string, StageSpec>;
  completion: WorkflowCompletion | null;
  requires: WorkflowRequires | null;
  constraints: string[];
  source: string | null;
  /** Missing on hand-built documents means version 1 behavior. */
  schemaVersion?: number;
  concurrency?: number;
  outputs?: WorkflowOutput[];
  downstream?: WorkflowDownstream[];
}

/** Accepted workflow and config document version. */
export const SCHEMA_VERSION = 4;

export function isWorkflowV2(workflow: WorkflowDocument | null | undefined): boolean {
  return (workflow?.schemaVersion ?? 1) >= 2;
}

export interface WorkflowCatalog {
  documents: Record<string, WorkflowDocument>;
  problems: string[];
}

const stageFieldSchema = {
  ask: z.literal("human").optional(),
  id: z.string(),
  description: z.string().nullable(),
  artifact: z.string().nullable(),
  decisionValues: z.array(z.string()),
  decisionInstructions: z.record(z.string(), z.string()).optional(),
  dependsOn: z.array(z.string()),
  resumeFrom: z.string().nullable(),
  instructions: z.array(z.string()),
  modelName: z.string().nullable(),
  options: z.record(z.string(), z.string()),
  maxRevisions: z.number().int().nonnegative().nullable(),
  routes: z.record(z.string(), z.union([z.string(), z.array(z.string()).min(1)])),
  verify: z.array(z.string()),
  verifyTimeoutSec: z.number().int().min(1).nullable(),
  runWhen: z.object({ changedPaths: z.array(z.string()).min(1) }).nullable(),
};

const stageSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    ...stageFieldSchema,
    kind: z.literal("role"),
    role: z.string(),
    maxVerify: z.number().int().min(1),
  }),
  z.object({
    ...stageFieldSchema,
    kind: z.literal("verify"),
    role: z.null(),
    verify: z.array(z.string()).min(1),
    maxVerify: z.literal(0),
  }),
]);

const workflowOutputSchema = z.object({
  name: z.string(),
  fromStage: z.string(),
  artifact: z.string(),
});

const workflowCompletionSchema = z.object({
  stage: z.string(),
  decision: z.string().nullable(),
  outputs: z.array(workflowOutputSchema),
});

const workflowRequiresSchema = z.object({
  workflow: z.string(),
  decision: z.string().nullable(),
});

const workflowDocumentSchema = z.object({
  id: z.string(),
  stages: z.record(z.string(), stageSpecSchema),
  completion: workflowCompletionSchema.nullable(),
  requires: workflowRequiresSchema.nullable(),
  constraints: z.array(z.string()),
  source: z.string().nullable(),
  schemaVersion: z.number().int().nonnegative().optional(),
  concurrency: z.number().int().positive().optional(),
  outputs: z.array(workflowOutputSchema).optional(),
  downstream: z.array(z.object({ workflow: z.string(), task: z.string(), artifacts: z.record(z.string(), z.string()) })).optional(),
});

export function workflowsDirectory(workspace: string): string {
  return path.join(workspace, ".migent", "workflows");
}

export function loadNamedWorkflow(workspace: string, workflowId: string): WorkflowDocument {
  if (isPathReference(workflowId)) {
    const filePath = resolveWorkflowPath(workspace, workflowId);
    if (filePath === null) fail(`Workflow not found: ${workflowId}`);
    return requireStages(loadWorkflowDocument(filePath));
  }
  const matches = readableWorkflows(workspace).filter((entry) => entry.document.id === workflowId);
  if (matches.length > 1) {
    const names = matches.map((entry) => path.basename(entry.path)).join(", ");
    fail(`${workflowId}: id is declared by ${names}.`);
  }
  if (matches.length === 0) fail(`Workflow not found: ${workflowId}`);
  return requireStages(loadWorkflowDocument(matches[0]!.path));
}

export function loadWorkflowCatalog(workspace: string): WorkflowCatalog {
  const { loaded, problems } = readWorkflowDirectory(workspace);
  if (loaded.length === 0) return { documents: {}, problems };
  const failedIds = unreadableWorkflowIds(problems);
  const grouped = new Map<string, LoadedWorkflow[]>();
  for (const entry of loaded) {
    const list = grouped.get(entry.document.id);
    if (list === undefined) grouped.set(entry.document.id, [entry]);
    else list.push(entry);
  }
  const documents: Record<string, WorkflowDocument> = {};
  for (const [workflowId, entries] of grouped) {
    if (entries.length > 1) {
      const names = entries.map((entry) => path.basename(entry.path)).join(", ");
      problems.push(`${workflowId}: id is declared by ${names}.`);
      failedIds.add(workflowId);
      continue;
    }
    const document = entries[0]!.document;
    documents[workflowId] = document;
    if (Object.keys(document.stages).length === 0) {
      problems.push(`${document.id}: declares no stages.`);
    }
  }
  for (const [workflowId, document] of Object.entries(documents)) {
    if (document.requires !== null) {
      checkRequires(workflowId, document.requires, documents, failedIds, problems);
    }
    for (const next of document.downstream ?? []) {
      if (!Object.hasOwn(documents, next.workflow)) problems.push(`${workflowId}: downstream workflow ${next.workflow} is not in .migent/workflows.`);
    }
  }
  return { documents, problems };
}

export function loadWorkflowDocument(filePath: string): WorkflowDocument {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`Unable to read workflow: ${filePath} (${reason})`);
  }
  const data = parseYamlDocument(text);
  if (!isRecord(data)) throw new ConfigurationError(`Workflow must be a mapping: ${filePath}`);
  return parseWorkflowMapping(data, filePath);
}

/** Parse a workflow mapping. `source` is stored on the document and is not read from `data`. */
export function parseWorkflowMapping(data: Record<string, unknown>, source: string): WorkflowDocument {
  const workflowId = documentId(data, source);
  const schemaVersion = documentVersion(data);
  if (schemaVersion > SCHEMA_VERSION) {
    throw new ConfigurationError(
      `workflow schema_version ${schemaVersion} is newer than this Migent (${SCHEMA_VERSION}).`,
    );
  }
  const version2 = schemaVersion >= 2;
  if (schemaVersion >= 4 && Object.hasOwn(data, "requires")) {
    throw new ConfigurationError("requires was removed in schema_version 4. Run `migent migrate`; use --prior for context and downstream for suggestions.");
  }
  if (schemaVersion < 4 && Object.hasOwn(data, "downstream")) {
    throw new ConfigurationError("downstream requires schema_version 4.");
  }
  if (version2 && Object.hasOwn(data, "completion") && data.completion != null) {
    throw new ConfigurationError("schema_version 2 does not allow completion. Run `migent migrate`.");
  }
  const stages = parseStages(data.stages, version2, schemaVersion >= 3);
  const completion =
    !version2 && isRecord(data.completion) && Object.keys(stages).length > 0
      ? parseCompletion(data.completion, stages)
      : null;
  const outputs = version2 ? parseTopLevelOutputs(data.outputs, stages) : undefined;
  validateConditionalStages(stages, outputs ?? []);
  const concurrency = version2 ? parseConcurrency(data) : undefined;
  validateVerifyPaths(stages, completion, version2);
  return workflowDocumentSchema.parse({
    id: workflowId,
    stages,
    completion,
    requires: parseRequires(data.requires, version2),
    constraints: stringItems(data.constraints, "constraints"),
    source,
    schemaVersion,
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(outputs === undefined ? {} : { outputs }),
    ...(schemaVersion >= 4 ? { downstream: parseDownstream(data.downstream, outputs ?? []) } : {}),
  });
}

function parseDownstream(raw: unknown, outputs: readonly WorkflowOutput[]): WorkflowDownstream[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ConfigurationError("downstream must be a list.");
  const seen = new Set<string>();
  return raw.map((entry) => {
    if (!isRecord(entry)) throw new ConfigurationError("downstream entries must be mappings.");
    for (const key of Object.keys(entry)) {
      if (!["workflow", "task", "artifacts"].includes(key)) throw new ConfigurationError(`Unknown downstream field: ${key}.`);
    }
    const workflow = requiredString(entry.workflow, "downstream.workflow");
    if (isPathReference(workflow)) throw new ConfigurationError("downstream.workflow must be a workflow id, not a path.");
    if (seen.has(workflow)) throw new ConfigurationError(`Duplicate downstream workflow: ${workflow}.`);
    seen.add(workflow);
    const task = requiredString(entry.task, "downstream.task");
    if (typeof entry.task === "string" && /[\r\n]/.test(entry.task)) throw new ConfigurationError("downstream.task must be a single line.");
    const mapping = entry.artifacts === undefined ? {} : entry.artifacts;
    if (!isRecord(mapping)) throw new ConfigurationError("downstream.artifacts must be a mapping.");
    const artifacts: Record<string, string> = {};
    for (const [name, source] of Object.entries(mapping)) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || name === "__proto__" || name === "constructor" || name === "prototype") {
        throw new ConfigurationError(`Invalid downstream artifact name: ${name}.`);
      }
      const output = requiredString(source, `downstream.artifacts.${name}`);
      if (!outputs.some((item) => item.name === output)) throw new ConfigurationError(`downstream.artifacts.${name}: unknown output ${output}.`);
      artifacts[name] = output;
    }
    return { workflow, task, artifacts };
  });
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
  return stage === null ? null : stage.artifact;
}

interface LoadedWorkflow {
  path: string;
  document: WorkflowDocument;
}

function readableWorkflows(workspace: string): LoadedWorkflow[] {
  return readWorkflowDirectory(workspace).loaded;
}

function readWorkflowDirectory(workspace: string): { loaded: LoadedWorkflow[]; problems: string[] } {
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
      loaded.push({ path: filePath, document: loadWorkflowDocument(filePath) });
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      problems.push(`${path.basename(filePath)}: ${error.message}`);
    }
  }
  return { loaded, problems };
}

function unreadableWorkflowIds(problems: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const problem of problems) {
    const name = problem.split(":", 1)[0] ?? "";
    if (name.endsWith(".yaml") || name.endsWith(".yml")) found.add(path.parse(name).name);
  }
  return found;
}

function requireStages(document: WorkflowDocument): WorkflowDocument {
  if (Object.keys(document.stages).length === 0) fail(`${document.id}: declares no stages.`);
  return document;
}

function checkRequires(
  workflowId: string,
  requires: WorkflowRequires,
  documents: Record<string, WorkflowDocument>,
  failedIds: Set<string>,
  problems: string[],
): void {
  const required = documents[requires.workflow];
  if (required === undefined) {
    if (failedIds.has(requires.workflow)) {
      problems.push(`${workflowId}: requires ${requires.workflow}, which failed to load.`);
    } else {
      problems.push(
        `${workflowId}: requires workflow ${requires.workflow}, which is not in .migent/workflows.`,
      );
    }
    return;
  }
  if ((documents[workflowId]?.schemaVersion ?? 1) >= 2) return;
  const decision = required.completion === null ? null : required.completion.decision;
  if (requires.decision === null || decision === null || decision.toLowerCase() !== requires.decision) {
    const actual = decision === null ? "no decision" : decision;
    problems.push(
      `${workflowId}: requires ${requires.workflow} to complete with ${requires.decision}, but it completes with ${actual}.`,
    );
  }
}

function isPathReference(reference: string): boolean {
  return (
    reference.endsWith(".yaml") ||
    reference.endsWith(".yml") ||
    reference.includes("/") ||
    reference.includes("\\") ||
    path.isAbsolute(reference)
  );
}

function resolveWorkflowPath(workspace: string, reference: string): string | null {
  if (path.isAbsolute(reference)) return isFile(reference) ? reference : null;
  const relative = path.join(workspace, reference);
  if (isFile(relative)) return relative;
  if (path.dirname(reference) === ".") {
    const named = path.join(workflowsDirectory(workspace), path.basename(reference));
    if (isFile(named)) return named;
  }
  return null;
}

function parseConcurrency(data: Record<string, unknown>): number {
  if (!Object.hasOwn(data, "concurrency") || data.concurrency == null) return 1;
  const raw = data.concurrency;
  let value = raw;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) value = Number(value.trim());
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ConfigurationError("concurrency must be a positive integer.");
  }
  return value;
}

function documentId(data: Record<string, unknown>, filePath: string): string {
  if (!Object.hasOwn(data, "id") || data.id == null) {
    const stem = path.parse(filePath).name.trim();
    if (stem === "") throw new ConfigurationError("Missing or invalid id.");
    return stem;
  }
  return requiredString(data.id, "id");
}

function parseStages(raw: unknown, version2 = false, version3 = false): Record<string, StageSpec> {
  if (!Array.isArray(raw) || raw.length === 0) return {};
  const stages: Record<string, StageSpec> = {};
  const items: Record<string, unknown>[] = [];
  for (const rawItem of raw) {
    if (!isRecord(rawItem)) throw new ConfigurationError("Workflow stage must be a mapping.");
    const item = version3 ? normalizeStageDecision(rawItem) : rawItem;
    const stageId = requiredString(item.id, "stages.id");
    if (Object.hasOwn(stages, stageId)) throw new ConfigurationError(`Duplicate stage id: ${stageId}`);
    const description = stageDescription(item, stageId);
    const dependsOn = stageDependsOn(item, stageId);
    const verify = stageVerify(item, stageId);
    const runWhen = stageRunWhen(item, stageId, version2, verify);
    if (!stageHasRole(item)) {
      if (!version2 || verify.length === 0) {
        throw new ConfigurationError(`stages.${stageId}.role is required.`);
      }
      rejectRoleOnlyKeys(item, stageId);
      stages[stageId] = stageSpecSchema.parse({
        kind: "verify",
        id: stageId,
        description,
        role: null,
        artifact: null,
        decisionValues: [],
        dependsOn,
        resumeFrom: null,
        instructions: [],
        modelName: null,
        options: {},
        maxRevisions: null,
        routes: {},
        verify,
        maxVerify: 0,
        verifyTimeoutSec: stageVerifyTimeout(item, stageId, verify),
        runWhen,
      });
      items.push(item);
      continue;
    }
    const role = requiredString(item.role, `stages.${stageId}.role`);
    const artifact = stageArtifact(item, stageId);
    if (verify.length > 0 && artifact === VERIFY_ARTIFACT) {
      throw new ConfigurationError(
        `stages.${stageId}.produces.artifact cannot be ${VERIFY_ARTIFACT} on a stage with verify.`,
      );
    }
    stages[stageId] = stageSpecSchema.parse({
      kind: "role",
      id: stageId,
      description,
      role,
      ...(Object.hasOwn(item, "ask") ? { ask: stageAsk(item, stageId) } : {}),
      artifact,
      decisionValues: stageDecisionValues(item, stageId),
      ...(version3 && isRecord(item.decision) ? { decisionInstructions: item.decision.instructions } : {}),
      dependsOn,
      resumeFrom: stageResumeFrom(item, stageId, dependsOn),
      instructions: stringItems(item.instructions, `stages.${stageId}.instructions`),
      modelName: optionalStageString(item, "model", stageId),
      options: stageOptions(item, stageId),
      maxRevisions: stageMaxRevisions(item, stageId),
      routes: {},
      verify,
      maxVerify: stageMaxVerify(item, stageId, verify),
      verifyTimeoutSec: stageVerifyTimeout(item, stageId, verify),
      runWhen,
    });
    items.push(item);
  }
  for (const item of items) {
    const stageId = requiredString(item.id, "stages.id");
    const stage = stages[stageId]!;
    stage.routes = stageRoutes(item, stageId, stage.decisionValues, stages, version2);
  }
  validateStageGraph(stages);
  return stages;
}

function stageRunWhen(
  stage: Record<string, unknown>,
  stageId: string,
  version2: boolean,
  verify: readonly string[],
): RunWhen | null {
  if (!Object.hasOwn(stage, "run_when") || stage.run_when == null) return null;
  const field = `stages.${stageId}.run_when`;
  if (!version2) throw new ConfigurationError(`${field} requires schema_version 2.`);
  const runWhen = stage.run_when;
  if (!isRecord(runWhen)) throw new ConfigurationError(`${field} must be a mapping.`);
  for (const key of Object.keys(runWhen)) {
    if (key !== "changed_paths") throw new ConfigurationError(`${field}.${key} is not supported.`);
  }
  if (!Object.hasOwn(runWhen, "changed_paths") || runWhen.changed_paths == null) {
    throw new ConfigurationError(`${field}.changed_paths is required.`);
  }
  const raw = runWhen.changed_paths;
  if (!Array.isArray(raw)) throw new ConfigurationError(`${field}.changed_paths must be a list.`);
  if (raw.length === 0) throw new ConfigurationError(`${field}.changed_paths must be a non-empty list.`);
  const changedPaths: string[] = [];
  raw.forEach((entry, index) => {
    const pattern = requiredString(entry, `${field}.changed_paths[${index}]`);
    if (changedPaths.includes(pattern)) {
      throw new ConfigurationError(`Duplicate ${field}.changed_paths item: ${pattern}`);
    }
    const compiled = compileChangedPathPattern(pattern);
    if ("error" in compiled) {
      throw new ConfigurationError(
        `Invalid ${field}.changed_paths[${index}]: ${pyRepr(pattern)} (${compiled.error}).`,
      );
    }
    changedPaths.push(pattern);
  });
  if (verify.length > 0) throw new ConfigurationError(`${field} cannot be combined with verify.`);
  return { changedPaths };
}

const reachCache = new WeakMap<Record<string, StageSpec>, Map<string, Set<string>>>();

/**
 * Stages a skip of `stageId` can leave without a current completion: the stage itself, its dependents,
 * and its forward route targets, repeated until nothing changes. A route back to a stage in the
 * member's dependency closure is not a forward target.
 */
export function conditionalReach(stages: Record<string, StageSpec>, stageId: string): Set<string> {
  let cache = reachCache.get(stages);
  if (cache === undefined) {
    cache = new Map();
    reachCache.set(stages, cache);
  }
  const cached = cache.get(stageId);
  if (cached !== undefined) return cached;
  const reach = new Set<string>([stageId]);
  const pending = [stageId];
  while (pending.length > 0) {
    const member = pending.pop()!;
    const found: string[] = [];
    for (const other of Object.values(stages)) {
      if (other.dependsOn.includes(member)) found.push(other.id);
    }
    const closure = dependencyClosure(stages, member);
    for (const value of Object.values(stages[member]?.routes ?? {})) {
      for (const target of routeTargets(value)) {
        if (target !== "complete" && !closure.has(target)) found.push(target);
      }
    }
    for (const next of found) {
      if (reach.has(next) || !Object.hasOwn(stages, next)) continue;
      reach.add(next);
      pending.push(next);
    }
  }
  cache.set(stageId, reach);
  return reach;
}

/** Every stage in the reach of a run_when stage, mapped to the first run_when stage that reaches it. */
export function conditionalStages(stages: Record<string, StageSpec>): Map<string, string> {
  const members = new Map<string, string>();
  for (const stage of Object.values(stages)) {
    if (stage.runWhen == null) continue;
    for (const reached of conditionalReach(stages, stage.id)) {
      if (!members.has(reached)) members.set(reached, stage.id);
    }
  }
  return members;
}

function validateConditionalStages(stages: Record<string, StageSpec>, outputs: readonly WorkflowOutput[]): void {
  const members = conditionalStages(stages);
  if (members.size === 0) return;
  for (const stage of Object.values(stages)) {
    const source = members.get(stage.id);
    if (source === undefined || stage.verify.length === 0) continue;
    throw new ConfigurationError(
      `stages.${stage.id}.verify is reached through run_when stage ${source}; a skip would bypass this verify.`,
    );
  }
  for (const output of outputs) {
    const source = members.get(output.fromStage);
    if (source === undefined) continue;
    const origin =
      source === output.fromStage
        ? `run_when stage ${source}`
        : `stages.${output.fromStage}, which is reached through run_when stage ${source}`;
    throw new ConfigurationError(
      `outputs ${pyRepr(output.name)} comes from ${origin}; a skip would leave it missing.`,
    );
  }
}

function parseRequires(raw: unknown, version2 = false): WorkflowRequires | null {
  if (raw == null) return null;
  if (isRecord(raw) && Object.keys(raw).length === 0) return null;
  if (!isRecord(raw)) throw new ConfigurationError("requires must be a mapping.");
  if (version2 && Object.hasOwn(raw, "decision") && raw.decision != null) {
    throw new ConfigurationError("requires.decision is not allowed in schema_version 2.");
  }
  return workflowRequiresSchema.parse({
    workflow: requiredString(raw.workflow, "requires.workflow"),
    decision: version2 ? null : requiredString(raw.decision, "requires.decision").toLowerCase(),
  });
}

function stringItems(raw: unknown, field: string): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ConfigurationError(`${field} must be a list.`);
  return raw.map((item, index) => requiredString(item, `${field}[${index}]`));
}

function stageDependsOn(stage: Record<string, unknown>, stageId: string): string[] {
  if (!Object.hasOwn(stage, "depends_on") || stage.depends_on == null) return [];
  const raw = stage.depends_on;
  if (!Array.isArray(raw)) {
    throw new ConfigurationError(`stages.${stageId}.depends_on must be a list.`);
  }
  const parsed: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const value = requiredString(item, `stages.${stageId}.depends_on`);
    if (value === stageId) {
      throw new ConfigurationError(`stages.${stageId}.depends_on cannot include itself.`);
    }
    if (seen.has(value)) {
      throw new ConfigurationError(`Duplicate depends_on on stages.${stageId}: ${value}`);
    }
    seen.add(value);
    parsed.push(value);
  }
  return parsed;
}

function stageResumeFrom(
  stage: Record<string, unknown>,
  stageId: string,
  dependsOn: readonly string[],
): string | null {
  if (!Object.hasOwn(stage, "session") || stage.session == null) return null;
  const session = stage.session;
  if (isRecord(session) && Object.keys(session).length === 0) return null;
  if (!isRecord(session)) {
    throw new ConfigurationError(`stages.${stageId}.session must be a mapping.`);
  }
  if (!Object.hasOwn(session, "resume_from") || session.resume_from == null) return null;
  const value = requiredString(session.resume_from, `stages.${stageId}.session.resume_from`);
  if (!dependsOn.includes(value)) {
    throw new ConfigurationError(
      `stages.${stageId}.session.resume_from must be a dependency: ${value}`,
    );
  }
  return value;
}

/** Normalize the public v3 list into the scheduler's decision names and routes. */
function normalizeStageDecision(stage: Record<string, unknown>): Record<string, unknown> {
  if (stage.decision == null) return stage;
  const field = `stages.${String(stage.id)}.decision`;
  if (!Array.isArray(stage.decision) || stage.decision.length === 0) {
    throw new ConfigurationError(`${field} must be a non-empty list in schema_version 3. Run \`migent migrate\` for older workflows.`);
  }
  const values: string[] = [];
  const routes: Record<string, unknown> = Object.create(null);
  const instructions: Record<string, string> = Object.create(null);
  for (const entry of stage.decision) {
    if (!isRecord(entry) || Object.keys(entry).length !== 1) {
      throw new ConfigurationError(`${field} entries must each declare exactly one decision.`);
    }
    const rawName = Object.keys(entry)[0]!;
    const name = requiredString(rawName, field).toLowerCase();
    if (Object.hasOwn(routes, name)) throw new ConfigurationError(`Duplicate decision value on ${field}: ${name}`);
    const body = entry[rawName];
    if (!isRecord(body)) throw new ConfigurationError(`${field}.${name} must be a mapping.`);
    for (const key of Object.keys(body)) {
      if (key !== "when" && key !== "navigate") throw new ConfigurationError(`${field}.${name}.${key} is not allowed.`);
    }
    instructions[name] = requiredString(body.when, `${field}.${name}.when`);
    if (body.navigate == null) throw new ConfigurationError(`${field}.${name}.navigate is required.`);
    values.push(name);
    routes[name] = body.navigate;
  }
  return { ...stage, decision: { values, routes, instructions } };
}

function stageRoutes(
  stage: Record<string, unknown>,
  stageId: string,
  values: readonly string[],
  stages: Record<string, StageSpec>,
  version2 = false,
): Record<string, string | string[]> {
  if (values.length === 0) return {};
  const decision = stage.decision;
  if (!isRecord(decision)) return {};
  const routes = decision.routes;
  if (!isRecord(routes) || Object.keys(routes).length === 0) {
    throw new ConfigurationError(`stages.${stageId}.decision.routes must be a mapping.`);
  }
  const parsed: Record<string, string | string[]> = {};
  for (const [rawKey, rawTarget] of Object.entries(routes)) {
    const key = requiredString(rawKey, `stages.${stageId}.decision.routes`).toLowerCase();
    const field = `stages.${stageId}.decision.routes.${key}`;
    const target = routeTarget(rawTarget, field, stages, version2);
    if (typeof target === "string" && target !== "complete" && !Object.hasOwn(stages, target)) {
      throw new ConfigurationError(`${field} is not a declared stage: ${target}`);
    }
    if (Object.hasOwn(parsed, key)) {
      throw new ConfigurationError(`Duplicate route on stages.${stageId}: ${key}`);
    }
    parsed[key] = target;
  }
  const left = Object.keys(parsed).sort();
  const right = [...values].sort();
  if (left.length !== right.length || left.some((key, index) => key !== right[index])) {
    throw new ConfigurationError(
      `stages.${stageId}.decision.routes keys must match decision.values.`,
    );
  }
  return parsed;
}

function routeTarget(
  raw: unknown,
  field: string,
  stages: Record<string, StageSpec>,
  version2: boolean,
): string | string[] {
  if (!Array.isArray(raw)) return requiredString(raw, field);
  // A list is a fan-out route. Reporting it as a bad string would hide that.
  if (!version2) return requiredString(raw, field);
  if (raw.length === 0) throw new ConfigurationError(`${field} must be a non-empty list.`);
  const targets = raw.map((item, index) => requiredString(item, `${field}[${index}]`));
  if (targets.includes("complete")) throw new ConfigurationError(`${field} cannot list complete.`);
  for (const target of targets) {
    if (!Object.hasOwn(stages, target)) {
      throw new ConfigurationError(`${field} is not a declared stage: ${target}`);
    }
  }
  return targets;
}

/** A route value is one stage id, `complete`, or a list of stage ids. */
export function routeTargets(target: string | readonly string[] | undefined): readonly string[] {
  if (typeof target === "string") return [target];
  if (Array.isArray(target)) return target;
  return [];
}

export function routeListsStage(target: string | readonly string[] | undefined, stageId: string): boolean {
  return routeTargets(target).includes(stageId);
}

function validateStageGraph(stages: Record<string, StageSpec>): void {
  const targets = new Set<string>();
  for (const stage of Object.values(stages)) {
    for (const value of Object.values(stage.routes)) {
      for (const target of routeTargets(value)) {
        if (target !== "complete") targets.add(target);
      }
    }
  }
  for (const stage of Object.values(stages)) {
    for (const dep of stage.dependsOn) {
      if (!Object.hasOwn(stages, dep)) {
        throw new ConfigurationError(
          `stages.${stage.id}.depends_on is not a declared stage: ${dep}`,
        );
      }
    }
    if (stage.maxRevisions !== null && !targets.has(stage.id)) {
      throw new ConfigurationError(
        `stages.${stage.id}.max_revisions requires a route back to ${stage.id}.`,
      );
    }
    if (stage.resumeFrom !== null && !isRoleStage(stages[stage.resumeFrom]!)) {
      throw new ConfigurationError(
        `stages.${stage.id}.session.resume_from must name a role stage: ${stage.resumeFrom}.`,
      );
    }
  }
}

function stageAsk(stage: Record<string, unknown>, stageId: string): AskTarget {
  if (stage.ask !== "human") throw new ConfigurationError(`stages.${stageId}.ask must be human.`);
  return "human";
}

const ROLE_ONLY_KEYS = [
  "ask",
  "instructions",
  "model",
  "options",
  "session",
  "produces",
  "decision",
  "max_revisions",
  "max_verify",
] as const;

function stageHasRole(stage: Record<string, unknown>): boolean {
  return Object.hasOwn(stage, "role") && stage.role != null;
}

function rejectRoleOnlyKeys(stage: Record<string, unknown>, stageId: string): void {
  if (Object.hasOwn(stage, "ask")) throw new ConfigurationError(`stages.${stageId}.ask requires a role.`);
  for (const key of ROLE_ONLY_KEYS) {
    if (Object.hasOwn(stage, key) && stage[key] != null) {
      throw new ConfigurationError(`stages.${stageId}.${key} requires a role.`);
    }
  }
}

function stageDescription(stage: Record<string, unknown>, stageId: string): string | null {
  const description = optionalStageString(stage, "description", stageId);
  if (description !== null && /[\r\n]/.test(description)) {
    throw new ConfigurationError(`stages.${stageId}.description must be one line.`);
  }
  return description;
}

function stageDecisionValues(stage: Record<string, unknown>, stageId: string): string[] {
  if (!Object.hasOwn(stage, "decision") || stage.decision == null) return [];
  const decision = stage.decision;
  if (isRecord(decision) && Object.keys(decision).length === 0) return [];
  if (!isRecord(decision)) {
    throw new ConfigurationError(`stages.${stageId}.decision must be a mapping.`);
  }
  const values = decision.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new ConfigurationError(`stages.${stageId}.decision.values must be a non-empty list.`);
  }
  const parsed: string[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    const value = requiredString(item, `stages.${stageId}.decision.values`).toLowerCase();
    if (seen.has(value)) {
      throw new ConfigurationError(`Duplicate decision value on stages.${stageId}: ${value}`);
    }
    seen.add(value);
    parsed.push(value);
  }
  return parsed;
}

function stageArtifact(stage: Record<string, unknown>, stageId: string): string | null {
  if (!Object.hasOwn(stage, "produces") || stage.produces == null) return null;
  const produces = stage.produces;
  if (isRecord(produces) && Object.keys(produces).length === 0) return null;
  if (!isRecord(produces)) {
    throw new ConfigurationError(`stages.${stageId}.produces must be a mapping.`);
  }
  if (!Object.hasOwn(produces, "artifact") || produces.artifact == null) return null;
  return filename(produces.artifact, `stages.${stageId}.produces.artifact`);
}

function parseTopLevelOutputs(raw: unknown, stages: Record<string, StageSpec>): WorkflowOutput[] {
  if (raw == null) return [];
  return parseOutputItems(raw, stages, "outputs");
}

function parseOutputItems(
  raw: unknown,
  stages: Record<string, StageSpec>,
  field: string,
): WorkflowOutput[] {
  let outputsRaw: unknown = raw === false ? [] : raw;
  if (isRecord(outputsRaw) && Object.keys(outputsRaw).length === 0) outputsRaw = [];
  if (!Array.isArray(outputsRaw)) throw new ConfigurationError(`${field} must be a list.`);
  const outputs: WorkflowOutput[] = [];
  const seen = new Set<string>();
  for (const item of outputsRaw) {
    if (!isRecord(item)) throw new ConfigurationError(`${field} item must be a mapping.`);
    const name = filename(item.name, `${field}.name`);
    const fromStage = requiredString(item.from_stage, `${field}.from_stage`);
    const artifact = filename(item.artifact, `${field}.artifact`);
    if (seen.has(name)) throw new ConfigurationError(`Duplicate ${field} name: ${name}`);
    if (!Object.hasOwn(stages, fromStage)) {
      throw new ConfigurationError(`${field}.from_stage is not a declared stage: ${fromStage}`);
    }
    const source = stages[fromStage]!;
    if (source.artifact === null) {
      throw new ConfigurationError(
        `${field} ${pyRepr(name)} references stage ${fromStage} which does not produce an artifact.`,
      );
    }
    if (source.artifact !== artifact) {
      throw new ConfigurationError(
        `${field} ${pyRepr(name)} artifact ${pyRepr(artifact)} does not match stages.${fromStage}.produces.artifact ${pyRepr(source.artifact)}.`,
      );
    }
    seen.add(name);
    outputs.push(workflowOutputSchema.parse({ name, fromStage, artifact }));
  }
  return outputs;
}

function parseCompletion(
  raw: Record<string, unknown>,
  stages: Record<string, StageSpec>,
): WorkflowCompletion {
  const stageId = requiredString(raw.stage, "completion.stage");
  if (!Object.hasOwn(stages, stageId)) {
    throw new ConfigurationError(`completion.stage is not a declared stage: ${stageId}`);
  }
  const decision = raw.decision == null ? null : requiredString(raw.decision, "completion.decision");
  const outputs = parseOutputItems(raw.outputs ?? [], stages, "completion.outputs");
  return workflowCompletionSchema.parse({ stage: stageId, decision, outputs });
}

function stageMaxRevisions(stage: Record<string, unknown>, stageId: string): number | null {
  if (!Object.hasOwn(stage, "max_revisions")) return null;
  const raw = stage.max_revisions;
  const field = `stages.${stageId}.max_revisions`;
  // yaml@2 yields numbers. Digit strings match the subset parser.
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  throw new ConfigurationError(`${field} must be a non-negative integer.`);
}

function stageVerify(stage: Record<string, unknown>, stageId: string): string[] {
  if (!Object.hasOwn(stage, "verify") || stage.verify == null) return [];
  const field = `stages.${stageId}.verify`;
  const raw = Array.isArray(stage.verify) ? stage.verify : [stage.verify];
  if (raw.length === 0) throw new ConfigurationError(`${field} must not be empty.`);
  return raw.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new ConfigurationError(`Missing or invalid ${field} item.`);
    }
    const command = entry.trim();
    if (/[\r\n]/.test(command)) {
      throw new ConfigurationError(`${field} items must be one shell line.`);
    }
    return command;
  });
}

function stageMaxVerify(stage: Record<string, unknown>, stageId: string, verify: string[]): number {
  if (!Object.hasOwn(stage, "max_verify") || stage.max_verify == null) return 3;
  const field = `stages.${stageId}.max_verify`;
  if (verify.length === 0) throw new ConfigurationError(`${field} requires verify.`);
  return positiveInteger(stage.max_verify, field);
}

function stageVerifyTimeout(
  stage: Record<string, unknown>,
  stageId: string,
  verify: string[],
): number | null {
  if (!Object.hasOwn(stage, "verify_timeout") || stage.verify_timeout == null) return null;
  const field = `stages.${stageId}.verify_timeout`;
  if (verify.length === 0) throw new ConfigurationError(`${field} requires verify.`);
  return positiveInteger(stage.verify_timeout, field);
}

function positiveInteger(raw: unknown, field: string): number {
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) raw = Number(raw.trim());
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1) return raw;
  throw new ConfigurationError(`${field} must be an integer of at least 1.`);
}

function validateVerifyPaths(
  stages: Record<string, StageSpec>,
  completion: WorkflowCompletion | null,
  version2 = false,
): void {
  const points = new Set<string>();
  if (!version2 && completion !== null) points.add(completion.stage);
  for (const stage of Object.values(stages)) {
    if (Object.values(stage.routes).some((value) => routeTargets(value).includes("complete"))) points.add(stage.id);
    if (version2 && isLeafStage(stages, stage)) points.add(stage.id);
  }
  if (points.size === 0) return;
  for (const stage of Object.values(stages)) {
    if (stage.verify.length === 0) continue;
    for (const point of points) {
      if (point === stage.id || dependencyClosure(stages, point).has(stage.id)) continue;
      throw new ConfigurationError(
        `stages.${stage.id}.verify is not on every path to complete: ${point} does not depend on ${stage.id}.`,
      );
    }
  }
}

function isLeafStage(stages: Record<string, StageSpec>, stage: StageSpec): boolean {
  if (Object.keys(stage.routes).length > 0) return false;
  return !Object.values(stages).some((other) => other.dependsOn.includes(stage.id));
}

export function dependencyClosure(stages: Record<string, StageSpec>, stageId: string): Set<string> {
  const seen = new Set<string>();
  const pending = [...(stages[stageId]?.dependsOn ?? [])];
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    pending.push(...(stages[next]?.dependsOn ?? []));
  }
  return seen;
}

function stageOptions(stage: Record<string, unknown>, stageId: string): Record<string, string> {
  if (!Object.hasOwn(stage, "options") || stage.options == null) return {};
  const raw = stage.options;
  if (!isRecord(raw)) throw new ConfigurationError(`Missing or invalid stages.${stageId}.options.`);
  return readOptionMap(raw, `stages.${stageId}.options`);
}

export function readOptionMap(raw: Record<string, unknown>, field: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (!optionKey.test(key)) throw new ConfigurationError(`Missing or invalid ${field} key.`);
    if (typeof item !== "string" || item.trim() === "") {
      throw new ConfigurationError(`Missing or invalid ${field}.${key}.`);
    }
    parsed[key] = item.trim();
  }
  return parsed;
}

function optionalStageString(
  stage: Record<string, unknown>,
  key: string,
  stageId: string,
): string | null {
  if (!Object.hasOwn(stage, key)) return null;
  return requiredString(stage[key], `stages.${stageId}.${key}`);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigurationError(`Missing or invalid ${field}.`);
  }
  return value.trim();
}

function filename(value: unknown, field: string): string {
  const text = requiredString(value, field);
  if (text.includes("/") || text.includes("\\") || text === "." || text === "..") {
    throw new ConfigurationError(`Invalid ${field}: ${pyRepr(text)}`);
  }
  return text;
}

function fail(message: string): never {
  throw new ConfigurationError(message);
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDir(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}
