/** Config mutation API and impact analysis over parsed config documents. */
import { isRecord } from '@nodeint/migent-workflow';
import { isRoleStage, type RoleStageSpec, type WorkflowDocument } from '@nodeint/migent-workflow';

import type { ClientRegistry } from './cli-client.js';
import { loadAgentTarget, loadRoleDescription, loadRoleResponsibilities, resolveRoleCascade, resolveStageSpec } from './config.js';
import { withAgentClient, withAgentOptions } from './config-edit-options.js';
import { compareString, mappingOrEmpty, optionsDict, recordEqual, roleOptionMap } from './config-text.js';
import { FIRST_DUPLICATE_SUFFIX } from './constants.js';
import { ConfigurationError } from './errors.js';
import { ConfigEditError, deepCopyRecord, deepEqual } from './yaml-patch.js';

const NAME = /^[A-Za-z][A-Za-z0-9._-]*$/;
const UNSET = Symbol('unset');

export interface StageRef {
  workflow: string;
  stage: string;
  agent: string | null;
  options: Record<string, string>;
}

export interface AgentView {
  key: string;
  client: string;
  model: string;
  options: Record<string, string>;
  roles: readonly string[];
  stages: readonly StageRef[];
}

export interface RoleView {
  role: string;
  description: string | null;
  agentName: string | null;
  client: string;
  model: string;
  options: Record<string, string>;
  responsibilities: readonly string[];
  sharedWith: readonly string[];
  stages: readonly StageRef[];
}

export interface ConfigView {
  agents: readonly AgentView[];
  roles: readonly RoleView[];
}

export interface StageShield {
  workflow: string;
  stage: string;
  ignores: readonly string[];
}

export interface ConfigChange {
  config: Record<string, unknown>;
  createdAgent: string | null;
  reusedAgent: string | null;
  updatedAgent: string | null;
  roles: readonly string[];
  stagesUpdated: readonly (readonly [string, string])[];
  stagesUnchanged: readonly StageShield[];
  orphanedAgents: readonly string[];
}

type ResolvedTarget = [string, string, [string, string][]];
type Binding = [unknown, [string, string][]];

export function inspectConfig(
  config: Record<string, unknown>,
  workflows: readonly WorkflowDocument[] = [],
  registry?: ClientRegistry,
): ConfigView {
  const agents = agentsOf(config);
  const roles = rolesOf(config);
  const agentViews: AgentView[] = [];
  for (const key of Object.keys(agents)) {
    const target = loadAgentTarget(config, key, { registry });
    const usedBy = Object.keys(roles).filter((name) => {
      const role = roles[name];
      return isRecord(role) && role.agent === key;
    });
    agentViews.push({
      key,
      client: target.client,
      model: target.model,
      options: { ...target.options },
      roles: usedBy,
      stages: stagesUsing(workflows, roles, key),
    });
  }
  const roleViews: RoleView[] = [];
  for (const [name, role] of Object.entries(roles)) {
    if (!isRecord(role)) throw new ConfigurationError(`Missing or invalid roles.${name}.`);
    const agentName = typeof role.agent === 'string' ? role.agent : null;
    const target = resolveRoleCascade(config, name, { registry });
    const shared = Object.keys(roles).filter((other) => {
      if (other === name) return false;
      const otherRole = roles[other];
      return agentName !== null && isRecord(otherRole) && otherRole.agent === agentName;
    });
    roleViews.push({
      role: name,
      description: loadRoleDescription(config, name),
      agentName,
      client: target.client,
      model: target.model,
      options: { ...target.options },
      responsibilities: loadRoleResponsibilities(config, name),
      sharedWith: shared,
      stages: roleStages(workflows, name),
    });
  }
  return { agents: agentViews, roles: roleViews };
}

export function upsertAgent(
  config: Record<string, unknown>,
  key: string,
  args: {
    client?: string | null;
    model?: string | null;
    options?: Record<string, string | null>;
    workflows?: readonly WorkflowDocument[];
    registry?: ClientRegistry;
  } = {},
): ConfigChange {
  const client = args.client === undefined ? null : args.client;
  const model = args.model === undefined ? null : args.model;
  const options = args.options === undefined ? UNSET : args.options;
  if ((client === null) !== (model === null)) {
    throw new ConfigEditError('Pass both --client and --model, or omit both.');
  }
  const updated = copyConfig(config);
  const agents = agentsOf(updated);
  const exists = Object.hasOwn(agents, key);
  if (!exists) requireName(key, 'name');
  if (!exists && client === null) {
    throw new ConfigEditError('Pass --client and --model to add an agent.');
  }
  let body: Record<string, unknown> = {};
  if (exists) {
    const current = agents[key];
    if (!isRecord(current)) throw new ConfigurationError(`Missing or invalid agents.${key}.`);
    body = current;
  }
  if (client !== null && model !== null) {
    body = { ...withAgentClient(body, plain(client, '--client')), model: plain(model, '--model') };
  }
  if (options !== UNSET) body = withAgentOptions(body, key, options);
  agents[key] = body;
  return describeChange(config, updated, { workflows: args.workflows, registry: args.registry });
}

export function assignRoles(
  config: Record<string, unknown>,
  roles: readonly string[],
  args: { agentName: string; workflows?: readonly WorkflowDocument[]; registry?: ClientRegistry },
): ConfigChange {
  const { agentName } = args;
  const names = roleNames(roles);
  const updated = copyConfig(config);
  const agents = agentsOf(updated);
  if (!Object.hasOwn(agents, agentName)) throw new ConfigEditError(`Unknown name: ${agentName}.`);
  const roleMap = rolesOf(updated);
  for (const name of names) {
    if (!Object.hasOwn(roleMap, name)) {
      requireName(name, 'role');
      roleMap[name] = { agent: agentName };
      continue;
    }
    const role = roleMap[name];
    if (!isRecord(role)) throw new ConfigurationError(`Missing or invalid roles.${name}.`);
    role.agent = agentName;
  }
  return describeChange(config, updated, { workflows: args.workflows, registry: args.registry });
}

export function placeRoleAgent(
  config: Record<string, unknown>,
  role: string,
  args: {
    client: string;
    model: string;
    options?: Record<string, string | null>;
    workflows?: readonly WorkflowDocument[];
    registry?: ClientRegistry;
  },
): ConfigChange {
  requireName(role, 'role');
  const clientName = plain(args.client, '--client');
  const modelId = plain(args.model, '--model');
  const options = args.options === undefined ? UNSET : args.options;
  const workflows = args.workflows ?? [];
  const updated = copyConfig(config);
  const agents = agentsOf(updated);
  let definition: Record<string, unknown> = { client: { type: clientName }, model: modelId };
  if (options !== UNSET) definition = withAgentOptions(definition, role, options);
  let match = matchingAgentName(updated, {
    client: clientName, model: modelId, options: optionsDict(definition, role),
  }, args.registry);
  let created: string | null = null;
  let reused: string | null = null;
  if (match === null) {
    match = suggestAgentName(updated, role);
    agents[match] = definition;
    created = match;
  } else {
    reused = match;
  }
  const roleMap = rolesOf(updated);
  if (!Object.hasOwn(roleMap, role)) {
    roleMap[role] = { agent: match };
  } else {
    const body = roleMap[role];
    if (!isRecord(body)) throw new ConfigurationError(`Missing or invalid roles.${role}.`);
    body.agent = match;
  }
  const change = describeChange(config, updated, { workflows, reusedAgent: reused, registry: args.registry });
  if (created !== null) return { ...change, createdAgent: created, reusedAgent: null };
  return change;
}

export function matchingAgentName(
  config: Record<string, unknown>,
  args: { client: string; model: string; options: Record<string, string> },
  registry?: ClientRegistry,
): string | null {
  const agents = agentsOf(config);
  const wanted = { ...args.options };
  for (const key of Object.keys(agents)) {
    let target;
    try {
      target = loadAgentTarget(config, key, { registry });
    } catch (error) {
      if (error instanceof ConfigurationError) continue;
      throw error;
    }
    if (
      target.client === args.client &&
      target.model === args.model &&
      recordEqual(target.options, wanted)
    ) {
      return String(key);
    }
  }
  return null;
}

export function describeChange(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  args: { workflows?: readonly WorkflowDocument[]; reusedAgent?: string | null; registry?: ClientRegistry } = {},
): ConfigChange {
  const { workflows = [] } = args;
  const afterCopy = deepCopyRecord(after);
  const beforeRoles = mappingOrEmpty(before.roles);
  const afterRoles = mappingOrEmpty(afterCopy.roles);
  const beforeAgents = mappingOrEmpty(before.agents);
  const afterAgents = mappingOrEmpty(afterCopy.agents);
  const changedRoles = orderedKeys(afterRoles, beforeRoles).filter(
    (name) =>
      !bindingsEqual(binding(beforeRoles[name]), binding(afterRoles[name])) ||
      !resolvedEqual(resolvedRole(before, name, args.registry), resolvedRole(afterCopy, name, args.registry)),
  );
  const created = Object.keys(afterAgents).filter((key) => !Object.hasOwn(beforeAgents, key));
  const updated = Object.keys(afterAgents).filter(
    (key) =>
      Object.hasOwn(beforeAgents, key) &&
      !deepEqual(signature(beforeAgents[key]), signature(afterAgents[key])),
  );
  const createdAgent = created.length === 1 ? created[0]! : null;
  const updatedAgent = updated.length === 1 ? updated[0]! : null;
  let reusedAgent = args.reusedAgent ?? null;
  if (createdAgent !== null || updatedAgent !== null) reusedAgent = null;
  const stagesUpdated: [string, string][] = [];
  const stagesUnchanged: StageShield[] = [];
  for (const document of workflows) {
    for (const stage of Object.values(document.stages)) {
      if (!isRoleStage(stage)) continue;
      const beforeTarget = resolvedStage(before, stage, args.registry);
      const afterTarget = resolvedStage(afterCopy, stage, args.registry);
      if (!resolvedEqual(beforeTarget, afterTarget)) {
        stagesUpdated.push([document.id, stage.id]);
        continue;
      }
      const ignores = shields(stage, { beforeRoles, afterRoles, beforeAgents, afterAgents, updatedAgents: updated });
      if (ignores.length > 0) {
        stagesUnchanged.push({ workflow: document.id, stage: stage.id, ignores });
      }
    }
  }
  return {
    config: afterCopy,
    createdAgent,
    reusedAgent,
    updatedAgent,
    roles: changedRoles,
    stagesUpdated,
    stagesUnchanged,
    orphanedAgents: orphans(before, afterCopy, workflows),
  };
}

function stagesUsing(
  workflows: readonly WorkflowDocument[],
  roles: Record<string, unknown>,
  agentName: string,
): StageRef[] {
  const found: StageRef[] = [];
  for (const document of workflows) {
    for (const stage of Object.values(document.stages)) {
      if (!isRoleStage(stage)) continue;
      let key: unknown = stage.agent?.kind === 'named' ? stage.agent.name : null;
      if (stage.agent === null) {
        const role = roles[stage.role];
        if (isRecord(role)) key = role.agent;
      }
      if (key === agentName) {
        found.push({ workflow: document.id, stage: stage.id, agent: null, options: {} });
      }
    }
  }
  return found;
}

function roleStages(workflows: readonly WorkflowDocument[], role: string): StageRef[] {
  const found: StageRef[] = [];
  for (const document of workflows) {
    for (const stage of Object.values(document.stages)) {
      if (!isRoleStage(stage) || stage.role !== role) continue;
      found.push({
        workflow: document.id,
        stage: stage.id,
        agent: stage.agent?.kind === 'named' ? stage.agent.name : null,
        options: { ...stage.options },
      });
    }
  }
  return found;
}

/** The roles and agents of both configs, and the agents whose definition changed. */
interface ShieldChange {
  readonly beforeRoles: Record<string, unknown>;
  readonly afterRoles: Record<string, unknown>;
  readonly beforeAgents: Record<string, unknown>;
  readonly afterAgents: Record<string, unknown>;
  readonly updatedAgents: readonly string[];
}

function shields(stage: RoleStageSpec, change: ShieldChange): string[] {
  const { beforeRoles, afterRoles } = change;
  const beforeBinding = binding(beforeRoles[stage.role]);
  const afterBinding = binding(afterRoles[stage.role]);
  const ignores: string[] = [];
  if (stage.agent !== null && !deepEqual(beforeBinding[0], afterBinding[0])) ignores.push('role-agent');
  if (
    Object.keys(stage.options).length > 0 &&
    (!deepEqual(beforeBinding[1], afterBinding[1]) ||
      agentOptionsChanged(stage, afterBinding, change))
  ) {
    ignores.push('role-options');
  }
  return ignores;
}

function agentOptionsChanged(stage: RoleStageSpec, afterBinding: Binding, change: ShieldChange): boolean {
  const { beforeAgents, afterAgents, updatedAgents } = change;
  const named = stage.agent?.kind === 'named' ? stage.agent.name : afterBinding[0];
  if (typeof named !== 'string' || !updatedAgents.includes(named)) return false;
  return !recordEqual(optionsDict(beforeAgents[named], named), optionsDict(afterAgents[named], named));
}

function orphans(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  workflows: readonly WorkflowDocument[],
): string[] {
  const afterRefs = references(after, workflows);
  const removed = new Set([...references(before, workflows)].filter((key) => !afterRefs.has(key)));
  const agents = mappingOrEmpty(after.agents);
  return Object.keys(agents).filter((key) => removed.has(key));
}

function references(config: Record<string, unknown>, workflows: readonly WorkflowDocument[]): Set<string> {
  const found = new Set<string>();
  for (const role of Object.values(mappingOrEmpty(config.roles))) {
    if (isRecord(role) && typeof role.agent === 'string') found.add(role.agent);
  }
  for (const document of workflows) {
    for (const stage of Object.values(document.stages)) {
      if (stage.agent?.kind === 'named') found.add(stage.agent.name);
    }
  }
  return found;
}

function resolvedRole(config: Record<string, unknown>, role: string, registry?: ClientRegistry): ResolvedTarget | null {
  const {roles} = config;
  if (!isRecord(roles) || !Object.hasOwn(roles, role)) return null;
  try {
    const target = resolveRoleCascade(config, role, { registry });
    return [target.client, target.model, sortedItems(target.options)];
  } catch (error) {
    if (error instanceof ConfigurationError) return null;
    throw error;
  }
}

function resolvedStage(
  config: Record<string, unknown>,
  stage: RoleStageSpec,
  registry?: ClientRegistry,
): ResolvedTarget | null {
  try {
    const target = resolveStageSpec(config, stage, { registry });
    return [target.client, target.model, sortedItems(target.options)];
  } catch (error) {
    if (error instanceof ConfigurationError) return null;
    throw error;
  }
}

function binding(role: unknown): Binding {
  if (!isRecord(role)) return [null, []];
  const agentName = Object.hasOwn(role, 'agent') ? role.agent : null;
  return [agentName ?? null, sortedItems(roleOptionMap(role))];
}

function signature(body: unknown): unknown[] {
  if (!isRecord(body)) return [body];
  const client = isRecord(body.client) ? body.client : {};
  const {options} = client;
  const rendered = isRecord(options)
    ? Object.entries(options)
        .map(([key, value]) => [String(key), String(value)] as [string, string])
        .sort(comparePair)
    : [];
  return [body.model ?? null, client.type ?? null, rendered];
}

function copyConfig(config: Record<string, unknown>): Record<string, unknown> {
  const copied = deepCopyRecord(config);
  if (copied.agents === undefined) copied.agents = {};
  agentsOf(copied);
  rolesOf(copied);
  return copied;
}

function agentsOf(config: Record<string, unknown>): Record<string, unknown> {
  const value = config.agents === undefined ? {} : config.agents;
  if (!isRecord(value)) throw new ConfigurationError('Missing or invalid agents.');
  return value;
}

function rolesOf(config: Record<string, unknown>): Record<string, unknown> {
  const value = config.roles;
  if (!isRecord(value)) throw new ConfigurationError('Missing or invalid roles.');
  return value;
}

function roleNames(roles: readonly string[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const role of roles) {
    if (!role || role.trim() === '') continue;
    const trimmed = role.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    names.push(trimmed);
  }
  if (names.length === 0) throw new ConfigEditError('Pass a role.');
  for (const name of names) requireName(name, 'role');
  return names;
}

function requireName(value: string, label: string): void {
  if (!NAME.test(value)) throw new ConfigEditError(`Invalid ${label}: ${value}.`);
}

function plain(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigEditError(`Missing or invalid ${field}.`);
  }
  return value.trim();
}

function suggestAgentName(config: Record<string, unknown>, role: string): string {
  const {agents} = config;
  const taken = isRecord(agents) ? agents : {};
  const base = NAME.test(role) ? role : 'agent';
  if (!Object.hasOwn(taken, base)) return base;
  let index = FIRST_DUPLICATE_SUFFIX;
  while (Object.hasOwn(taken, `${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function orderedKeys(...maps: Record<string, unknown>[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const map of maps) {
    for (const key of Object.keys(map)) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

function sortedItems(record: Record<string, string>): [string, string][] {
  return Object.entries(record).sort(comparePair);
}

function comparePair(left: [string, string], right: [string, string]): number {
  return compareString(left[0], right[0]) || compareString(left[1], right[1]);
}

function bindingsEqual(left: Binding, right: Binding): boolean {
  return deepEqual(left[0], right[0]) && deepEqual(left[1], right[1]);
}

function resolvedEqual(left: ResolvedTarget | null, right: ResolvedTarget | null): boolean {
  if (left === null || right === null) return left === right;
  return left[0] === right[0] && left[1] === right[1] && deepEqual(left[2], right[2]);
}

