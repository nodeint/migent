import { isRecord } from '@nodeint/migent-workflow';

import { ConfigurationError } from './errors.js';
import { legacyClientOf } from './legacy-provider.js';

/**
 * The schema_version 4 to 5 rewrite of a config mapping, in place:
 * `models` becomes `agents`; an agent's `client: <id>` becomes `client.type` and its `options`
 * become `client.options`; a role's `default_model` becomes `agent` and its `instructions` become
 * `responsibilities`. Returns one note per change. Applies to config.yaml and config.local.yaml alike.
 */
export function liftConfigAgents(config: Record<string, unknown>): string[] {
  const notes: string[] = [];
  if (Object.hasOwn(config, 'models')) {
    if (Object.hasOwn(config, 'agents')) {
      throw new ConfigurationError('config has both models and agents; merge them into agents before migrating.');
    }
    const {models} = config;
    if (isRecord(models)) {
      const agents: Record<string, unknown> = {};
      for (const [name, body] of Object.entries(models)) {
        agents[name] = isRecord(body) ? liftAgentBody(body, `agents.${name}`, notes) : body;
      }
      renameKey(config, 'models', 'agents', agents);
    } else {
      renameKey(config, 'models', 'agents', models);
    }
    notes.unshift('models -> agents');
  }
  if (isRecord(config.roles)) {
    for (const [name, role] of Object.entries(config.roles)) {
      if (!isRecord(role)) continue;
      const label = `roles.${name}`;
      const lifted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(role)) {
        if (key === 'default_model') {
          if (Object.hasOwn(role, 'agent')) throw new ConfigurationError(`${label} has both default_model and agent.`);
          lifted.agent = isRecord(value) ? liftAgentBody(value, `${label}.agent`, notes) : value;
          notes.push(`${label}.default_model -> agent`);
        } else if (key === 'instructions') {
          if (Object.hasOwn(role, 'responsibilities')) {
            throw new ConfigurationError(`${label} has both instructions and responsibilities.`);
          }
          lifted.responsibilities = value;
          notes.push(`${label}.instructions -> responsibilities`);
        } else {
          lifted[key] = value;
        }
      }
      config.roles[name] = lifted;
    }
  }
  return notes;
}

function liftAgentBody(body: Record<string, unknown>, label: string, notes: string[]): Record<string, unknown> {
  const hasClientString = typeof body.client === 'string';
  const hasOptions = Object.hasOwn(body, 'options');
  if (!hasClientString && !hasOptions) return body;
  const lifted: Record<string, unknown> = {};
  const client: Record<string, unknown> = isRecord(body.client) ? { ...body.client } : {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'client' && hasClientString) {
      client.type = value;
      notes.push(`${label}.client -> client.type`);
    } else if (key === 'options') {
      if ((value !== null && value !== undefined)) client.options = value;
      notes.push(`${label}.options -> client.options`);
    } else {
      lifted[key] = value;
    }
  }
  if (Object.keys(client).length > 0) {
    // `type` reads first, as in the documented layout.
    const { type, options, ...rest } = client;
    lifted.client = {
      ...(type === undefined ? {} : { type }),
      ...rest,
      ...(options === undefined ? {} : { options }),
    };
  }
  return lifted;
}

/** Renames a key without moving it: the other keys keep their order. */
function renameKey(target: Record<string, unknown>, from: string, to: string, value: unknown): void {
  const entries = Object.entries(target);
  for (const key of Object.keys(target)) delete target[key];
  for (const [key, item] of entries) {
    if (key === from) target[to] = value;
    else target[key] = item;
  }
}

/** Which document a v5 to v6 lift is rewriting. */
export type ConfigLayerKind = 'project' | 'local';

export interface LiftConfigClientsInput {
  layer: ConfigLayerKind;
  /** The project layer after earlier migration steps, for a local rewrite's merged view. */
  project: Readonly<Record<string, unknown>>;
  /** The local layer after earlier migration steps, when it exists. */
  local?: Readonly<Record<string, unknown>> | null;
  /** The original v5 project + local merge, before any rewrite. */
  merged: Readonly<Record<string, unknown>>;
  /** The layer being rewritten (one of `project` / `local`, already lifted to v5). */
  layerConfig: Record<string, unknown>;
  /** Client ids named in the error when a provider has no resolvable client. */
  clientIds: readonly string[];
}

/**
 * The schema_version 5 to 6 lift of one config layer, in place: a legacy
 * `provider` is replaced by `client.type`, or dropped when another layer
 * supplies the explicit client. Every decision reads the original v5 layer
 * view, never a layer that has already been migrated.
 *
 * A synthesized client is written into the layer that supplied its provider,
 * so machine-local choices stay local and shared choices stay shared.
 */
export function liftConfigClients(input: LiftConfigClientsInput): string[] {
  const { layer, layerConfig, project, local, merged, clientIds } = input;
  const notes: string[] = [];

  const projectAgents = isRecord(project.agents) ? project.agents : {};
  const localAgents = isRecord(local?.agents) ? local.agents : {};
  const mergedAgents = isRecord(merged.agents) ? merged.agents : {};
  if (isRecord(layerConfig.agents)) {
    for (const [name, raw] of Object.entries(layerConfig.agents)) {
      if (!isRecord(raw)) continue;
      const label = `agents.${name}`;
      const mergedBody = isRecord(mergedAgents[name]) ? mergedAgents[name] : null;
      const otherAgents = layer === 'project' ? localAgents : projectAgents;
      const otherBody = isRecord(otherAgents[name]) ? otherAgents[name] : null;
      liftBody(raw, label, {
        layer,
        kind: 'named',
        mergedBody,
        otherBody,
        clientIds,
        notes,
      });
    }
  }

  const projectRoles = isRecord(project.roles) ? project.roles : {};
  const localRoles = isRecord(local?.roles) ? local.roles : {};
  const mergedRoles = isRecord(merged.roles) ? merged.roles : {};
  if (isRecord(layerConfig.roles)) {
    for (const [name, rawRole] of Object.entries(layerConfig.roles)) {
      if (!isRecord(rawRole) || !isRecord(rawRole.agent)) continue;
      const label = `roles.${name}.agent`;
      // A role agent is replaced whole by the layer that declares it.
      const mergedRole = isRecord(mergedRoles[name]) ? mergedRoles[name] : null;
      const mergedBody = mergedRole !== null && isRecord(mergedRole.agent) ? mergedRole.agent : null;
      const otherRole = layer === 'project' ? localRoles[name] : projectRoles[name];
      const otherBody = isRecord(otherRole) && isRecord(otherRole.agent) ? otherRole.agent : null;
      liftBody(rawRole.agent, label, {
        layer,
        kind: 'role',
        mergedBody,
        otherBody,
        clientIds,
        notes,
      });
    }
  }
  return notes;
}

interface LiftBodyContext {
  layer: ConfigLayerKind;
  kind: 'named' | 'role';
  mergedBody: Record<string, unknown> | null;
  otherBody: Record<string, unknown> | null;
  clientIds: readonly string[];
  notes: string[];
}

function liftBody(body: Record<string, unknown>, label: string, context: LiftBodyContext): void {
  if (!Object.hasOwn(body, 'provider')) return;
  const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
  const explicit = explicitClient(body);
  // Rule 1: an explicit client in this body wins; the provider is only noise.
  if (explicit !== null) {
    delete body.provider;
    context.notes.push(`${label}.provider dropped (explicit client ${explicit})`);
    return;
  }
  // Local providers yield to explicit clients in the merged view. A project
  // default must survive for project-alone use; only an unresolvable project
  // provider relies on a client supplied by the local layer.
  const mergedExplicit = explicitClient(context.mergedBody);
  if (mergedExplicit !== null && (context.layer === 'local' || legacyClientOf(provider) === null)) {
    delete body.provider;
    const source = context.layer === 'local' ? 'config.yaml' : 'config.local.yaml';
    context.notes.push(`${label}.provider dropped (client from ${source})`);
    return;
  }
  const effective = legacyClientOf(provider);
  if (effective === null) {
    // Rule 4: no view supplies a client, so migration cannot invent one.
    throw new ConfigurationError(
      `${label}: provider ${provider || '(empty)'} has no default client; add ${label}.client.type (one of: ${context.clientIds.join(', ')}) and rerun migrate.`,
    );
  }
  // Rule 2: write the synthesized client into the layer that supplied the provider.
  setClientType(body, effective);
  delete body.provider;
  context.notes.push(`${label}.provider ${provider} -> client.type ${effective}`);
}

function explicitClient(body: Record<string, unknown> | null): string | null {
  if (body === null || !isRecord(body.client)) return null;
  const {type} = body.client;
  return typeof type === 'string' && type.trim() !== '' ? type.trim() : null;
}

function setClientType(body: Record<string, unknown>, client: string): void {
  const existing = isRecord(body.client) ? body.client : {};
  const { type: ignoredType, ...rest } = existing;
  body.client = { type: client, ...rest };
}

/** The client a v5 body selects: explicit `client.type`, else the provider's fixed default. */
export function effectiveClientValue(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const explicit = explicitClient(body);
  if (explicit !== null) return explicit;
  const provider = typeof body.provider === 'string' ? body.provider : null;
  return legacyClientOf(provider);
}

/**
 * The equivalence guard: after a rewrite every location must keep the client
 * it had in the original v5 documents, in both views (project alone, merged).
 * Any change aborts the write.
 */
export function assertConfigClientEquivalence(input: {
  originalProject: Readonly<Record<string, unknown>>;
  originalMerged: Readonly<Record<string, unknown>>;
  updatedProject: Readonly<Record<string, unknown>>;
  updatedMerged: Readonly<Record<string, unknown>>;
}): void {
  // The plan's two views: project alone and project merged with local.
  compareView('config.yaml', input.originalProject, input.updatedProject);
  compareView('merged config', input.originalMerged, input.updatedMerged);
}

function compareView(label: string, before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>): void {
  for (const [name, body] of locations(before)) {
    const next = findLocation(after, name);
    const previousClient = effectiveClientValue(body);
    const nextClient = effectiveClientValue(next);
    if (previousClient !== nextClient) {
      throw new ConfigurationError(
        `migration would change ${label} ${name} from client ${previousClient ?? '(none)'} to ${nextClient ?? '(none)'}; nothing was written.`,
      );
    }
  }
}

function locations(config: Readonly<Record<string, unknown>>): [string, unknown][] {
  const found: [string, unknown][] = [];
  if (isRecord(config.agents)) {
    for (const [name, body] of Object.entries(config.agents)) found.push([`agents.${name}`, body]);
  }
  if (isRecord(config.roles)) {
    for (const [name, role] of Object.entries(config.roles)) {
      if (isRecord(role) && isRecord(role.agent)) found.push([`roles.${name}.agent`, role.agent]);
    }
  }
  return found;
}

function findLocation(config: Readonly<Record<string, unknown>>, name: string): unknown {
  const match = /^roles\.(.+)\.agent$/.exec(name);
  if (match !== null && isRecord(config.roles)) {
    const role = config.roles[match[1] as string];
    return isRecord(role) ? role.agent : undefined;
  }
  if (name.startsWith('agents.') && isRecord(config.agents)) return config.agents[name.slice(7)];
  return undefined;
}

/** Inline stage agents replace the whole agent, so they follow the project-layer rules. */
export function liftWorkflowClients(
  workflow: Record<string, unknown>,
  config: Readonly<Record<string, unknown>>,
  clientIds: readonly string[],
): string[] {
  const notes: string[] = [];
  if (!Array.isArray(workflow.stages)) return notes;
  for (const stage of workflow.stages) {
    if (!isRecord(stage) || !isRecord(stage.agent) || !Object.hasOwn(stage.agent, 'provider')) continue;
    const label = `stages.${typeof stage.id === 'string' ? stage.id : '?'}.agent`;
    const body = stage.agent;
    liftBody(body, label, {
      layer: 'project',
      kind: 'role',
      mergedBody: isRecord(config) ? body : null,
      otherBody: null,
      clientIds,
      notes,
    });
  }
  return notes;
}
