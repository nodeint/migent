
import type { TSchema } from '@nodeint/migent-contracts';
import { isValid, NonBlankString, schemaIssues,WorkflowArtifact, WorkflowLine, WorkflowRunWhen } from '@nodeint/migent-contracts';

import { compileChangedPathPattern } from './changed-paths.js';
import { DEFAULT_MAX_VERIFY } from './constants.js';
import { ConfigurationError } from './errors.js';
import type { AskTarget } from './model.js';
import type { RunWhen, StageAgent, StageSpec } from './model.js';
import { isRecord, pyRepr } from './record.js';
import type { DecisionBodyProblem } from './structure.js';
import { decisionBodyProblems, decisionEntryProblem, decisionListProblem, requireContainer, requireValid, RUN_WHEN_KEYS, runWhenPathsMissing, STAGE_FIELD_SCHEMAS, stageField } from './structure.js';

export const optionKey = /^[A-Za-z][A-Za-z0-9_.-]*$/;

export interface StageRunWhenContext {
  readonly version2: boolean;
  readonly verify: readonly string[];
}

export function stageRunWhen(
  stage: Record<string, unknown>,
  stageId: string,
  context: StageRunWhenContext,
): RunWhen | null {
  const { version2, verify } = context;
  if (!Object.hasOwn(stage, 'run_when') || (stage.run_when === null || stage.run_when === undefined)) return null;
  const field = `stages.${stageId}.run_when`;
  if (!version2) throw new ConfigurationError(`${field} requires schema_version 2.`);
  const runWhen = stage.run_when;
  requireContainer(STAGE_FIELD_SCHEMAS.run_when, runWhen, field);
  const runWhenMap = runWhen as Record<string, unknown>;
  for (const key of Object.keys(runWhenMap)) {
    if (!RUN_WHEN_KEYS.includes(key)) throw new ConfigurationError(`${field}.${key} is not supported.`);
  }
  // Reading the value only; whether it is required (absent or null) is the contract's verdict.
  const rawPaths = Object.hasOwn(runWhenMap, 'changed_paths') ? runWhenMap.changed_paths : undefined;
  if (runWhenPathsMissing(runWhenMap, 'changed_paths')) {
    throw new ConfigurationError(`${field}.changed_paths is required.`);
  }
  requireContainer(WorkflowRunWhen.properties.changed_paths, rawPaths, `${field}.changed_paths`);
  const raw = rawPaths as unknown[];
  if (schemaIssues(WorkflowRunWhen.properties.changed_paths, raw).some((issue) => issue.path.length === 0 && issue.keyword === 'minItems')) throw new ConfigurationError(`${field}.changed_paths must be a non-empty list.`);
  const changedPaths: string[] = [];
  raw.forEach((entry, index) => {
    const pattern = requiredString(entry, `${field}.changed_paths[${index}]`);
    if (changedPaths.includes(pattern)) {
      throw new ConfigurationError(`Duplicate ${field}.changed_paths item: ${pattern}`);
    }
    const compiled = compileChangedPathPattern(pattern);
    if ('error' in compiled) {
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
  if ((raw === null || raw === undefined)) return [];
  requireContainer(STAGE_FIELD_SCHEMAS.instructions, raw, field);
  return (raw as unknown[]).map((item, index) => requiredString(item, `${field}[${index}]`));
}

export function stageDependsOn(stage: Record<string, unknown>, stageId: string): string[] {
  if (!Object.hasOwn(stage, 'depends_on') || (stage.depends_on === null || stage.depends_on === undefined)) return [];
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
  if ((stage.decision === null || stage.decision === undefined)) return stage;
  const field = `stages.${String(stage.id)}.decision`;
  if (decisionListProblem(stage.decision)) {
    throw new ConfigurationError(`${field} must be a non-empty list in schema_version 3. Run \`migent migrate\` for older workflows.`);
  }
  const values: string[] = [];
  const routes: Record<string, unknown> = Object.create(null);
  const instructions: Record<string, string> = Object.create(null);
  for (const entry of stage.decision as Record<string, unknown>[]) {
    const { name, body } = normalizeDecisionEntry(entry, { field, version7 });
    if (Object.hasOwn(routes, name)) throw new ConfigurationError(`Duplicate decision value on ${field}: ${name}`);
    if (body.when !== undefined) instructions[name] = requiredString(body.when, `${field}.${name}.when`);
    values.push(name);
    routes[name] = body.navigate;
  }
  return { ...stage, decision: { values, routes, instructions } };
}

/** Error message for one decision body problem at `path`. */
function decisionBodyMessage(found: DecisionBodyProblem, path: string): string {
  if (found.kind === 'body') return `${path} must be a mapping.`;
  if (found.kind === 'key') return `${path}.${found.key} is not allowed.`;
  if (found.kind === 'when') return `Missing or invalid ${path}.when.`;
  return `${path}.navigate is required.`;
}

/** Validates one single-key decision entry and returns its lowercased name and accepted body. */
function normalizeDecisionEntry(
  entry: Record<string, unknown>,
  { field, version7 }: { field: string; version7: boolean },
): { name: string; body: Record<string, unknown> } {
  if (decisionEntryProblem(entry)) {
    throw new ConfigurationError(`${field} entries must each declare exactly one decision.`);
  }
  const [rawName] = Object.keys(entry);
  const name = requiredString(rawName, field).toLowerCase();
  const body = entry[rawName];
  const [found] = decisionBodyProblems(body, version7);
  if (found !== undefined) throw new ConfigurationError(decisionBodyMessage(found, `${field}.${name}`));
  return { name, body: body as Record<string, unknown> };
}

export interface StageRoutesContext {
  readonly values: readonly string[];
  readonly stages: Record<string, StageSpec>;
  readonly version2?: boolean;
}

export function stageRoutes(
  stage: Record<string, unknown>,
  stageId: string,
  context: StageRoutesContext,
): Record<string, string | string[]> {
  const { values, stages, version2 = false } = context;
  if (values.length === 0) return {};
  const {decision} = stage;
  if (!isRecord(decision)) return {};
  const {routes} = decision;
  if (!isRecord(routes) || Object.keys(routes).length === 0) {
    throw new ConfigurationError(`stages.${stageId}.decision.routes must be a mapping.`);
  }
  const parsed: Record<string, string | string[]> = {};
  for (const [rawKey, rawTarget] of Object.entries(routes)) {
    const key = requiredString(rawKey, `stages.${stageId}.decision.routes`).toLowerCase();
    const field = `stages.${stageId}.decision.routes.${key}`;
    const target = routeTarget(rawTarget, field, { stages, version2 });
    if (typeof target === 'string' && target !== 'complete' && !Object.hasOwn(stages, target)) {
      throw new ConfigurationError(`${field} is not a declared stage: ${target}`);
    }
    if (Object.hasOwn(parsed, key)) {
      throw new ConfigurationError(`Duplicate route on stages.${stageId}: ${key}`);
    }
    parsed[key] = target;
  }
  if (!sameKeys(Object.keys(parsed), values)) {
    throw new ConfigurationError(
      `stages.${stageId}.decision.routes keys must match decision.values.`,
    );
  }
  return parsed;
}

/** True when both lists hold the same names, ignoring order. */
function sameKeys(keys: readonly string[], values: readonly string[]): boolean {
  const left = [...keys].sort();
  const right = [...values].sort();
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

export function routeTarget(
  raw: unknown,
  field: string,
  scope: { readonly stages: Record<string, StageSpec>; readonly version2: boolean },
): string | string[] {
  const { stages, version2 } = scope;
  if (!Array.isArray(raw)) return requiredString(raw, field);
  // A list is a fan-out route. Reporting it as a bad string would hide that.
  if (!version2) return requiredString(raw, field);
  if (raw.length === 0) throw new ConfigurationError(`${field} must be a non-empty list.`);
  const targets = raw.map((item, index) => requiredString(item, `${field}[${index}]`));
  if (targets.includes('complete')) throw new ConfigurationError(`${field} cannot list complete.`);
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
  'ask',
  'instructions',
  'model',
  'options',
  'agent',
  'session',
  'produces',
  'decision',
  'max_revisions',
  'max_verify',
] as const;

export function stageHasRole(stage: Record<string, unknown>): boolean {
  return Object.hasOwn(stage, 'role') && (stage.role !== null && stage.role !== undefined);
}

export function rejectRoleOnlyKeys(stage: Record<string, unknown>, stageId: string): void {
  if (Object.hasOwn(stage, 'ask')) throw new ConfigurationError(`stages.${stageId}.ask requires a role.`);
  for (const key of ROLE_ONLY_KEYS) {
    if (Object.hasOwn(stage, key) && (stage[key] !== null && stage[key] !== undefined)) {
      throw new ConfigurationError(`stages.${stageId}.${key} requires a role.`);
    }
  }
}

export function stageDescription(stage: Record<string, unknown>, stageId: string): string | null {
  const description = optionalStageString(stage, 'description', stageId);
  if (description !== null) requireValid(stageField('description'), description, `stages.${stageId}.description must be one line.`);
  return description;
}

export function stageDecisionValues(stage: Record<string, unknown>, stageId: string): string[] {
  if (!Object.hasOwn(stage, 'decision') || (stage.decision === null || stage.decision === undefined)) return [];
  const {decision} = stage;
  if (isRecord(decision) && Object.keys(decision).length === 0) return [];
  if (!isRecord(decision)) {
    throw new ConfigurationError(`stages.${stageId}.decision must be a mapping.`);
  }
  const {values} = decision;
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
  if (!Object.hasOwn(stage, 'produces') || (stage.produces === null || stage.produces === undefined)) return null;
  const {produces} = stage;
  if (isRecord(produces) && Object.keys(produces).length === 0) return null;
  if (!isRecord(produces)) {
    throw new ConfigurationError(`stages.${stageId}.produces must be a mapping.`);
  }
  if (!Object.hasOwn(produces, 'artifact') || (produces.artifact === null || produces.artifact === undefined)) return null;
  return filename(produces.artifact, `stages.${stageId}.produces.artifact`);
}

export function stageMaxRevisions(stage: Record<string, unknown>, stageId: string): number | null {
  if (!Object.hasOwn(stage, 'max_revisions')) return null;
  const raw = stage.max_revisions;
  const field = `stages.${stageId}.max_revisions`;
  // yaml@2 yields numbers. Digit strings match the subset parser.
  requireValid(stageField('max_revisions'), raw, `${field} must be a non-negative integer.`);
  return Number(typeof raw === 'string' ? raw.trim() : raw);
}

export function stageVerify(stage: Record<string, unknown>, stageId: string): string[] {
  if (!Object.hasOwn(stage, 'verify') || (stage.verify === null || stage.verify === undefined)) return [];
  const field = `stages.${stageId}.verify`;
  const raw = Array.isArray(stage.verify) ? stage.verify : [stage.verify];
  if (!isValid(stageField('verify'), stage.verify)) {
    if (raw.length === 0) throw new ConfigurationError(`${field} must not be empty.`);
    const bad = raw.find((entry) => !isValid(VERIFY_LINE, entry));
    if (typeof bad !== 'string' || bad.trim() === '') throw new ConfigurationError(`Missing or invalid ${field} item.`);
    throw new ConfigurationError(`${field} items must be one shell line.`);
  }
  return raw.map((entry) => (entry as string).trim());
}

export function stageMaxVerify(stage: Record<string, unknown>, stageId: string, verify: string[]): number {
  if (!Object.hasOwn(stage, 'max_verify') || (stage.max_verify === null || stage.max_verify === undefined)) return DEFAULT_MAX_VERIFY;
  const field = `stages.${stageId}.max_verify`;
  if (verify.length === 0) throw new ConfigurationError(`${field} requires verify.`);
  return positiveInteger(stage.max_verify, field);
}

export function stageVerifyTimeout(
  stage: Record<string, unknown>,
  stageId: string,
  verify: string[],
): number | null {
  if (!Object.hasOwn(stage, 'verify_timeout') || (stage.verify_timeout === null || stage.verify_timeout === undefined)) return null;
  const field = `stages.${stageId}.verify_timeout`;
  if (verify.length === 0) throw new ConfigurationError(`${field} requires verify.`);
  return positiveInteger(stage.verify_timeout, field, stageField('verify_timeout'));
}

export function positiveInteger(raw: unknown, field: string, schema: TSchema = stageField('max_verify')): number {
  requireValid(schema, raw, `${field} must be an integer of at least 1.`);
  return Number(typeof raw === 'string' ? raw.trim() : raw);
}

/** Schema_version 5: `agent` is a name in `agents` or a complete inline definition. */
export function stageAgent(stage: Record<string, unknown>, stageId: string): StageAgent | null {
  if (!Object.hasOwn(stage, 'agent') || (stage.agent === null || stage.agent === undefined)) return null;
  const raw = stage.agent;
  if (isRecord(raw)) return { kind: 'inline', value: structuredClone(raw) };
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ConfigurationError(`Missing or invalid stages.${stageId}.agent.`);
  }
  return { kind: 'named', name: raw.trim() };
}

/** Schema_version 4 and earlier: `model` names an entry of the config's model aliases. */
export function legacyStageModel(stage: Record<string, unknown>, stageId: string): StageAgent | null {
  const name = optionalStageString(stage, 'model', stageId);
  return name === null ? null : { kind: 'named', name };
}

export function stageOptions(stage: Record<string, unknown>, stageId: string): Record<string, string> {
  if (!Object.hasOwn(stage, 'options') || (stage.options === null || stage.options === undefined)) return {};
  const raw = stage.options;
  if (!isRecord(raw)) throw new ConfigurationError(`Missing or invalid stages.${stageId}.options.`);
  return readOptionMap(raw, `stages.${stageId}.options`);
}

/** An option value as Migent keeps it: a trimmed non-blank string, finite number or boolean; else null. */
export function optionValueText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return String(value);
  return null;
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
        code: 'option-key-invalid',
        ...(path === undefined ? {} : { path: [...path, key] }),
      });
    }
    const text = optionValueText(item);
    if (text === null) {
      throw new ConfigurationError(`Missing or invalid ${field}.${key}: expected a non-blank string, a number or a boolean.`, {
        code: 'option-invalid',
        ...(path === undefined ? {} : { path: [...path, key] }),
      });
    }
    parsed[key] = text;
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
  if (!Object.hasOwn(stage, 'session') || (stage.session === null || stage.session === undefined)) return null;
  const {session} = stage;
  if (isRecord(session) && Object.keys(session).length === 0) return null;
  requireContainer(STAGE_FIELD_SCHEMAS.session, session, `stages.${stageId}.session`);
  const sessionMap = session as Record<string, unknown>;
  if (!Object.hasOwn(sessionMap, 'resume_from') || (sessionMap.resume_from === null || sessionMap.resume_from === undefined)) return null;
  return requiredString(sessionMap.resume_from, `stages.${stageId}.session.resume_from`);
}
