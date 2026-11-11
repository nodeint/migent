
import { legacyArtifacts } from '../artifacts.js';
import { DEFAULT_MAX_VERIFY } from '../constants.js';
import { stageErrorPath, workflowRuleCode } from '../diagnostics.js';
import type { DraftStage, DraftUnit } from '../draft/problems.js';
import { declaredStagePlaceholders, DraftProblems, draftUnit } from '../draft/problems.js';
import { ConfigurationError } from '../errors.js';
import type { AskTarget } from '../model.js';
import type { RoleStageSpec, StageAgent, StageSpec } from '../model.js';
import { VERIFY_ARTIFACT } from '../model.js';
import { isRecord } from '../record.js';
import { stageSpecSchema } from '../schema.js';
import { legacyStageModel, positiveInteger, requiredString, ROLE_ONLY_KEYS, routeTarget, stageAgent, stageArtifact, stageAsk, stageDecisionValues, stageDependsOn, stageDescription, stageHasRole, stageMaxRevisions, stageMaxVerify, stageOptions, stageResumeFrom, stageResumeFromUnchecked, stageRoutes, stageRunWhen, stageVerify, stageVerifyTimeout, stringItems } from '../stage-fields.js';
import { decisionBodyProblems, decisionEntryProblem, decisionListProblem, stageMappingProblem } from '../structure.js';

export interface CollectedDecision {
  values: DraftUnit<string[]>;
  instructions: Record<string, string>;
  routes: DraftUnit<Record<string, string | string[]>>;
}

/** What every stage read shares: the schema version flags, the declared stage ids, and the problem sink. */
export interface DraftStageContext {
  readonly version2: boolean;
  readonly version3: boolean;
  readonly version5: boolean;
  readonly version7: boolean;
  readonly declaredIds: ReadonlySet<string>;
  readonly problems: DraftProblems;
}

/** Reads the schema >= 3 decision list entry by entry, then resolves its routes one by one. */
export function collectDecisionV3(
  item: Record<string, unknown>,
  at: { readonly stageId: string; readonly index: number },
  context: Pick<DraftStageContext, 'declaredIds' | 'problems' | 'version7'>,
): CollectedDecision {
  const { stageId, index } = at;
  const { problems, version7 } = context;
  const field = `stages.${stageId}.decision`;
  const raw = item.decision;
  if ((raw === null || raw === undefined)) {
    return { values: { state: 'absent', value: [] }, instructions: {}, routes: { state: 'absent', value: {} } };
  }
  const invalid: CollectedDecision = {
    values: { state: 'invalid' },
    instructions: {},
    routes: { state: 'invalid' },
  };
  if (decisionListProblem(raw)) {
    problems.addMessage(
      'invalid-decision',
      `${field} must be a non-empty list in schema_version 3. Run \`migent migrate\` for older workflows.`,
      ['stages', index, 'decision'],
    );
    return invalid;
  }
  let valid = true;
  const values: string[] = [];
  const instructions: Record<string, string> = {};
  const routesRaw: Record<string, unknown> = Object.create(null);
  const entryIndexByName = new Map<string, number>();
  const rawNameByName = new Map<string, string>();
  (raw as unknown[]).forEach((entry, entryIndex) => {
    const entryPath: (string | number)[] = ['stages', index, 'decision', entryIndex];
    if (decisionEntryProblem(entry) || !isRecord(entry)) {
      problems.addMessage('invalid-decision', `${field} entries must each declare exactly one decision.`, entryPath);
      valid = false;
      return;
    }
    const [rawName] = Object.keys(entry);
    const name = rawName.trim().toLowerCase();
    if (name === '') {
      problems.addMessage('invalid-value', `Missing or invalid ${field}.`, entryPath);
      valid = false;
      return;
    }
    if (Object.hasOwn(routesRaw, name)) {
      problems.addMessage('invalid-decision', `Duplicate decision value on ${field}: ${name}`, entryPath);
      valid = false;
      return;
    }
    const body = entry[rawName];
    const found = decisionBodyProblems(body, version7);
    if (found[0]?.kind === 'body' || !isRecord(body)) {
      problems.addMessage('invalid-decision', `${field}.${name} must be a mapping.`, [...entryPath, rawName]);
      valid = false;
      return;
    }
    const at = [...entryPath, rawName];
    for (const problem of found) {
      if (problem.kind === 'key') problems.addMessage('invalid-decision', `${field}.${name}.${problem.key} is not allowed.`, [...at, problem.key]);
      else if (problem.kind === 'when') problems.addMessage('invalid-value', `Missing or invalid ${field}.${name}.when.`, [...at, 'when']);
      else if (problem.kind === 'navigate') problems.addMessage('missing-required', `${field}.${name}.navigate is required.`, [...at, 'navigate']);
    }
    if (found.length === 0 && body.when !== undefined) instructions[name] = (body.when as string).trim();
    if (found.length > 0) {
      valid = false;
      return;
    }
    values.push(name);
    entryIndexByName.set(name, entryIndex);
    rawNameByName.set(name, rawName);
    routesRaw[name] = body.navigate;
  });
  // Readable entries keep their route checks even when another entry is malformed.
  const routes = collectRouteTargets({ field, routes: routesRaw, entryIndexByName, rawNameByName, index }, context);
  return {
    values: valid ? { state: 'valid', value: values } : { state: 'invalid' },
    instructions,
    routes: valid ? routes : { state: 'invalid' },
  };
}

/** Resolves each route on its own, so one bad target does not hide the others. */
export interface RouteTargetsInput {
  readonly field: string;
  readonly routes: Record<string, unknown>;
  readonly entryIndexByName: ReadonlyMap<string, number>;
  readonly rawNameByName: ReadonlyMap<string, string>;
  readonly index: number;
}

export function collectRouteTargets(
  { field, routes, entryIndexByName, rawNameByName, index }: RouteTargetsInput,
  { declaredIds, problems }: Pick<DraftStageContext, 'declaredIds' | 'problems'>,
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
        ? ['stages', index, 'decision']
        : ['stages', index, 'decision', entryIndex, written, 'navigate'];
    if (key === '') {
      problems.addMessage('invalid-value', `Missing or invalid ${field}.routes.`, routePath);
      valid = false;
      continue;
    }
    try {
      // Schema >= 3 routes follow the runtime: a list is a fan-out, a scalar must be a stage.
      const target = routeTarget(rawTarget, `${field}.routes.${key}`, { stages: placeholders, version2: true });
      if (typeof target === 'string' && target !== 'complete' && !declaredIds.has(target)) {
        throw new ConfigurationError(`${field}.routes.${key} is not a declared stage: ${target}`);
      }
      parsed[key] = target;
    } catch (error) {
      problems.add(error, routePath);
      valid = false;
    }
  }
  return valid ? { state: 'valid', value: parsed } : { state: 'invalid' };
}

/** Reads one stage field at a time, reporting a failure at the stage's author coordinates. */
interface StageReader {
  readonly rawItem: Record<string, unknown>;
  readonly index: number;
  readonly stageId: string;
  readonly context: DraftStageContext;
  readonly report: (message: string) => void;
  readonly read: <T>(fn: () => T) => DraftUnit<T>;
}

/** Every unit a stage read collects, before it is assembled into specs. */
interface CollectedStageFields {
  readonly kind: DraftStage['kind'];
  readonly role: DraftUnit<string>;
  readonly description: DraftUnit<string | null>;
  readonly dependsOn: DraftUnit<string[]>;
  readonly verify: DraftUnit<string[]>;
  readonly runWhen: DraftUnit<StageSpec['runWhen']>;
  readonly artifact: DraftUnit<string | null>;
  readonly ask: DraftUnit<AskTarget>;
  readonly decision: CollectedDecision;
  readonly instructions: DraftUnit<string[]>;
  readonly agent: DraftUnit<StageAgent | null>;
  readonly options: DraftUnit<Record<string, string>>;
  readonly maxRevisions: DraftUnit<number | null>;
  readonly maxVerify: DraftUnit<number>;
  readonly verifyTimeoutSec: DraftUnit<number | null>;
  readonly resumeFrom: DraftUnit<string | null>;
}

export function collectStage(rawItem: unknown, index: number, context: DraftStageContext): DraftStage | null {
  const { version2, problems } = context;
  if (stageMappingProblem(rawItem) || !isRecord(rawItem)) {
    problems.addMessage('invalid-value', 'Workflow stage must be a mapping.', ['stages', index]);
    return null;
  }
  const before = problems.items.length;
  const report = (message: string): void => {
    problems.addMessage(workflowRuleCode(message), message, stageErrorPath(message, index, rawItem));
  };
  const read = <T>(fn: () => T): DraftUnit<T> => {
    try {
      return { state: 'valid', value: fn() };
    } catch (error) {
      problems.add(error, stageErrorPath(error instanceof Error ? error.message : String(error), index, rawItem));
      return { state: 'invalid' };
    }
  };

  const idUnit = read(() => requiredString(rawItem.id, 'stages.id'));
  if (idUnit.state !== 'valid') return null;
  const stageId = idUnit.value;
  const reader: StageReader = { rawItem, index, stageId, context, report, read };

  const description = read(() => stageDescription(rawItem, stageId));
  const dependsOn = read(() => stageDependsOn(rawItem, stageId));
  const verify = read(() => stageVerify(rawItem, stageId));
  const runWhen = read(() =>
    stageRunWhen(rawItem, stageId, { version2, verify: verify.state === 'invalid' ? [] : verify.value }),
  );
  const { kind, role } = readStageKind(reader, verify);
  const roleFields = kind === 'role';
  const artifact = readStageArtifact(reader, kind, verify);
  const ask: DraftUnit<AskTarget> = roleFields && Object.hasOwn(rawItem, 'ask')
    ? read(() => stageAsk(rawItem, stageId))
    : ({ state: 'absent', value: 'human' } as const);
  const decision = readStageDecision(reader, roleFields);
  const fields: CollectedStageFields = {
    kind,
    role,
    description,
    dependsOn,
    verify,
    runWhen,
    artifact,
    ask,
    decision,
    ...readRoleOnlyFields(reader, roleFields),
    ...readVerifyLimits(reader, kind, verify),
    resumeFrom: read(() =>
      dependsOn.state === 'invalid'
        ? stageResumeFromUnchecked(rawItem, stageId)
        : stageResumeFrom(rawItem, stageId, dependsOn.value),
    ),
  };

  const clean = problems.items.length === before;
  return {
    index,
    id: stageId,
    kind,
    role,
    agent: fields.agent,
    options: fields.options,
    dependsOn,
    verify,
    maxRevisions: fields.maxRevisions,
    maxVerify: fields.maxVerify,
    verifyTimeoutSec: fields.verifyTimeoutSec,
    artifact,
    resumeFrom: fields.resumeFrom,
    runWhen,
    routes: decision.routes,
    spec: clean && kind !== null ? parseCollectedStageSpec(reader, fields, kind) : null,
    roleStage: collectedRoleStage(stageId, fields),
  };
}

/** Whether the stage runs a role or only verifies; a role-less stage is verify-only only with `verify`. */
function readStageKind(
  reader: StageReader,
  verify: DraftUnit<string[]>,
): { kind: DraftStage['kind']; role: DraftUnit<string> } {
  const { rawItem, stageId, context, report, read } = reader;
  const hasRole = stageHasRole(rawItem);
  const verifyOnly =
    !hasRole && context.version2 && verify.state !== 'invalid' && verify.value.length > 0;
  const role: DraftUnit<string> = hasRole
    ? read(() => requiredString(rawItem.role, `stages.${stageId}.role`))
    : { state: 'absent', value: '' };
  if (!hasRole && !verifyOnly) report(`stages.${stageId}.role is required.`);
  let kind: DraftStage['kind'] = null;
  if (hasRole) kind = 'role';
  else if (verifyOnly) kind = 'verify';
  if (kind === 'verify') {
    if (Object.hasOwn(rawItem, 'ask')) report(`stages.${stageId}.ask requires a role.`);
    for (const key of ROLE_ONLY_KEYS) {
      if (Object.hasOwn(rawItem, key) && (rawItem[key] !== null && rawItem[key] !== undefined)) report(`stages.${stageId}.${key} requires a role.`);
    }
  }
  return { kind, role };
}

/** Reads the legacy `produces` artifact, which schema_version 7 replaced with top-level artifacts. */
function readStageArtifact(
  reader: StageReader,
  kind: DraftStage['kind'],
  verify: DraftUnit<string[]>,
): DraftUnit<string | null> {
  const { rawItem, stageId, context, report, read } = reader;
  // `produces` stays readable without a role: output checks must not report a false missing artifact.
  // A verify-only stage with `produces` is invalid on its own, so dependent checks skip it.
  let artifact: DraftUnit<string | null>;
  if (context.version7) {
    if (Object.hasOwn(rawItem, 'produces')) {
      report(`stages.${stageId}.produces was removed in schema_version 7. Declare top-level artifacts and run \`migent migrate\`.`);
      artifact = { state: 'invalid' };
    } else artifact = { state: 'valid', value: null };
  } else if (kind === 'verify' && Object.hasOwn(rawItem, 'produces') && (rawItem.produces !== null && rawItem.produces !== undefined)) {
    artifact = { state: 'invalid' };
  } else artifact = read(() => stageArtifact(rawItem, stageId));
  if (
    kind === 'role' &&
    verify.state !== 'invalid' &&
    artifact.state !== 'invalid' &&
    verify.value.length > 0 &&
    artifact.value === VERIFY_ARTIFACT
  ) {
    report(`stages.${stageId}.produces.artifact cannot be ${VERIFY_ARTIFACT} on a stage with verify.`);
  }
  return artifact;
}

/** Reads the decision values and routes: the schema >= 3 decision list, or the legacy fields. */
function readStageDecision(reader: StageReader, roleFields: boolean): CollectedDecision {
  const { rawItem, index, stageId, context, read } = reader;
  const { version2, version3, declaredIds } = context;
  if (!roleFields) {
    return { values: { state: 'absent', value: [] }, instructions: {}, routes: { state: 'absent', value: {} } };
  }
  if (version3) return collectDecisionV3(rawItem, { stageId, index }, context);
  const values = read(() => stageDecisionValues(rawItem, stageId));
  const routes: CollectedDecision['routes'] =
    values.state === 'invalid'
      ? { state: 'invalid' }
      : read(() =>
          stageRoutes(rawItem, stageId, {
            values: values.value,
            stages: declaredStagePlaceholders(declaredIds),
            version2,
          }),
        );
  return { values, instructions: {}, routes };
}

/** Fields only a role stage reads; a verify-only stage leaves each absent. */
function readRoleOnlyFields(
  reader: StageReader,
  roleFields: boolean,
): Pick<CollectedStageFields, 'instructions' | 'agent' | 'options' | 'maxRevisions'> {
  const { rawItem, stageId, context, read } = reader;
  const { version5 } = context;
  const instructions: DraftUnit<string[]> = roleFields
    ? read(() => stringItems(rawItem.instructions, `stages.${stageId}.instructions`))
    : { state: 'absent', value: [] };
  const agent: DraftUnit<StageAgent | null> = roleFields
    ? read(() => (version5 ? stageAgent(rawItem, stageId) : legacyStageModel(rawItem, stageId)))
    : { state: 'absent', value: null };
  const options: DraftUnit<Record<string, string>> = roleFields && !version5
    ? read(() => stageOptions(rawItem, stageId))
    : { state: 'absent', value: {} };
  const maxRevisions: DraftUnit<number | null> = roleFields
    ? read(() => stageMaxRevisions(rawItem, stageId))
    : { state: 'absent', value: null };
  return { instructions, agent, options, maxRevisions };
}

/** Reads `max_verify` and `verify_timeout`, still checking each one when `verify` itself is unreadable. */
function readVerifyLimits(
  reader: StageReader,
  kind: DraftStage['kind'],
  verify: DraftUnit<string[]>,
): Pick<CollectedStageFields, 'maxVerify' | 'verifyTimeoutSec'> {
  const { rawItem, stageId, read } = reader;
  const maxVerify = read(() => {
    if (verify.state !== 'invalid') return stageMaxVerify(rawItem, stageId, verify.value);
    if (Object.hasOwn(rawItem, 'max_verify') && (rawItem.max_verify !== null && rawItem.max_verify !== undefined)) {
      return positiveInteger(rawItem.max_verify, `stages.${stageId}.max_verify`);
    }
    return kind === 'verify' ? 0 : DEFAULT_MAX_VERIFY;
  });
  const verifyTimeoutSec = read(() => {
    if (verify.state !== 'invalid') return stageVerifyTimeout(rawItem, stageId, verify.value);
    if (Object.hasOwn(rawItem, 'verify_timeout') && (rawItem.verify_timeout !== null && rawItem.verify_timeout !== undefined)) {
      return positiveInteger(rawItem.verify_timeout, `stages.${stageId}.verify_timeout`);
    }
    return null;
  });
  return { maxVerify, verifyTimeoutSec };
}

/** Builds the runtime spec of a stage read without problems; a schema rejection is reported instead. */
function parseCollectedStageSpec(
  reader: StageReader,
  fields: CollectedStageFields,
  kind: NonNullable<DraftStage['kind']>,
): StageSpec | null {
  const { rawItem, index, stageId, context } = reader;
  const { description, dependsOn, resumeFrom, instructions, agent, options, maxRevisions, decision } = fields;
  const { verify, maxVerify, verifyTimeoutSec, runWhen, artifact, ask, role } = fields;
  const common = {
    id: stageId,
    description: description.state === 'invalid' ? null : description.value,
    dependsOn: dependsOn.state === 'invalid' ? [] : dependsOn.value,
    resumeFrom: resumeFrom.state === 'invalid' ? null : resumeFrom.value,
    instructions: instructions.state === 'invalid' ? [] : instructions.value,
    agent: agent.state === 'invalid' ? null : agent.value,
    options: options.state === 'invalid' ? {} : options.value,
    maxRevisions: maxRevisions.state === 'invalid' ? null : maxRevisions.value,
    routes: decision.routes.state === 'invalid' ? {} : decision.routes.value,
    verify: verify.state === 'invalid' ? [] : verify.value,
    maxVerify: maxVerify.state === 'invalid' ? DEFAULT_MAX_VERIFY : maxVerify.value,
    verifyTimeoutSec: verifyTimeoutSec.state === 'invalid' ? null : verifyTimeoutSec.value,
    runWhen: runWhen.state === 'invalid' ? null : runWhen.value,
    artifacts: legacyArtifacts(stageId, artifact),
    decisionArtifacts: {},
    decisionValues: decision.values.state === 'invalid' ? [] : decision.values.value,
    ...(context.version3 && Object.keys(decision.instructions).length > 0
      ? { decisionInstructions: decision.instructions }
      : {}),
    ...(kind === 'role' && ask.state === 'valid' ? { ask: ask.value } : {}),
  };
  try {
    return stageSpecSchema.parse(
      kind === 'role'
        ? { ...common, kind: 'role', role: role.state === 'invalid' ? '' : role.value }
        : { ...common, kind: 'verify', role: null, verify: verify.state === 'invalid' ? [] : verify.value, maxVerify: 0 },
    ) as StageSpec;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      context.problems.add(error, stageErrorPath(error.message, index, rawItem));
    } else {
      context.problems.addMessage(
        'invalid-value',
        error instanceof Error ? error.message : String(error),
        ['stages', index],
      );
    }
    return null;
  }
}

/** The role-stage view later rules read even when an unrelated field of the stage failed. */
function collectedRoleStage(stageId: string, fields: CollectedStageFields): RoleStageSpec | null {
  const { kind, role, agent, options, description, artifact, decision, dependsOn, resumeFrom } = fields;
  const { instructions, maxRevisions, verify, maxVerify, verifyTimeoutSec, runWhen, ask } = fields;
  if (kind !== 'role' || role.state === 'invalid' || agent.state === 'invalid' || options.state === 'invalid') return null;
  return {
    kind: 'role',
    id: stageId,
    description: description.state === 'invalid' ? null : description.value,
    artifacts: legacyArtifacts(stageId, artifact),
    decisionArtifacts: {},
    decisionValues: decision.values.state === 'invalid' ? [] : decision.values.value,
    dependsOn: dependsOn.state === 'invalid' ? [] : dependsOn.value,
    resumeFrom: resumeFrom.state === 'invalid' ? null : resumeFrom.value,
    instructions: instructions.state === 'invalid' ? [] : instructions.value,
    agent: agent.value,
    options: options.value,
    maxRevisions: maxRevisions.state === 'invalid' ? null : maxRevisions.value,
    routes: decision.routes.state === 'invalid' ? {} : decision.routes.value,
    verify: verify.state === 'invalid' ? [] : verify.value,
    maxVerify: maxVerify.state === 'invalid' ? DEFAULT_MAX_VERIFY : maxVerify.value,
    verifyTimeoutSec: verifyTimeoutSec.state === 'invalid' ? null : verifyTimeoutSec.value,
    runWhen: runWhen.state === 'invalid' ? null : runWhen.value,
    role: role.value,
    ...(ask.state === 'valid' ? { ask: ask.value } : {}),
  };
}

/** Reads a string list for a top-level field, reporting each bad item on its own. */
export function collectStringItems(raw: unknown, field: string, problems: DraftProblems): void {
  if ((raw === null || raw === undefined)) return;
  if (!Array.isArray(raw)) {
    problems.addMessage('invalid-value', `${field} must be a list.`, [field]);
    return;
  }
  raw.forEach((item, index) => {
    draftUnit(() => requiredString(item, `${field}[${index}]`), problems, [field, index]);
  });
}
