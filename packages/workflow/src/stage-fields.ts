import path from "node:path";
import { z } from "zod";
import { NonBlankString, WorkflowArtifact, WorkflowLine, WorkflowRunWhen, isValid, schemaIssues } from "@nodeint/migent-contracts";
import type { TSchema } from "@nodeint/migent-contracts";
import { ConfigurationError } from "./errors.js";
import { isRecord, pyRepr } from "./record.js";
import { RUN_WHEN_KEYS, runWhenPathsMissing, STAGE_FIELD_SCHEMAS, decisionBodyProblems, decisionEntryProblem, decisionListProblem, requireContainer, requireValid, stageField } from "./structure.js";
import { compileChangedPathPattern } from "./changed-paths.js";
import type { AskTarget } from "./model.js";
import type { RunWhen, StageAgent, StageSpec } from "./model.js";

export const optionKey = /^[A-Za-z][A-Za-z0-9_.-]*$/;

export function stageRunWhen(
  stage: Record<string, unknown>,
  stageId: string,
  version2: boolean,
  verify: readonly string[],
): RunWhen | null {
  if (!Object.hasOwn(stage, "run_when") || stage.run_when == null) return null;
  const field = `stages.${stageId}.run_when`;
  if (!version2) throw new ConfigurationError(`${field} requires schema_version 2.`);
  const runWhen = stage.run_when;
  requireContainer(STAGE_FIELD_SCHEMAS.run_when, runWhen, field);
  const runWhenMap = runWhen as Record<string, unknown>;
  for (const key of Object.keys(runWhenMap)) {
    if (!RUN_WHEN_KEYS.includes(key)) throw new ConfigurationError(`${field}.${key} is not supported.`);
  }
  // Reading the value only; whether it is required (absent or null) is the contract's verdict.
  const rawPaths = Object.hasOwn(runWhenMap, "changed_paths") ? runWhenMap.changed_paths : undefined;
  if (runWhenPathsMissing(runWhenMap, "changed_paths")) {
    throw new ConfigurationError(`${field}.changed_paths is required.`);
  }
  requireContainer(WorkflowRunWhen.properties.changed_paths, rawPaths, `${field}.changed_paths`);
  const raw = rawPaths as unknown[];
  if (schemaIssues(WorkflowRunWhen.properties.changed_paths, raw).some((issue) => issue.path.length === 0 && issue.keyword === "minItems")) throw new ConfigurationError(`${field}.changed_paths must be a non-empty list.`);
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

export function stringItems(raw: unknown, field: string): string[] {
  if (raw == null) return [];
  requireContainer(STAGE_FIELD_SCHEMAS.instructions, raw, field);
  return (raw as unknown[]).map((item, index) => requiredString(item, `${field}[${index}]`));
}

export function stageDependsOn(stage: Record<string, unknown>, stageId: string): string[] {
  if (!Object.hasOwn(stage, "depends_on") || stage.depends_on == null) return [];
  requireContainer(STAGE_FIELD_SCHEMAS.depends_on, stage.depends_on, `stages.${stageId}.depends_on`);
  const raw = stage.depends_on as unknown[];
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

export function stageResumeFrom(
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
export function normalizeStageDecision(stage: Record<string, unknown>, version7 = false): Record<string, unknown> {
  if (stage.decision == null) return stage;
  const field = `stages.${String(stage.id)}.decision`;
  if (decisionListProblem(stage.decision)) {
    throw new ConfigurationError(`${field} must be a non-empty list in schema_version 3. Run \`migent migrate\` for older workflows.`);
  }
  const values: string[] = [];
  const routes: Record<string, unknown> = Object.create(null);
  const instructions: Record<string, string> = Object.create(null);
  for (const entry of stage.decision as Record<string, unknown>[]) {
    if (decisionEntryProblem(entry)) {
      throw new ConfigurationError(`${field} entries must each declare exactly one decision.`);
    }
    const rawName = Object.keys(entry)[0]!;
    const name = requiredString(rawName, field).toLowerCase();
    if (Object.hasOwn(routes, name)) throw new ConfigurationError(`Duplicate decision value on ${field}: ${name}`);
    const body = entry[rawName];
    const found = decisionBodyProblems(body, version7)[0];
    if (found !== undefined) {
      if (found.kind === "body") throw new ConfigurationError(`${field}.${name} must be a mapping.`);
      if (found.kind === "key") throw new ConfigurationError(`${field}.${name}.${found.key} is not allowed.`);
      if (found.kind === "when") throw new ConfigurationError(`Missing or invalid ${field}.${name}.when.`);
      throw new ConfigurationError(`${field}.${name}.navigate is required.`);
    }
    const accepted = body as Record<string, unknown>;
    if (accepted.when !== undefined) instructions[name] = requiredString(accepted.when, `${field}.${name}.when`);
    values.push(name);
    routes[name] = accepted.navigate;
  }
  return { ...stage, decision: { values, routes, instructions } };
}

export function stageRoutes(
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

export function routeTarget(
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

export function stageAsk(stage: Record<string, unknown>, stageId: string): AskTarget {
  if (!isValid(STAGE_FIELD_SCHEMAS.ask, stage.ask)) throw new ConfigurationError(`stages.${stageId}.ask must be human.`);
  return stage.ask;
}

export const ROLE_ONLY_KEYS = [
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

export function stageHasRole(stage: Record<string, unknown>): boolean {
  return Object.hasOwn(stage, "role") && stage.role != null;
}

export function rejectRoleOnlyKeys(stage: Record<string, unknown>, stageId: string): void {
  if (Object.hasOwn(stage, "ask")) throw new ConfigurationError(`stages.${stageId}.ask requires a role.`);
  for (const key of ROLE_ONLY_KEYS) {
    if (Object.hasOwn(stage, key) && stage[key] != null) {
      throw new ConfigurationError(`stages.${stageId}.${key} requires a role.`);
    }
  }
}

export function stageDescription(stage: Record<string, unknown>, stageId: string): string | null {
  const description = optionalStageString(stage, "description", stageId);
  if (description !== null) requireValid(stageField("description"), description, `stages.${stageId}.description must be one line.`);
  return description;
}

export function stageDecisionValues(stage: Record<string, unknown>, stageId: string): string[] {
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

export function stageArtifact(stage: Record<string, unknown>, stageId: string): string | null {
  if (!Object.hasOwn(stage, "produces") || stage.produces == null) return null;
  const produces = stage.produces;
  if (isRecord(produces) && Object.keys(produces).length === 0) return null;
  if (!isRecord(produces)) {
    throw new ConfigurationError(`stages.${stageId}.produces must be a mapping.`);
  }
  if (!Object.hasOwn(produces, "artifact") || produces.artifact == null) return null;
  return filename(produces.artifact, `stages.${stageId}.produces.artifact`);
}

export function stageMaxRevisions(stage: Record<string, unknown>, stageId: string): number | null {
  if (!Object.hasOwn(stage, "max_revisions")) return null;
  const raw = stage.max_revisions;
  const field = `stages.${stageId}.max_revisions`;
  // yaml@2 yields numbers. Digit strings match the subset parser.
  requireValid(stageField("max_revisions"), raw, `${field} must be a non-negative integer.`);
  return Number(typeof raw === "string" ? raw.trim() : raw);
}

export function stageVerify(stage: Record<string, unknown>, stageId: string): string[] {
  if (!Object.hasOwn(stage, "verify") || stage.verify == null) return [];
  const field = `stages.${stageId}.verify`;
  const raw = Array.isArray(stage.verify) ? stage.verify : [stage.verify];
  if (!isValid(stageField("verify"), stage.verify)) {
    if (raw.length === 0) throw new ConfigurationError(`${field} must not be empty.`);
    const bad = raw.find((entry) => !isValid(VERIFY_LINE, entry));
    if (typeof bad !== "string" || bad.trim() === "") throw new ConfigurationError(`Missing or invalid ${field} item.`);
    throw new ConfigurationError(`${field} items must be one shell line.`);
  }
  return raw.map((entry) => (entry as string).trim());
}

export function stageMaxVerify(stage: Record<string, unknown>, stageId: string, verify: string[]): number {
  if (!Object.hasOwn(stage, "max_verify") || stage.max_verify == null) return 3;
  const field = `stages.${stageId}.max_verify`;
  if (verify.length === 0) throw new ConfigurationError(`${field} requires verify.`);
  return positiveInteger(stage.max_verify, field);
}

export function stageVerifyTimeout(
  stage: Record<string, unknown>,
  stageId: string,
  verify: string[],
): number | null {
  if (!Object.hasOwn(stage, "verify_timeout") || stage.verify_timeout == null) return null;
  const field = `stages.${stageId}.verify_timeout`;
  if (verify.length === 0) throw new ConfigurationError(`${field} requires verify.`);
  return positiveInteger(stage.verify_timeout, field, stageField("verify_timeout"));
}

export function positiveInteger(raw: unknown, field: string, schema: TSchema = stageField("max_verify")): number {
  requireValid(schema, raw, `${field} must be an integer of at least 1.`);
  return Number(typeof raw === "string" ? raw.trim() : raw);
}

/** Schema_version 5: `agent` is a name in `agents` or a complete inline definition. */
export function stageAgent(stage: Record<string, unknown>, stageId: string): StageAgent | null {
  if (!Object.hasOwn(stage, "agent") || stage.agent == null) return null;
  const raw = stage.agent;
  if (isRecord(raw)) return { kind: "inline", value: structuredClone(raw) };
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ConfigurationError(`Missing or invalid stages.${stageId}.agent.`);
  }
  return { kind: "named", name: raw.trim() };
}

/** Schema_version 4 and earlier: `model` names an entry of the config's model aliases. */
export function legacyStageModel(stage: Record<string, unknown>, stageId: string): StageAgent | null {
  const name = optionalStageString(stage, "model", stageId);
  return name === null ? null : { kind: "named", name };
}

export function stageOptions(stage: Record<string, unknown>, stageId: string): Record<string, string> {
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

export function optionalStageString(
  stage: Record<string, unknown>,
  key: string,
  stageId: string,
): string | null {
  if (!Object.hasOwn(stage, key)) return null;
  return requiredString(stage[key], `stages.${stageId}.${key}`);
}

export function requiredString(value: unknown, field: string): string {
  requireValid(NonBlankString, value, `Missing or invalid ${field}.`);
  return (value as string).trim();
}

export function filename(value: unknown, field: string): string {
  const text = requiredString(value, field);
  requireValid(WorkflowArtifact.properties.file, text, `Invalid ${field}: ${pyRepr(text)}`);
  return text;
}

export function fail(message: string): never {
  throw new ConfigurationError(message);
}

export const VERIFY_LINE: TSchema = WorkflowLine;

/** Reads `session.resume_from` without the dependency rule, for stages whose depends_on is unreadable. */
export function stageResumeFromUnchecked(stage: Record<string, unknown>, stageId: string): string | null {
  if (!Object.hasOwn(stage, "session") || stage.session == null) return null;
  const session = stage.session;
  if (isRecord(session) && Object.keys(session).length === 0) return null;
  requireContainer(STAGE_FIELD_SCHEMAS.session, session, `stages.${stageId}.session`);
  const sessionMap = session as Record<string, unknown>;
  if (!Object.hasOwn(sessionMap, "resume_from") || sessionMap.resume_from == null) return null;
  return requiredString(sessionMap.resume_from, `stages.${stageId}.session.resume_from`);
}
