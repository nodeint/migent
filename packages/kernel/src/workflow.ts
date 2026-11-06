import { readdirSync, readFileSync, statSync } from "node:fs";
import { UNKNOWN_KEYS_ERROR_SCHEMA_VERSION, unknownWorkflowKeyEntries, unknownWorkflowKeys, stageErrorPath, workflowErrorPath, workflowRuleCode } from "./authoring-diagnostics.js";
import type { UnknownKey } from "./authoring-diagnostics.js";
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

/**
 * The agent a stage selects: a name in `agents`, or a complete inline definition kept as the raw
 * mapping for the config loader to validate. `null` means the role's own agent.
 */
export type StageAgent =
  | { kind: "named"; name: string }
  | { kind: "inline"; value: Record<string, unknown> };

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
  agent: StageAgent | null;
  /** Stage option layer of schema_version 4 and earlier. Always empty from version 5 on. */
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
  /** Authoring diagnostics from parsing; not part of the document schema. */
  warnings?: string[];
}

/** Accepted workflow and config document version. */
export const SCHEMA_VERSION = 5;

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
  agent: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("named"), name: z.string() }),
      z.object({ kind: z.literal("inline"), value: z.record(z.string(), z.unknown()) }),
    ])
    .nullable(),
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

/** A cross-workflow finding. `workflow` is the id it concerns; `files` the declaring files, when known. */
export interface CatalogProblem {
  code: "duplicate-id" | "no-stages" | "unknown-downstream" | "requires-invalid";
  message: string;
  workflow: string;
  files?: string[];
  /** Author-coordinate path of the node the problem is about, when the rule can name one. */
  path?: (string | number)[];
}

/** A catalog fact the draft parser may not have been able to read. */
export type CatalogFact<T> = { known: true; value: T } | { known: false };

/**
 * One workflow as the catalog rules see it. `document` is set when the workflow parsed completely;
 * the draft leaves it null and exposes only the parts it could read. Unknown parts skip the rules
 * that read them, so a broken draft never produces a follow-on catalog finding.
 */
export interface WorkflowCatalogEntry {
  file: string;
  document: WorkflowDocument | null;
  id: CatalogFact<string>;
  stagesDeclared: boolean;
  requires: CatalogFact<WorkflowRequires | null>;
  /** `index` is the entry's position in the author's list, kept when earlier entries were unreadable. */
  downstream: ReadonlyArray<{ workflow: CatalogFact<string>; index?: number }>;
}

/** Adapts a parsed document to a fully known catalog entry. */
export function catalogEntryFromDocument(file: string, document: WorkflowDocument): WorkflowCatalogEntry {
  return {
    file,
    document,
    id: { known: true, value: document.id },
    stagesDeclared: Object.keys(document.stages).length > 0,
    requires: { known: true, value: document.requires },
    downstream: (document.downstream ?? []).map((entry) => ({ workflow: { known: true, value: entry.workflow } })),
  };
}

/**
 * The cross-file rules of the catalog: duplicate ids, empty stages, `requires` and `downstream`.
 * Pure; `failedIds` names workflows that could not be parsed. Rules skip the facts an entry does not
 * know, so the results for fully parsed documents are unchanged.
 */
export function checkWorkflowCatalog(
  entries: ReadonlyArray<WorkflowCatalogEntry>,
  failedIds: ReadonlySet<string> = new Set(),
): { documents: Record<string, WorkflowDocument>; problems: CatalogProblem[] } {
  const failed = new Set(failedIds);
  const problems: CatalogProblem[] = [];
  const grouped = new Map<string, WorkflowCatalogEntry[]>();
  for (const entry of entries) {
    if (!entry.id.known) continue;
    const list = grouped.get(entry.id.value);
    if (list === undefined) grouped.set(entry.id.value, [entry]);
    else list.push(entry);
  }
  const documents: Record<string, WorkflowDocument> = {};
  for (const [workflowId, group] of grouped) {
    if (group.length > 1) {
      const files = group.map((entry) => entry.file);
      problems.push({ code: "duplicate-id", message: `${workflowId}: id is declared by ${files.join(", ")}.`, workflow: workflowId, files });
      failed.add(workflowId);
      continue;
    }
    const entry = group[0]!;
    if (entry.document !== null) documents[workflowId] = entry.document;
    if (!entry.stagesDeclared) {
      problems.push({ code: "no-stages", message: `${workflowId}: declares no stages.`, workflow: workflowId });
    }
  }
  for (const [workflowId, group] of grouped) {
    if (group.length > 1) continue;
    const entry = group[0]!;
    if (entry.requires.known && entry.requires.value !== null && !isDraftEntry(entries, entry.requires.value.workflow)) {
      const messages: string[] = [];
      checkRequires(workflowId, entry.requires.value, documents, failed, messages);
      for (const message of messages) problems.push({ code: "requires-invalid", message, workflow: workflowId });
    }
    for (const [index, next] of entry.downstream.entries()) {
      if (!next.workflow.known) continue;
      if (!Object.hasOwn(documents, next.workflow.value) && !isDraftEntry(entries, next.workflow.value)) {
        problems.push({
          code: "unknown-downstream",
          message: `${workflowId}: downstream workflow ${next.workflow.value} is not in .migent/workflows.`,
          workflow: workflowId,
          path: ["downstream", next.index ?? index, "workflow"],
        });
      }
    }
  }
  return { documents, problems };
}

/** True when `workflowId` names an entry the catalog could not fully parse (for example the draft). */
function isDraftEntry(entries: readonly WorkflowCatalogEntry[], workflowId: string): boolean {
  return entries.some((entry) => entry.document === null && entry.id.known && entry.id.value === workflowId);
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

const reportedWarnings = new Set<string>();
function warnOnce(message: string): void {
  if (reportedWarnings.has(message)) return;
  reportedWarnings.add(message);
  process.stderr.write(`warning: ${message}\n`);
}

/** Parse a workflow mapping. `source` is stored on the document and is not read from `data`. */
export function parseWorkflowMapping(data: Record<string, unknown>, source: string): WorkflowDocument {
  try {
    return parseWorkflowMappingUnchecked(data, source);
  } catch (error) {
    // Give every rule a stable code and an author-coordinate path without changing its message.
    if (!(error instanceof ConfigurationError) || (error.code !== undefined && error.path !== undefined)) throw error;
    const path = error.path ?? workflowErrorPath(error.message, data);
    throw new ConfigurationError(error.message, {
      code: error.code ?? workflowRuleCode(error.message),
      ...(path === undefined ? {} : { path }),
      ...(error.layer === undefined ? {} : { layer: error.layer }),
      ...(error.position === undefined ? {} : { position: error.position }),
    });
  }
}

function parseWorkflowMappingUnchecked(data: Record<string, unknown>, source: string): WorkflowDocument {
  const workflowId = documentId(data, source);
  const schemaVersion = documentVersion(data);
  if (schemaVersion > SCHEMA_VERSION) {
    throw new ConfigurationError(
      `workflow schema_version ${schemaVersion} is newer than this Migent (${SCHEMA_VERSION}).`,
    );
  }
  const version2 = schemaVersion >= 2;
  const unknown = unknownWorkflowKeys(data);
  if (unknown.length > 0 && schemaVersion >= UNKNOWN_KEYS_ERROR_SCHEMA_VERSION) {
    throw new ConfigurationError(`Unknown workflow keys: ${unknown.join(" ")}`);
  }
  if (schemaVersion >= 4 && Object.hasOwn(data, "requires")) {
    throw new ConfigurationError("requires was removed in schema_version 4. Run `migent migrate`; use --prior for context and downstream for suggestions.");
  }
  if (schemaVersion < 4 && Object.hasOwn(data, "downstream")) {
    throw new ConfigurationError("downstream requires schema_version 4.");
  }
  if (version2 && Object.hasOwn(data, "completion") && data.completion != null) {
    throw new ConfigurationError("schema_version 2 does not allow completion. Run `migent migrate`.");
  }
  const stages = parseStages(data.stages, version2, schemaVersion >= 3, schemaVersion >= 5);
  const completion =
    !version2 && isRecord(data.completion) && Object.keys(stages).length > 0
      ? parseCompletion(data.completion, stages)
      : null;
  const outputs = version2 ? parseTopLevelOutputs(data.outputs, stages) : undefined;
  validateConditionalStages(stages, outputs ?? []);
  const concurrency = version2 ? parseConcurrency(data) : undefined;
  validateVerifyPaths(stages, completion, version2);
  const document: WorkflowDocument = workflowDocumentSchema.parse({
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
  if (unknown.length > 0) document.warnings = unknown;
  return document;
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

function readWorkflowDirectory(workspace: string, options: LoadWorkflowOptions = {}): { loaded: LoadedWorkflow[]; problems: string[] } {
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

function parseStages(raw: unknown, version2 = false, version3 = false, version5 = false): Record<string, StageSpec> {
  if (!Array.isArray(raw) || raw.length === 0) return {};
  const stages: Record<string, StageSpec> = {};
  const items: Record<string, unknown>[] = [];
  const rawItems: unknown[] = [];
  for (const [index, rawItem] of raw.entries()) {
    try {
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
        agent: null,
        options: {},
        maxRevisions: null,
        routes: {},
        verify,
        maxVerify: 0,
        verifyTimeoutSec: stageVerifyTimeout(item, stageId, verify),
        runWhen,
      });
      items.push(item);
      rawItems.push(rawItem);
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
      agent: version5 ? stageAgent(item, stageId) : legacyStageModel(item, stageId),
      options: version5 ? {} : stageOptions(item, stageId),
      maxRevisions: stageMaxRevisions(item, stageId),
      routes: {},
      verify,
      maxVerify: stageMaxVerify(item, stageId, verify),
      verifyTimeoutSec: stageVerifyTimeout(item, stageId, verify),
      runWhen,
    });
    items.push(item);
    rawItems.push(rawItem);
    } catch (error) {
      throw locatedAtStage(error, index, rawItem);
    }
  }
  for (const [index, item] of items.entries()) {
    try {
      const stageId = requiredString(item.id, "stages.id");
      const stage = stages[stageId]!;
      stage.routes = stageRoutes(item, stageId, stage.decisionValues, stages, version2);
    } catch (error) {
      throw locatedAtStage(error, index, rawItems[index]);
    }
  }
  validateStageGraph(stages);
  return stages;
}

/** Gives a parse error raised while reading stage `index` its code and author-coordinate path. */
function locatedAtStage(error: unknown, index: number, item: unknown): unknown {
  if (!(error instanceof ConfigurationError) || error.path !== undefined) return error;
  const path = stageErrorPath(error.message, index, item);
  return new ConfigurationError(error.message, {
    code: error.code ?? workflowRuleCode(error.message),
    path,
    ...(error.layer === undefined ? {} : { layer: error.layer }),
    ...(error.position === undefined ? {} : { position: error.position }),
  });
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
  const value = stageResumeFromUnchecked(stage, stageId);
  if (value === null) return null;
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
    if (body.when !== undefined) instructions[name] = requiredString(body.when, `${field}.${name}.when`);
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
  "agent",
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

/** Schema_version 5: `agent` is a name in `agents` or a complete inline definition. */
function stageAgent(stage: Record<string, unknown>, stageId: string): StageAgent | null {
  if (!Object.hasOwn(stage, "agent") || stage.agent == null) return null;
  const raw = stage.agent;
  if (isRecord(raw)) return { kind: "inline", value: structuredClone(raw) };
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ConfigurationError(`Missing or invalid stages.${stageId}.agent.`);
  }
  return { kind: "named", name: raw.trim() };
}

/** Schema_version 4 and earlier: `model` names an entry of the config's model aliases. */
function legacyStageModel(stage: Record<string, unknown>, stageId: string): StageAgent | null {
  const name = optionalStageString(stage, "model", stageId);
  return name === null ? null : { kind: "named", name };
}

function stageOptions(stage: Record<string, unknown>, stageId: string): Record<string, string> {
  if (!Object.hasOwn(stage, "options") || stage.options == null) return {};
  const raw = stage.options;
  if (!isRecord(raw)) throw new ConfigurationError(`Missing or invalid stages.${stageId}.options.`);
  return readOptionMap(raw, `stages.${stageId}.options`);
}

/** `path` is the literal key path of `field`, for errors that must say where the problem sits. */
export function readOptionMap(
  raw: Record<string, unknown>,
  field: string,
  path?: readonly (string | number)[],
): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (!optionKey.test(key)) {
      throw new ConfigurationError(`Missing or invalid ${field} key.`, {
        code: "option-key-invalid",
        ...(path === undefined ? {} : { path: [...path, key] }),
      });
    }
    if (typeof item !== "string" || item.trim() === "") {
      throw new ConfigurationError(`Missing or invalid ${field}.${key}.`, {
        code: "option-invalid",
        ...(path === undefined ? {} : { path: [...path, key] }),
      });
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

/* ------------------------------------------------------------------------------------------------
 * Collecting draft parse
 *
 * The authoring path reports every independent problem instead of stopping at the first. The rules
 * are shared with `parseWorkflowMapping`: each field is read by the same helper, but a failure is
 * recorded and the next field is read. The full `WorkflowDocument` is still built by
 * `parseWorkflowMapping`, so runtime parsing and its messages are unchanged.
 * ---------------------------------------------------------------------------------------------- */

/** One problem found while collecting a workflow draft. `path` uses author coordinates. */
export interface DraftProblem {
  code: string;
  message: string;
  path?: (string | number)[];
}

/** One leaf value: written, omitted (its default applies), or unreadable. */
export type DraftUnit<T> =
  | { state: "valid"; value: T }
  | { state: "absent"; value: T }
  | { state: "invalid" };

/** One stage as far as the draft could be read. `spec` is set when every field parsed. */
export interface DraftStage {
  index: number;
  id: string;
  kind: "role" | "verify" | null;
  role: DraftUnit<string>;
  options: DraftUnit<Record<string, string>>;
  dependsOn: DraftUnit<string[]>;
  verify: DraftUnit<string[]>;
  maxRevisions: DraftUnit<number | null>;
  maxVerify: DraftUnit<number>;
  verifyTimeoutSec: DraftUnit<number | null>;
  artifact: DraftUnit<string | null>;
  resumeFrom: DraftUnit<string | null>;
  runWhen: DraftUnit<RunWhen | null>;
  routes: DraftUnit<Record<string, string | string[]>>;
  /** The stage's agent selection: empty for schema <=4 when `model` is absent. */
  agent: DraftUnit<StageAgent | null>;
  spec: StageSpec | null;
  /** A role spec that config resolution can read when role, agent and options are readable. */
  roleStage: RoleStageSpec | null;
}

export interface DraftDownstreamEntry {
  index: number;
  workflow: DraftUnit<string>;
}

/** The result of collecting a workflow draft. Nothing here changes runtime parsing. */
export interface WorkflowDraftParse {
  problems: DraftProblem[];
  /** The full document, set only when nothing is incomplete. */
  document: WorkflowDocument | null;
  id: DraftUnit<string>;
  schemaVersion: number;
  stagesDeclared: boolean;
  declaredStageIds: Set<string>;
  stages: DraftStage[];
  requires: DraftUnit<WorkflowRequires | null>;
  downstream: DraftDownstreamEntry[];
  outputNames: Set<string>;
  /** True when every output entry parsed. */
  outputsComplete: boolean;
  unknownKeys: UnknownKey[];
  catalogEntry: WorkflowCatalogEntry;
}

class DraftProblems {
  readonly items: DraftProblem[] = [];

  add(error: unknown, fallbackPath?: readonly (string | number)[]): void {
    if (error instanceof z.ZodError) {
      this.items.push({
        code: "invalid-value",
        message: error.issues.map((issue) => issue.message).join("; "),
        ...(fallbackPath === undefined ? {} : { path: [...fallbackPath] }),
      });
      return;
    }
    if (!(error instanceof ConfigurationError)) throw error;
    const path = error.path ?? fallbackPath;
    this.items.push({
      code: error.code ?? workflowRuleCode(error.message),
      message: error.message,
      ...(path === undefined ? {} : { path: [...path] }),
    });
  }

  addMessage(code: string, message: string, path: readonly (string | number)[]): void {
    this.items.push({ code, message, path: [...path] });
  }
}

function draftUnit<T>(
  read: () => T,
  problems: DraftProblems,
  fallbackPath?: readonly (string | number)[],
): DraftUnit<T> {
  try {
    return { state: "valid", value: read() };
  } catch (error) {
    problems.add(error, fallbackPath);
    return { state: "invalid" };
  }
}

/** Placeholder stages for route parsing: only membership is read, never a field. */
function declaredStagePlaceholders(ids: Iterable<string>): Record<string, StageSpec> {
  const stages = Object.create(null) as Record<string, StageSpec>;
  for (const id of ids) stages[id] = null as unknown as StageSpec;
  return stages;
}

/** Author-coordinate path for a message raised after the per-stage reads. */
function draftPathFor(message: string, data: Record<string, unknown>): (string | number)[] {
  return workflowErrorPath(message, data) ?? ["stages"];
}

interface CollectedDecision {
  values: DraftUnit<string[]>;
  instructions: Record<string, string>;
  routes: DraftUnit<Record<string, string | string[]>>;
}

/** Reads the schema >= 3 decision list entry by entry, then resolves its routes one by one. */
function collectDecisionV3(
  item: Record<string, unknown>,
  stageId: string,
  index: number,
  declaredIds: ReadonlySet<string>,
  problems: DraftProblems,
): CollectedDecision {
  const field = `stages.${stageId}.decision`;
  const raw = item.decision;
  if (raw == null) {
    return { values: { state: "absent", value: [] }, instructions: {}, routes: { state: "absent", value: {} } };
  }
  const invalid: CollectedDecision = {
    values: { state: "invalid" },
    instructions: {},
    routes: { state: "invalid" },
  };
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.addMessage(
      "invalid-decision",
      `${field} must be a non-empty list in schema_version 3. Run \`migent migrate\` for older workflows.`,
      ["stages", index, "decision"],
    );
    return invalid;
  }
  let valid = true;
  const values: string[] = [];
  const instructions: Record<string, string> = {};
  const routesRaw: Record<string, unknown> = Object.create(null);
  const entryIndexByName = new Map<string, number>();
  const rawNameByName = new Map<string, string>();
  raw.forEach((entry, entryIndex) => {
    const entryPath: (string | number)[] = ["stages", index, "decision", entryIndex];
    if (!isRecord(entry) || Object.keys(entry).length !== 1) {
      problems.addMessage("invalid-decision", `${field} entries must each declare exactly one decision.`, entryPath);
      valid = false;
      return;
    }
    const rawName = Object.keys(entry)[0]!;
    const name = rawName.trim().toLowerCase();
    if (name === "") {
      problems.addMessage("invalid-value", `Missing or invalid ${field}.`, entryPath);
      valid = false;
      return;
    }
    if (Object.hasOwn(routesRaw, name)) {
      problems.addMessage("invalid-decision", `Duplicate decision value on ${field}: ${name}`, entryPath);
      valid = false;
      return;
    }
    const body = entry[rawName];
    if (!isRecord(body)) {
      problems.addMessage("invalid-decision", `${field}.${name} must be a mapping.`, [...entryPath, rawName]);
      valid = false;
      return;
    }
    let entryValid = true;
    for (const key of Object.keys(body)) {
      if (key !== "when" && key !== "navigate") {
        problems.addMessage("invalid-decision", `${field}.${name}.${key} is not allowed.`, [...entryPath, rawName, key]);
        entryValid = false;
      }
    }
    if (body.when !== undefined) {
      if (typeof body.when !== "string" || body.when.trim() === "") {
        problems.addMessage("invalid-value", `Missing or invalid ${field}.${name}.when.`, [...entryPath, rawName, "when"]);
        entryValid = false;
      } else {
        instructions[name] = body.when.trim();
      }
    }
    if (body.navigate == null) {
      problems.addMessage("missing-required", `${field}.${name}.navigate is required.`, [...entryPath, rawName, "navigate"]);
      entryValid = false;
    }
    if (!entryValid) {
      valid = false;
      return;
    }
    values.push(name);
    entryIndexByName.set(name, entryIndex);
    rawNameByName.set(name, rawName);
    routesRaw[name] = body.navigate;
  });
  // Readable entries keep their route checks even when another entry is malformed.
  const routes = collectRouteTargets(field, routesRaw, entryIndexByName, rawNameByName, index, declaredIds, problems);
  return {
    values: valid ? { state: "valid", value: values } : { state: "invalid" },
    instructions,
    routes: valid ? routes : { state: "invalid" },
  };
}

/** Resolves each route on its own, so one bad target does not hide the others. */
function collectRouteTargets(
  field: string,
  routes: Record<string, unknown>,
  entryIndexByName: ReadonlyMap<string, number>,
  rawNameByName: ReadonlyMap<string, string>,
  index: number,
  declaredIds: ReadonlySet<string>,
  problems: DraftProblems,
): DraftUnit<Record<string, string | string[]>> {
  const placeholders = declaredStagePlaceholders(declaredIds);
  const parsed: Record<string, string | string[]> = {};
  let valid = true;
  for (const [rawKey, rawTarget] of Object.entries(routes)) {
    const key = rawKey.trim().toLowerCase();
    const entryIndex = entryIndexByName.get(key);
    // The path keeps the author's key spelling, so it resolves in the draft text.
    const written = rawNameByName.get(key) ?? rawKey;
    const routePath: (string | number)[] =
      entryIndex === undefined
        ? ["stages", index, "decision"]
        : ["stages", index, "decision", entryIndex, written, "navigate"];
    if (key === "") {
      problems.addMessage("invalid-value", `Missing or invalid ${field}.routes.`, routePath);
      valid = false;
      continue;
    }
    try {
      // Schema >= 3 routes follow the runtime: a list is a fan-out, a scalar must be a stage.
      const target = routeTarget(rawTarget, `${field}.routes.${key}`, placeholders, true);
      if (typeof target === "string" && target !== "complete" && !declaredIds.has(target)) {
        throw new ConfigurationError(`${field}.routes.${key} is not a declared stage: ${target}`);
      }
      parsed[key] = target;
    } catch (error) {
      problems.add(error, routePath);
      valid = false;
    }
  }
  return valid ? { state: "valid", value: parsed } : { state: "invalid" };
}

function collectStage(
  rawItem: unknown,
  index: number,
  version2: boolean,
  version3: boolean,
  version5: boolean,
  declaredIds: ReadonlySet<string>,
  problems: DraftProblems,
): DraftStage | null {
  if (!isRecord(rawItem)) {
    problems.addMessage("invalid-value", "Workflow stage must be a mapping.", ["stages", index]);
    return null;
  }
  const before = problems.items.length;
  const report = (message: string): void => {
    problems.addMessage(workflowRuleCode(message), message, stageErrorPath(message, index, rawItem));
  };
  const read = <T>(fn: () => T): DraftUnit<T> => {
    try {
      return { state: "valid", value: fn() };
    } catch (error) {
      problems.add(error, stageErrorPath(error instanceof Error ? error.message : String(error), index, rawItem));
      return { state: "invalid" };
    }
  };

  const idUnit = read(() => requiredString(rawItem.id, "stages.id"));
  if (idUnit.state !== "valid") return null;
  const stageId = idUnit.value;

  const description = read(() => stageDescription(rawItem, stageId));
  const dependsOn = read(() => stageDependsOn(rawItem, stageId));
  const verify = read(() => stageVerify(rawItem, stageId));
  const runWhen = read(() =>
    stageRunWhen(rawItem, stageId, version2, verify.state === "invalid" ? [] : verify.value),
  );

  const hasRole = stageHasRole(rawItem);
  const verifyOnly =
    !hasRole && version2 && verify.state !== "invalid" && verify.value.length > 0;
  const role: DraftUnit<string> = hasRole
    ? read(() => requiredString(rawItem.role, `stages.${stageId}.role`))
    : { state: "absent", value: "" };
  if (!hasRole && !verifyOnly) report(`stages.${stageId}.role is required.`);
  const kind: DraftStage["kind"] = hasRole ? "role" : verifyOnly ? "verify" : null;
  if (kind === "verify") {
    if (Object.hasOwn(rawItem, "ask")) report(`stages.${stageId}.ask requires a role.`);
    for (const key of ROLE_ONLY_KEYS) {
      if (Object.hasOwn(rawItem, key) && rawItem[key] != null) report(`stages.${stageId}.${key} requires a role.`);
    }
  }

  const roleFields = kind === "role";
  // `produces` stays readable without a role: output checks must not report a false missing artifact.
  // A verify-only stage with `produces` is invalid on its own, so dependent checks skip it.
  const artifact: DraftUnit<string | null> =
    kind === "verify" && Object.hasOwn(rawItem, "produces") && rawItem.produces != null
      ? { state: "invalid" }
      : read(() => stageArtifact(rawItem, stageId));
  if (
    roleFields &&
    verify.state !== "invalid" &&
    artifact.state !== "invalid" &&
    verify.value.length > 0 &&
    artifact.value === VERIFY_ARTIFACT
  ) {
    report(`stages.${stageId}.produces.artifact cannot be ${VERIFY_ARTIFACT} on a stage with verify.`);
  }
  const ask: DraftUnit<AskTarget> = roleFields && Object.hasOwn(rawItem, "ask")
    ? read(() => stageAsk(rawItem, stageId))
    : ({ state: "absent", value: "human" } as const);
  const decision: CollectedDecision = roleFields
    ? version3
      ? collectDecisionV3(rawItem, stageId, index, declaredIds, problems)
      : {
          values: read(() => stageDecisionValues(rawItem, stageId)),
          instructions: {},
          routes: { state: "invalid" },
        }
    : { values: { state: "absent", value: [] }, instructions: {}, routes: { state: "absent", value: {} } };
  if (roleFields && !version3) {
    decision.routes =
      decision.values.state === "invalid"
        ? { state: "invalid" }
        : read(() =>
            stageRoutes(
              rawItem,
              stageId,
              decision.values.state === "invalid" ? [] : decision.values.value,
              declaredStagePlaceholders(declaredIds),
              version2,
            ),
          );
  }
  const instructions: DraftUnit<string[]> = roleFields
    ? read(() => stringItems(rawItem.instructions, `stages.${stageId}.instructions`))
    : { state: "absent", value: [] };
  const agentUnit: DraftUnit<StageAgent | null> = roleFields
    ? read(() => (version5 ? stageAgent(rawItem, stageId) : legacyStageModel(rawItem, stageId)))
    : { state: "absent", value: null };
  const options: DraftUnit<Record<string, string>> = roleFields && !version5
    ? read(() => stageOptions(rawItem, stageId))
    : { state: "absent", value: {} };
  const maxRevisions: DraftUnit<number | null> = roleFields
    ? read(() => stageMaxRevisions(rawItem, stageId))
    : { state: "absent", value: null };
  const maxVerify = read(() =>
    verify.state === "invalid"
      ? Object.hasOwn(rawItem, "max_verify") && rawItem.max_verify != null
        ? positiveInteger(rawItem.max_verify, `stages.${stageId}.max_verify`)
        : kind === "verify" ? 0 : 3
      : stageMaxVerify(rawItem, stageId, verify.value),
  );
  const verifyTimeoutSec = read(() =>
    verify.state === "invalid"
      ? Object.hasOwn(rawItem, "verify_timeout") && rawItem.verify_timeout != null
        ? positiveInteger(rawItem.verify_timeout, `stages.${stageId}.verify_timeout`)
        : null
      : stageVerifyTimeout(rawItem, stageId, verify.value),
  );
  const resumeFrom = read(() =>
    dependsOn.state === "invalid"
      ? stageResumeFromUnchecked(rawItem, stageId)
      : stageResumeFrom(rawItem, stageId, dependsOn.value),
  );

  const clean = problems.items.length === before;
  let spec: StageSpec | null = null;
  if (clean && kind !== null) {
    const common = {
      id: stageId,
      description: description.state === "invalid" ? null : description.value,
      dependsOn: dependsOn.state === "invalid" ? [] : dependsOn.value,
      resumeFrom: resumeFrom.state === "invalid" ? null : resumeFrom.value,
      instructions: instructions.state === "invalid" ? [] : instructions.value,
      agent: agentUnit.state === "invalid" ? null : agentUnit.value,
      options: options.state === "invalid" ? {} : options.value,
      maxRevisions: maxRevisions.state === "invalid" ? null : maxRevisions.value,
      routes: decision.routes.state === "invalid" ? {} : decision.routes.value,
      verify: verify.state === "invalid" ? [] : verify.value,
      maxVerify: maxVerify.state === "invalid" ? 3 : maxVerify.value,
      verifyTimeoutSec: verifyTimeoutSec.state === "invalid" ? null : verifyTimeoutSec.value,
      runWhen: runWhen.state === "invalid" ? null : runWhen.value,
      artifact: artifact.state === "invalid" ? null : artifact.value,
      decisionValues: decision.values.state === "invalid" ? [] : decision.values.value,
      ...(version3 && Object.keys(decision.instructions).length > 0
        ? { decisionInstructions: decision.instructions }
        : {}),
      ...(kind === "role" && ask.state === "valid" ? { ask: ask.value } : {}),
    };
    try {
      spec = stageSpecSchema.parse(
        kind === "role"
          ? { ...common, kind: "role", role: role.state === "invalid" ? "" : role.value }
          : { ...common, kind: "verify", role: null, verify: verify.state === "invalid" ? [] : verify.value, maxVerify: 0 },
      ) as StageSpec;
    } catch (error) {
      if (error instanceof ConfigurationError) {
        problems.add(error, stageErrorPath(error.message, index, rawItem));
      } else {
        problems.addMessage(
          "invalid-value",
          error instanceof Error ? error.message : String(error),
          ["stages", index],
        );
      }
      spec = null;
    }
  }

  const roleStage: RoleStageSpec | null =
    kind === "role" && role.state !== "invalid" && agentUnit.state !== "invalid" && options.state !== "invalid"
      ? {
          kind: "role",
          id: stageId,
          description: description.state === "invalid" ? null : description.value,
          artifact: artifact.state === "invalid" ? null : artifact.value,
          decisionValues: decision.values.state === "invalid" ? [] : decision.values.value,
          dependsOn: dependsOn.state === "invalid" ? [] : dependsOn.value,
          resumeFrom: resumeFrom.state === "invalid" ? null : resumeFrom.value,
          instructions: instructions.state === "invalid" ? [] : instructions.value,
          agent: agentUnit.value,
          options: options.value,
          maxRevisions: maxRevisions.state === "invalid" ? null : maxRevisions.value,
          routes: decision.routes.state === "invalid" ? {} : decision.routes.value,
          verify: verify.state === "invalid" ? [] : verify.value,
          maxVerify: maxVerify.state === "invalid" ? 3 : maxVerify.value,
          verifyTimeoutSec: verifyTimeoutSec.state === "invalid" ? null : verifyTimeoutSec.value,
          runWhen: runWhen.state === "invalid" ? null : runWhen.value,
          role: role.value,
          ...(ask.state === "valid" ? { ask: ask.value } : {}),
        }
      : null;

  return {
    index,
    id: stageId,
    kind,
    role,
    agent: agentUnit,
    options,
    dependsOn,
    verify,
    maxRevisions,
    maxVerify,
    verifyTimeoutSec,
    artifact,
    resumeFrom,
    runWhen,
    routes: decision.routes,
    spec,
    roleStage,
  };
}

interface CollectedOutputs {
  sectionValid: boolean;
  /** True when every output entry parsed. */
  complete: boolean;
  names: Set<string>;
  values: WorkflowOutput[];
  /** Raw list index of each value, for author-coordinate paths. */
  indexes: number[];
}

function collectOutputs(
  raw: unknown,
  stages: readonly DraftStage[],
  declaredIds: ReadonlySet<string>,
  problems: DraftProblems,
  field = "outputs",
  basePath: readonly (string | number)[] = [field],
): CollectedOutputs {
  const result: CollectedOutputs = { sectionValid: true, complete: true, names: new Set(), values: [], indexes: [] };
  let rawItems: unknown = raw === false ? [] : raw;
  if (rawItems == null || (isRecord(rawItems) && Object.keys(rawItems).length === 0)) rawItems = [];
  if (!Array.isArray(rawItems)) {
    problems.addMessage("invalid-value", `${field} must be a list.`, [...basePath]);
    return { sectionValid: false, complete: false, names: result.names, values: [], indexes: [] };
  }
  const artifactOf = (stageId: string): DraftUnit<string | null> | null =>
    stages.find((stage) => stage.id === stageId)?.artifact ?? null;
  rawItems.forEach((item, index) => {
    const entryPath: (string | number)[] = [...basePath, index];
    if (!isRecord(item)) {
      problems.addMessage("invalid-value", `${field} item must be a mapping.`, entryPath);
      result.complete = false;
      return;
    }
    let entryValid = true;
    const read = <T>(fn: () => T, suffix: string): T | null => {
      try {
        return fn();
      } catch (error) {
        problems.add(error, [...entryPath, suffix]);
        entryValid = false;
        result.complete = false;
        return null;
      }
    };
    const name = read(() => filename(item.name, `${field}.name`), "name");
    const fromStage = read(() => requiredString(item.from_stage, `${field}.from_stage`), "from_stage");
    const artifact = read(() => filename(item.artifact, `${field}.artifact`), "artifact");
    if (name !== null) {
      if (result.names.has(name)) {
        problems.addMessage("invalid-value", `Duplicate ${field} name: ${name}`, [...entryPath, "name"]);
        entryValid = false;
      }
      result.names.add(name);
    }
    if (fromStage !== null) {
      if (!declaredIds.has(fromStage)) {
        problems.addMessage(
          "unknown-stage",
          `${field}.from_stage is not a declared stage: ${fromStage}`,
          [...entryPath, "from_stage"],
        );
        entryValid = false;
      } else {
        const source = artifactOf(fromStage);
        if (source !== null && source.state !== "invalid" && name !== null && artifact !== null) {
          if (source.value === null) {
            problems.addMessage(
              "invalid-artifact",
              `${field} ${pyRepr(name)} references stage ${fromStage} which does not produce an artifact.`,
              entryPath,
            );
            entryValid = false;
          } else if (source.value !== artifact) {
            problems.addMessage(
              "invalid-artifact",
              `${field} ${pyRepr(name)} artifact ${pyRepr(artifact)} does not match stages.${fromStage}.produces.artifact ${pyRepr(source.value)}.`,
              [...entryPath, "artifact"],
            );
            entryValid = false;
          }
        }
      }
    }
    if (!entryValid) result.complete = false;
    if (entryValid && name !== null && fromStage !== null && artifact !== null) {
      result.values.push({ name, fromStage, artifact });
      result.indexes.push(index);
    }
  });
  return result;
}

function collectDownstream(
  raw: unknown,
  outputs: CollectedOutputs,
  problems: DraftProblems,
): { sectionValid: boolean; entries: DraftDownstreamEntry[] } {
  const field = "downstream";
  if (raw === undefined) return { sectionValid: true, entries: [] };
  if (!Array.isArray(raw)) {
    problems.addMessage("invalid-value", `${field} must be a list.`, [field]);
    return { sectionValid: false, entries: [] };
  }
  const entries: DraftDownstreamEntry[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const entryPath: (string | number)[] = [field, index];
    if (!isRecord(entry)) {
      problems.addMessage("invalid-value", `${field} entries must be mappings.`, entryPath);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!["workflow", "task", "artifacts"].includes(key)) {
        problems.addMessage(
          "invalid-downstream",
          `Unknown downstream field: ${key}.`,
          [...entryPath, key],
        );
      }
    }
    let workflow: DraftUnit<string> = { state: "invalid" };
    if (typeof entry.workflow === "string" && entry.workflow.trim() !== "") {
      const value = entry.workflow.trim();
      if (isPathReference(value)) {
        problems.addMessage(
          "invalid-downstream",
          "downstream.workflow must be a workflow id, not a path.",
          [...entryPath, "workflow"],
        );
      } else if (seen.has(value)) {
        problems.addMessage("invalid-downstream", `Duplicate downstream workflow: ${value}.`, [...entryPath, "workflow"]);
      } else {
        seen.add(value);
        workflow = { state: "valid", value };
      }
    } else {
      problems.addMessage("missing-required", "Missing or invalid downstream.workflow.", [...entryPath, "workflow"]);
    }
    if (typeof entry.task !== "string" || entry.task.trim() === "") {
      problems.addMessage("missing-required", "Missing or invalid downstream.task.", [...entryPath, "task"]);
    } else if (/[\r\n]/.test(entry.task)) {
      problems.addMessage("invalid-downstream", "downstream.task must be a single line.", [...entryPath, "task"]);
    }
    const mapping = entry.artifacts === undefined ? {} : entry.artifacts;
    if (!isRecord(mapping)) {
      problems.addMessage("invalid-downstream", "downstream.artifacts must be a mapping.", [...entryPath, "artifacts"]);
    } else {
      for (const [name, source] of Object.entries(mapping)) {
        const artifactPath = [...entryPath, "artifacts", name];
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || name === "__proto__" || name === "constructor" || name === "prototype") {
          problems.addMessage("invalid-downstream", `Invalid downstream artifact name: ${name}.`, artifactPath);
          continue;
        }
        if (typeof source !== "string" || source.trim() === "") {
          problems.addMessage("missing-required", `Missing or invalid downstream.artifacts.${name}.`, artifactPath);
          continue;
        }
        const output = source.trim();
        if (outputs.sectionValid && !outputs.names.has(output)) {
          problems.addMessage(
            "invalid-artifact",
            `downstream.artifacts.${name}: unknown output ${output}.`,
            artifactPath,
          );
        }
      }
    }
    entries.push({ index, workflow });
  });
  return { sectionValid: true, entries };
}

/** Reads `session.resume_from` without the dependency rule, for stages whose depends_on is unreadable. */
function stageResumeFromUnchecked(stage: Record<string, unknown>, stageId: string): string | null {
  if (!Object.hasOwn(stage, "session") || stage.session == null) return null;
  const session = stage.session;
  if (isRecord(session) && Object.keys(session).length === 0) return null;
  if (!isRecord(session)) {
    throw new ConfigurationError(`stages.${stageId}.session must be a mapping.`);
  }
  if (!Object.hasOwn(session, "resume_from") || session.resume_from == null) return null;
  return requiredString(session.resume_from, `stages.${stageId}.session.resume_from`);
}

/** Reads a string list for a top-level field, reporting each bad item on its own. */
function collectStringItems(raw: unknown, field: string, problems: DraftProblems): void {
  if (raw == null) return;
  if (!Array.isArray(raw)) {
    problems.addMessage("invalid-value", `${field} must be a list.`, [field]);
    return;
  }
  raw.forEach((item, index) => {
    draftUnit(() => requiredString(item, `${field}[${index}]`), problems, [field, index]);
  });
}

interface CollectedCompletion {
  /** The declared completion stage, when it is readable, for the verify-path points. */
  stage: string | null;
}

/** Reads `completion` as its own unit set, so a broken stage does not hide its errors. */
function collectCompletion(
  raw: Record<string, unknown>,
  stages: readonly DraftStage[],
  declaredIds: ReadonlySet<string>,
  problems: DraftProblems,
): CollectedCompletion {
  const stage = draftUnit(() => requiredString(raw.stage, "completion.stage"), problems, ["completion", "stage"]);
  let stageId: string | null = null;
  if (stage.state === "valid") {
    if (declaredIds.has(stage.value)) {
      stageId = stage.value;
    } else {
      problems.addMessage(
        "unknown-stage",
        `completion.stage is not a declared stage: ${stage.value}`,
        ["completion", "stage"],
      );
    }
  }
  if (raw.decision != null) {
    draftUnit(() => requiredString(raw.decision, "completion.decision"), problems, ["completion", "decision"]);
  }
  collectOutputs(raw.outputs ?? [], stages, declaredIds, problems, "completion.outputs", ["completion", "outputs"]);
  return { stage: stageId };
}

/** A stage view carrying only the fields the cross-stage rules read. */
function graphStageOf(stage: DraftStage): StageSpec {
  return {
    kind: "verify",
    role: null,
    id: stage.id,
    description: null,
    artifact: stage.artifact.state === "valid" ? stage.artifact.value : null,
    decisionValues: [],
    dependsOn: stage.dependsOn.state === "valid" ? stage.dependsOn.value : [],
    resumeFrom: null,
    instructions: [],
    agent: null,
    options: {},
    maxRevisions: stage.maxRevisions.state === "valid" ? stage.maxRevisions.value : null,
    routes: stage.routes.state === "valid" ? stage.routes.value : {},
    verify: stage.verify.state === "valid" ? stage.verify.value : [],
    maxVerify: 0,
    verifyTimeoutSec: null,
    runWhen: stage.runWhen.state === "valid" ? stage.runWhen.value : null,
  };
}

/** True when every stage `stageId` depends on, transitively, was collected with a readable list. */
function dependencyClosureKnown(
  stagesById: ReadonlyMap<string, DraftStage>,
  declaredIds: ReadonlySet<string>,
  stageId: string,
): boolean {
  const pending = [stageId];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    // A declared stage without a collected unit, or an unknown edge, leaves the closure unproven.
    if (!declaredIds.has(next)) return false;
    const stage = stagesById.get(next);
    if (stage === undefined) return false;
    if (stage.dependsOn.state !== "valid") return false;
    pending.push(...stage.dependsOn.value);
  }
  return true;
}

/** Stages a skip of `stageId` definitely leaves unreached, using only edges the draft made readable. */
function definiteConditionalReach(
  stages: readonly DraftStage[],
  graph: Record<string, StageSpec>,
  declaredIds: ReadonlySet<string>,
  stageId: string,
): Set<string> {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  // A route target is forward only when the member's whole dependency chain is readable.
  const closureKnown = (id: string): boolean => dependencyClosureKnown(byId, declaredIds, id);
  const reach = new Set<string>([stageId]);
  const pending = [stageId];
  while (pending.length > 0) {
    const member = pending.pop()!;
    const found: string[] = [];
    for (const other of stages) {
      if (other.dependsOn.state !== "valid") continue;
      if (other.dependsOn.value.includes(member)) found.push(other.id);
    }
    const stage = byId.get(member);
    if (stage !== undefined && stage.routes.state === "valid" && closureKnown(member)) {
      const closure = dependencyClosure(graph, member);
      for (const value of Object.values(stage.routes.value)) {
        for (const target of routeTargets(value)) {
          if (target !== "complete" && !closure.has(target)) found.push(target);
        }
      }
    }
    for (const next of found) {
      if (reach.has(next) || !byId.has(next)) continue;
      reach.add(next);
      pending.push(next);
    }
  }
  return reach;
}

/** The runtime's cross-stage rules over whatever each stage could read. A rule is skipped only when a
 * unit it reads is unreadable — never because an unrelated field or stage failed.
 */
function collectGraphProblems(
  stages: readonly DraftStage[],
  rawStageCount: number,
  declaredStageIds: ReadonlySet<string>,
  completionStage: string | null,
  outputs: CollectedOutputs,
  version2: boolean,
  problems: DraftProblems,
): void {
  // An unreadable id or a duplicate leaves some stage's fields unknown, but each check below reads only
  // what its own finding needs, so the rest of the graph is still checked.
  const structurallyComplete = stages.length === rawStageCount;
  const routesComplete = !stages.some((stage) => stage.routes.state === "invalid");
  const dependsComplete = !stages.some((stage) => stage.dependsOn.state === "invalid");
  const stagesById = new Map(stages.map((stage) => [stage.id, stage]));
  const graph: Record<string, StageSpec> = Object.create(null);
  for (const stage of stages) graph[stage.id] = graphStageOf(stage);

  // A missing route set or an uncollected stage could hide the route back, so both must be readable.
  if (routesComplete && structurallyComplete) {
    const targets = new Set<string>();
    for (const stage of Object.values(graph)) {
      for (const value of Object.values(stage.routes)) {
        for (const target of routeTargets(value)) if (target !== "complete") targets.add(target);
      }
    }
    for (const stage of stages) {
      if (stage.maxRevisions.state === "invalid" || stage.maxRevisions.value === null) continue;
      if (targets.has(stage.id)) continue;
      problems.addMessage(
        "invalid-value",
        `stages.${stage.id}.max_revisions requires a route back to ${stage.id}.`,
        ["stages", stage.index, "max_revisions"],
      );
    }
  }

  // Conditional reach uses only readable edges; anything found this way is definitely reached, so an
  // unrelated broken `depends_on`, unreadable stage, or malformed route elsewhere hides nothing.
  const reachedBy = new Map<string, string>();
  for (const source of stages) {
    if (source.runWhen.state !== "valid" || source.runWhen.value === null) continue;
    for (const member of definiteConditionalReach(stages, graph, declaredStageIds, source.id)) {
      if (!reachedBy.has(member)) reachedBy.set(member, source.id);
    }
  }
  for (const stage of stages) {
    const source = reachedBy.get(stage.id);
    if (source === undefined) continue;
    if (stage.verify.state === "invalid") continue;
    if (stage.verify.state === "valid" && stage.verify.value.length === 0) continue;
    problems.addMessage(
      "invalid-value",
      `stages.${stage.id}.verify is reached through run_when stage ${source}; a skip would bypass this verify.`,
      ["stages", stage.index, "verify"],
    );
  }
  outputs.values.forEach((output, at) => {
    const source = reachedBy.get(output.fromStage);
    if (source === undefined) return;
    const origin =
      source === output.fromStage
        ? `run_when stage ${source}`
        : `stages.${output.fromStage}, which is reached through run_when stage ${source}`;
    problems.addMessage(
      "invalid-artifact",
      `outputs ${pyRepr(output.name)} comes from ${origin}; a skip would leave it missing.`,
      ["outputs", outputs.indexes[at] ?? at, "from_stage"],
    );
  });

  // Each completion point is checked against its own dependency closure. A malformed `depends_on` or an
  // uncollected stage elsewhere cannot make a point's path unknown, and an unreadable point's own chain
  // is the only reason to skip that point.
  const points = new Set<string>();
  if (
    !version2 &&
    completionStage !== null &&
    dependencyClosureKnown(stagesById, declaredStageIds, completionStage)
  ) {
    points.add(completionStage);
  }
  for (const stage of stages) {
    if (stage.routes.state === "invalid") continue;
    if (!Object.values(stage.routes.value).some((value) => routeTargets(value).includes("complete"))) continue;
    if (!dependencyClosureKnown(stagesById, declaredStageIds, stage.id)) continue;
    points.add(stage.id);
  }
  // A leaf is only provable when every dependency list and every stage is readable, and the candidate's
  // own routes are readable too (an absent route set means it has none).
  if (version2 && dependsComplete && structurallyComplete) {
    for (const stage of stages) {
      if (stage.routes.state === "invalid") continue;
      if (isLeafStage(graph, graph[stage.id]!)) points.add(stage.id);
    }
  }
  if (points.size === 0) return;
  for (const stage of stages) {
    if (stage.verify.state !== "valid" || stage.verify.value.length === 0) continue;
    for (const point of points) {
      if (point === stage.id || dependencyClosure(graph, point).has(stage.id)) continue;
      problems.addMessage(
        "invalid-value",
        `stages.${stage.id}.verify is not on every path to complete: ${point} does not depend on ${stage.id}.`,
        ["stages", stage.index, "verify"],
      );
    }
  }
}

/**
 * Collects every independent problem of a workflow mapping. The rules are the runtime's; only the
 * failure handling differs. `document` is set only when nothing is incomplete, and it always comes
 * from `parseWorkflowMapping` so runtime parsing stays the one authority.
 */
export function collectWorkflowDraft(data: Record<string, unknown>, source: string): WorkflowDraftParse {
  const problems = new DraftProblems();
  const idUnit = draftUnit(() => documentId(data, source), problems, ["id"]);
  const versionUnit = draftUnit(() => documentVersion(data), problems, ["schema_version"]);
  const unknownKeys = unknownWorkflowKeyEntries(data);
  const emptyResult = (schemaVersion: number): WorkflowDraftParse => ({
    problems: problems.items,
    document: null,
    id: idUnit,
    schemaVersion,
    stagesDeclared: false,
    declaredStageIds: new Set(),
    stages: [],
    requires: { state: "invalid" },
    downstream: [],
    outputNames: new Set(),
    outputsComplete: false,
    unknownKeys,
    catalogEntry: {
      file: source,
      document: null,
      id: idUnit.state === "invalid" ? { known: false } : { known: true, value: idUnit.value },
      stagesDeclared: false,
      requires: { known: false },
      downstream: [],
    },
  });
  if (idUnit.state === "invalid" || versionUnit.state === "invalid") return emptyResult(0);
  const schemaVersion = versionUnit.value;
  const version2 = schemaVersion >= 2;
  const version3 = schemaVersion >= 3;
  const version5 = schemaVersion >= 5;
  if (schemaVersion > SCHEMA_VERSION) {
    problems.addMessage(
      "schema-newer",
      `workflow schema_version ${schemaVersion} is newer than this Migent (${SCHEMA_VERSION}).`,
      ["schema_version"],
    );
    return emptyResult(schemaVersion);
  }
  if (unknownKeys.length > 0 && schemaVersion >= UNKNOWN_KEYS_ERROR_SCHEMA_VERSION) {
    for (const entry of unknownKeys) problems.addMessage(entry.code, entry.message, entry.path);
  }
  if (schemaVersion >= 4 && Object.hasOwn(data, "requires")) {
    const message = "requires was removed in schema_version 4. Run `migent migrate`; use --prior for context and downstream for suggestions.";
    problems.addMessage(workflowRuleCode(message), message, ["requires"]);
  }
  if (schemaVersion < 4 && Object.hasOwn(data, "downstream")) {
    const message = "downstream requires schema_version 4.";
    problems.addMessage(workflowRuleCode(message), message, ["downstream"]);
  }
  if (version2 && Object.hasOwn(data, "completion") && data.completion != null) {
    const message = "schema_version 2 does not allow completion. Run `migent migrate`.";
    problems.addMessage(workflowRuleCode(message), message, ["completion"]);
  }

  const rawStages: unknown[] = Array.isArray(data.stages) ? data.stages : [];
  const stagesDeclared = rawStages.length > 0;
  const declaredStageIds = new Set<string>();
  const duplicateIndexes = new Set<number>();
  rawStages.forEach((item, index) => {
    if (!isRecord(item)) return;
    let value: string;
    try {
      value = requiredString(item.id, "stages.id");
    } catch {
      return;
    }
    if (declaredStageIds.has(value)) duplicateIndexes.add(index);
    declaredStageIds.add(value);
  });

  const stages: DraftStage[] = [];
  rawStages.forEach((item, index) => {
    if (duplicateIndexes.has(index)) {
      const id = isRecord(item) && typeof item.id === "string" ? item.id.trim() : "";
      problems.addMessage("duplicate-stage-id", `Duplicate stage id: ${id}`, ["stages", index, "id"]);
      return;
    }
    const stage = collectStage(item, index, version2, version3, version5, declaredStageIds, problems);
    if (stage !== null) stages.push(stage);
  });

  const outputs: CollectedOutputs = version2
    ? collectOutputs(data.outputs, stages, declaredStageIds, problems)
    : { sectionValid: true, complete: true, names: new Set(), values: [], indexes: [] };
  const downstream = schemaVersion >= 4
    ? collectDownstream(data.downstream, outputs, problems)
    : { sectionValid: true, entries: [] };
  const requires: DraftUnit<WorkflowRequires | null> =
    schemaVersion >= 4
      ? Object.hasOwn(data, "requires")
        ? { state: "invalid" }
        : { state: "absent", value: null }
      : draftUnit(() => parseRequires(data.requires, version2), problems, ["requires"]);
  // Top-level fields are leaf units of their own: they are read even when a stage is unreadable.
  if (version2) draftUnit(() => parseConcurrency(data), problems, ["concurrency"]);
  collectStringItems(data.constraints, "constraints", problems);
  const completion =
    !version2 && isRecord(data.completion) && declaredStageIds.size > 0
      ? collectCompletion(data.completion, stages, declaredStageIds, problems)
      : { stage: null };

  const stagesById = new Map(stages.map((stage) => [stage.id, stage]));
  for (const stage of stages) {
    if (stage.dependsOn.state === "invalid") continue;
    for (const dependency of stage.dependsOn.value) {
      if (!declaredStageIds.has(dependency)) {
        const message = `stages.${stage.id}.depends_on is not a declared stage: ${dependency}`;
        problems.addMessage("unknown-stage", message, ["stages", stage.index, "depends_on"]);
      }
    }
    if (stage.resumeFrom.state === "invalid" || stage.resumeFrom.value === null) continue;
    const target = stagesById.get(stage.resumeFrom.value);
    if (target !== undefined && target.kind === "verify") {
      const message = `stages.${stage.id}.session.resume_from must name a role stage: ${stage.resumeFrom.value}.`;
      problems.addMessage("invalid-value", message, ["stages", stage.index, "session", "resume_from"]);
    }
  }

  collectGraphProblems(stages, rawStages.length, declaredStageIds, completion.stage, outputs, version2, problems);

  if (problems.items.length === 0) {
    try {
      return {
        ...emptyResult(schemaVersion),
        document: parseWorkflowMapping(data, source),
        stagesDeclared,
        declaredStageIds,
        stages,
        requires,
        downstream: downstream.entries,
        outputNames: outputs.names,
        outputsComplete: outputs.complete,
        catalogEntry: catalogEntryOfDraft(source, idUnit, stagesDeclared, requires, downstream.entries),
      };
    } catch (error) {
      problems.add(error, draftPathFor(error instanceof Error ? error.message : String(error), data));
    }
  }

  return {
    problems: problems.items,
    document: null,
    id: idUnit,
    schemaVersion,
    stagesDeclared,
    declaredStageIds,
    stages,
    requires,
    downstream: downstream.entries,
    outputNames: outputs.names,
    outputsComplete: outputs.complete,
    unknownKeys,
    catalogEntry: catalogEntryOfDraft(source, idUnit, stagesDeclared, requires, downstream.entries),
  };
}

function catalogEntryOfDraft(
  file: string,
  id: DraftUnit<string>,
  stagesDeclared: boolean,
  requires: DraftUnit<WorkflowRequires | null>,
  downstream: readonly DraftDownstreamEntry[],
): WorkflowCatalogEntry {
  return {
    file,
    document: null,
    id: id.state === "invalid" ? { known: false } : { known: true, value: id.value },
    stagesDeclared,
    requires: requires.state === "invalid" ? { known: false } : { known: true, value: requires.value },
    downstream: downstream.map((entry) => ({
      index: entry.index,
      workflow: entry.workflow.state === "invalid"
        ? { known: false }
        : { known: true, value: entry.workflow.value },
    })),
  };
}
