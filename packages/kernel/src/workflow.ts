import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ConfigurationError } from "./errors.js";
import { isRecord, pyRepr } from "./record.js";
import { parseYamlDocument } from "./yaml.js";

export const VERIFY_ARTIFACT = "verify.md";

const optionKey = /^[A-Za-z][A-Za-z0-9_.-]*$/;

export interface StageSpec {
  id: string;
  role: string;
  artifact: string | null;
  decisionValues: string[];
  dependsOn: string[];
  resumeFrom: string | null;
  instructions: string[];
  modelName: string | null;
  options: Record<string, string>;
  maxRevisions: number | null;
  routes: Record<string, string>;
  verify: string[];
  maxVerify: number;
  verifyTimeoutSec: number | null;
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

export interface WorkflowRequires {
  workflow: string;
  decision: string | null;
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
}

/** config.ts imports this module, so the parser cannot import SCHEMA_VERSION. */
const WORKFLOW_SCHEMA_VERSION = 2;

export function isWorkflowV2(workflow: WorkflowDocument | null | undefined): boolean {
  return (workflow?.schemaVersion ?? 1) >= 2;
}

export interface WorkflowCatalog {
  documents: Record<string, WorkflowDocument>;
  problems: string[];
}

const stageSpecSchema = z.object({
  id: z.string(),
  role: z.string(),
  artifact: z.string().nullable(),
  decisionValues: z.array(z.string()),
  dependsOn: z.array(z.string()),
  resumeFrom: z.string().nullable(),
  instructions: z.array(z.string()),
  modelName: z.string().nullable(),
  options: z.record(z.string(), z.string()),
  maxRevisions: z.number().int().nonnegative().nullable(),
  routes: z.record(z.string(), z.string()),
  verify: z.array(z.string()),
  maxVerify: z.number().int().min(1),
  verifyTimeoutSec: z.number().int().min(1).nullable(),
});

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
  const schemaVersion = mappingSchemaVersion(data);
  if (schemaVersion > WORKFLOW_SCHEMA_VERSION) {
    throw new ConfigurationError(
      `workflow schema_version ${schemaVersion} is newer than this Migent (${WORKFLOW_SCHEMA_VERSION}).`,
    );
  }
  const version2 = schemaVersion >= 2;
  if (version2 && Object.hasOwn(data, "completion") && data.completion != null) {
    throw new ConfigurationError("schema_version 2 does not allow completion. Run `migent migrate`.");
  }
  const stages = parseStages(data.stages, version2);
  const completion =
    !version2 && isRecord(data.completion) && Object.keys(stages).length > 0
      ? parseCompletion(data.completion, stages)
      : null;
  const outputs = version2 ? parseTopLevelOutputs(data.outputs, stages) : undefined;
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

function mappingSchemaVersion(data: Record<string, unknown>): number {
  if (!Object.hasOwn(data, "schema_version") || data.schema_version == null) return 0;
  const raw = data.schema_version;
  if (typeof raw === "boolean" || (typeof raw !== "number" && typeof raw !== "string")) {
    throw new ConfigurationError("schema_version must be a non-negative integer.");
  }
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!/^\d+$/.test(text)) throw new ConfigurationError("schema_version must be a non-negative integer.");
    return Number(text);
  }
  if (!Number.isInteger(raw) || raw < 0) {
    throw new ConfigurationError("schema_version must be a non-negative integer.");
  }
  return raw;
}

function parseConcurrency(data: Record<string, unknown>): number {
  if (!Object.hasOwn(data, "concurrency") || data.concurrency == null) return 1;
  const raw = data.concurrency;
  let value = raw;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) value = Number(value.trim());
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ConfigurationError("concurrency must be a positive integer.");
  }
  if (value > 1) throw new ConfigurationError("concurrency greater than 1 is not supported yet.");
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

function parseStages(raw: unknown, version2 = false): Record<string, StageSpec> {
  if (!Array.isArray(raw) || raw.length === 0) return {};
  const stages: Record<string, StageSpec> = {};
  const items: Record<string, unknown>[] = [];
  for (const item of raw) {
    if (!isRecord(item)) throw new ConfigurationError("Workflow stage must be a mapping.");
    const stageId = requiredString(item.id, "stages.id");
    if (Object.hasOwn(stages, stageId)) throw new ConfigurationError(`Duplicate stage id: ${stageId}`);
    const role = requiredString(item.role, `stages.${stageId}.role`);
    const dependsOn = stageDependsOn(item, stageId);
    const verify = stageVerify(item, stageId);
    const artifact = stageArtifact(item, stageId);
    if (verify.length > 0 && artifact === VERIFY_ARTIFACT) {
      throw new ConfigurationError(
        `stages.${stageId}.produces.artifact cannot be ${VERIFY_ARTIFACT} on a stage with verify.`,
      );
    }
    stages[stageId] = stageSpecSchema.parse({
      id: stageId,
      role,
      artifact,
      decisionValues: stageDecisionValues(item, stageId),
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

function stageRoutes(
  stage: Record<string, unknown>,
  stageId: string,
  values: readonly string[],
  stages: Record<string, StageSpec>,
  version2 = false,
): Record<string, string> {
  if (values.length === 0) return {};
  const decision = stage.decision;
  if (!isRecord(decision)) return {};
  const routes = decision.routes;
  if (!isRecord(routes) || Object.keys(routes).length === 0) {
    throw new ConfigurationError(`stages.${stageId}.decision.routes must be a mapping.`);
  }
  const parsed: Record<string, string> = {};
  for (const [rawKey, rawTarget] of Object.entries(routes)) {
    const key = requiredString(rawKey, `stages.${stageId}.decision.routes`).toLowerCase();
    const field = `stages.${stageId}.decision.routes.${key}`;
    const target = routeTarget(rawTarget, field, stages, version2);
    if (target !== "complete" && !Object.hasOwn(stages, target)) {
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
): string {
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
  throw new ConfigurationError(`${field} is a list, which is not supported yet.`);
}

function validateStageGraph(stages: Record<string, StageSpec>): void {
  const targets = new Set<string>();
  for (const stage of Object.values(stages)) {
    for (const target of Object.values(stage.routes)) {
      if (target !== "complete") targets.add(target);
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
  }
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
  let outputsRaw: unknown = raw.outputs == null || raw.outputs === false ? [] : raw.outputs;
  if (isRecord(outputsRaw) && Object.keys(outputsRaw).length === 0) outputsRaw = [];
  if (!Array.isArray(outputsRaw)) {
    throw new ConfigurationError("completion.outputs must be a list.");
  }
  const outputs: WorkflowOutput[] = [];
  const seen = new Set<string>();
  for (const item of outputsRaw) {
    if (!isRecord(item)) {
      throw new ConfigurationError("completion.outputs item must be a mapping.");
    }
    const name = filename(item.name, "completion.outputs.name");
    const fromStage = requiredString(item.from_stage, "completion.outputs.from_stage");
    const artifact = filename(item.artifact, "completion.outputs.artifact");
    if (seen.has(name)) throw new ConfigurationError(`Duplicate completion output name: ${name}`);
    if (!Object.hasOwn(stages, fromStage)) {
      throw new ConfigurationError(
        `completion.outputs.from_stage is not a declared stage: ${fromStage}`,
      );
    }
    const source = stages[fromStage]!;
    if (source.artifact === null) {
      throw new ConfigurationError(
        `completion output ${pyRepr(name)} references stage ${fromStage} which does not produce an artifact.`,
      );
    }
    if (source.artifact !== artifact) {
      throw new ConfigurationError(
        `completion output ${pyRepr(name)} artifact ${pyRepr(artifact)} does not match stages.${fromStage}.produces.artifact ${pyRepr(source.artifact)}.`,
      );
    }
    seen.add(name);
    outputs.push(workflowOutputSchema.parse({ name, fromStage, artifact }));
  }
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
    if (Object.values(stage.routes).includes("complete")) points.add(stage.id);
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

function dependencyClosure(stages: Record<string, StageSpec>, stageId: string): Set<string> {
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
