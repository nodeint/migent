import { isRecord } from '@nodeint/migent-workflow';

import { ConfigurationError } from './errors.js';
import { legacyClientOf } from './legacy-provider.js';

/** A migrated document and one note per change. The lift never changes the document it receives. */
export interface Lifted {
  document: Record<string, unknown>;
  notes: string[];
}

/**
 * The schema_version 4 to 5 rewrite of a config mapping:
 * `models` becomes `agents`; an agent's `client: <id>` becomes `client.type` and its `options`
 * become `client.options`; a role's `default_model` becomes `agent` and its `instructions` become
 * `responsibilities`. Returns the rewritten copy and one note per change. Applies to config.yaml and
 * config.local.yaml alike.
 */
export function liftConfigAgents(config: Readonly<Record<string, unknown>>): Lifted {
  const notes: string[] = [];
  let document: Record<string, unknown> = { ...config };
  if (Object.hasOwn(config, 'models')) {
    if (Object.hasOwn(config, 'agents')) {
      throw new ConfigurationError('config has both models and agents; merge them into agents before migrating.');
    }
    const {models} = config;
    let agents = models;
    if (isRecord(models)) {
      agents = Object.fromEntries(
        Object.entries(models).map(([name, body]) => {
          if (!isRecord(body)) return [name, body];
          const lifted = liftAgentBody(body, `agents.${name}`);
          notes.push(...lifted.notes);
          return [name, lifted.body];
        }),
      );
    }
    document = withRenamedKey(config, { from: 'models', to: 'agents', value: agents });
    notes.unshift('models -> agents');
  }
  if (isRecord(document.roles)) {
    const roles = Object.fromEntries(
      Object.entries(document.roles).map(([name, role]) => {
        if (!isRecord(role)) return [name, role];
        const lifted = liftRole(role, `roles.${name}`);
        notes.push(...lifted.notes);
        return [name, lifted.body];
      }),
    );
    document = { ...document, roles };
  }
  return { document, notes };
}

interface LiftedBody {
  body: Record<string, unknown>;
  notes: string[];
}

function liftRole(role: Record<string, unknown>, label: string): LiftedBody {
  const notes: string[] = [];
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(role)) {
    if (key === 'default_model') {
      if (Object.hasOwn(role, 'agent')) throw new ConfigurationError(`${label} has both default_model and agent.`);
      if (isRecord(value)) {
        const lifted = liftAgentBody(value, `${label}.agent`);
        body.agent = lifted.body;
        notes.push(...lifted.notes);
      } else {
        body.agent = value;
      }
      notes.push(`${label}.default_model -> agent`);
    } else if (key === 'instructions') {
      if (Object.hasOwn(role, 'responsibilities')) {
        throw new ConfigurationError(`${label} has both instructions and responsibilities.`);
      }
      body.responsibilities = value;
      notes.push(`${label}.instructions -> responsibilities`);
    } else {
      body[key] = value;
    }
  }
  return { body, notes };
}

function liftAgentBody(body: Record<string, unknown>, label: string): LiftedBody {
  const hasClientString = typeof body.client === 'string';
  const hasOptions = Object.hasOwn(body, 'options');
  if (!hasClientString && !hasOptions) return { body, notes: [] };
  const notes: string[] = [];
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
  return { body: lifted, notes };
}

/** A copy of `record` with `from` renamed to `to` and set to `value`. The other keys keep their order. */
function withRenamedKey(
  record: Readonly<Record<string, unknown>>,
  rename: { readonly from: string; readonly to: string; readonly value: unknown },
): Record<string, unknown> {
  const { from, to, value } = rename;
  return Object.fromEntries(Object.entries(record).map(([key, item]) => (key === from ? [to, value] : [key, item])));
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
 * The schema_version 5 to 6 lift of one config layer: a legacy
 * `provider` is replaced by `client.type`, or dropped when another layer
 * supplies the explicit client. Every decision reads the original v5 layer
 * view, never a layer that has already been migrated. Returns the lifted layer;
 * `layerConfig` is left as it was.
 *
 * A synthesized client is written into the layer that supplied its provider,
 * so machine-local choices stay local and shared choices stay shared.
 */
export function liftConfigClients(input: LiftConfigClientsInput): Lifted {
  const { layer, layerConfig, project, local, merged, clientIds } = input;
  const notes: string[] = [];
  let document: Record<string, unknown> = layerConfig;

  const projectAgents = isRecord(project.agents) ? project.agents : {};
  const localAgents = isRecord(local?.agents) ? local.agents : {};
  const mergedAgents = isRecord(merged.agents) ? merged.agents : {};
  if (isRecord(layerConfig.agents)) {
    const agents = Object.fromEntries(
      Object.entries(layerConfig.agents).map(([name, raw]) => {
        if (!isRecord(raw)) return [name, raw];
        const mergedBody = isRecord(mergedAgents[name]) ? mergedAgents[name] : null;
        const otherAgents = layer === 'project' ? localAgents : projectAgents;
        const otherBody = isRecord(otherAgents[name]) ? otherAgents[name] : null;
        const lifted = liftBody(raw, `agents.${name}`, { layer, kind: 'named', mergedBody, otherBody, clientIds });
        if (lifted.note !== null) notes.push(lifted.note);
        return [name, lifted.body];
      }),
    );
    document = { ...document, agents };
  }

  const projectRoles = isRecord(project.roles) ? project.roles : {};
  const localRoles = isRecord(local?.roles) ? local.roles : {};
  const mergedRoles = isRecord(merged.roles) ? merged.roles : {};
  if (isRecord(layerConfig.roles)) {
    const roles = Object.fromEntries(
      Object.entries(layerConfig.roles).map(([name, rawRole]) => {
        if (!isRecord(rawRole) || !isRecord(rawRole.agent)) return [name, rawRole];
        // A role agent is replaced whole by the layer that declares it.
        const mergedRole = isRecord(mergedRoles[name]) ? mergedRoles[name] : null;
        const mergedBody = mergedRole !== null && isRecord(mergedRole.agent) ? mergedRole.agent : null;
        const otherRole = layer === 'project' ? localRoles[name] : projectRoles[name];
        const otherBody = isRecord(otherRole) && isRecord(otherRole.agent) ? otherRole.agent : null;
        const lifted = liftBody(rawRole.agent, `roles.${name}.agent`, { layer, kind: 'role', mergedBody, otherBody, clientIds });
        if (lifted.note !== null) notes.push(lifted.note);
        return [name, { ...rawRole, agent: lifted.body }];
      }),
    );
    document = { ...document, roles };
  }
  return { document, notes };
}

interface LiftBodyContext {
  layer: ConfigLayerKind;
  kind: 'named' | 'role';
  mergedBody: Record<string, unknown> | null;
  otherBody: Record<string, unknown> | null;
  clientIds: readonly string[];
}

/** The body without a legacy `provider`, and the note that says what became of it. */
function liftBody(
  body: Record<string, unknown>,
  label: string,
  context: LiftBodyContext,
): { body: Record<string, unknown>; note: string | null } {
  if (!Object.hasOwn(body, 'provider')) return { body, note: null };
  const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
  const explicit = explicitClient(body);
  // Rule 1: an explicit client in this body wins; the provider is only noise.
  if (explicit !== null) {
    return { body: withoutKey(body, 'provider'), note: `${label}.provider dropped (explicit client ${explicit})` };
  }
  // Local providers yield to explicit clients in the merged view. A project
  // default must survive for project-alone use; only an unresolvable project
  // provider relies on a client supplied by the local layer.
  const mergedExplicit = explicitClient(context.mergedBody);
  if (mergedExplicit !== null && (context.layer === 'local' || legacyClientOf(provider) === null)) {
    const source = context.layer === 'local' ? 'config.yaml' : 'config.local.yaml';
    return { body: withoutKey(body, 'provider'), note: `${label}.provider dropped (client from ${source})` };
  }
  const effective = legacyClientOf(provider);
  if (effective === null) {
    // Rule 4: no view supplies a client, so migration cannot invent one.
    throw new ConfigurationError(
      `${label}: provider ${provider || '(empty)'} has no default client; add ${label}.client.type (one of: ${context.clientIds.join(', ')}) and rerun migrate.`,
    );
  }
  // Rule 2: write the synthesized client into the layer that supplied the provider.
  return {
    body: withoutKey(withClientType(body, effective), 'provider'),
    note: `${label}.provider ${provider} -> client.type ${effective}`,
  };
}

function withoutKey(record: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

function explicitClient(body: Record<string, unknown> | null): string | null {
  if (body === null || !isRecord(body.client)) return null;
  const {type} = body.client;
  return typeof type === 'string' && type.trim() !== '' ? type.trim() : null;
}

function withClientType(body: Readonly<Record<string, unknown>>, client: string): Record<string, unknown> {
  const existing = isRecord(body.client) ? body.client : {};
  const { type: ignoredType, ...rest } = existing;
  return { ...body, client: { type: client, ...rest } };
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

function compareView(
  label: string,
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): void {
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

const AGENTS_PREFIX = 'agents.';

function findLocation(config: Readonly<Record<string, unknown>>, name: string): unknown {
  const match = /^roles\.(.+)\.agent$/.exec(name);
  if (match !== null && isRecord(config.roles)) {
    const role = config.roles[match[1] as string];
    return isRecord(role) ? role.agent : undefined;
  }
  if (name.startsWith(AGENTS_PREFIX) && isRecord(config.agents)) return config.agents[name.slice(AGENTS_PREFIX.length)];
  return undefined;
}

/** Inline stage agents replace the whole agent, so they follow the project-layer rules. */
export function liftWorkflowClients(
  workflow: Readonly<Record<string, unknown>>,
  config: Readonly<Record<string, unknown>>,
  clientIds: readonly string[],
): Lifted {
  if (!Array.isArray(workflow.stages)) return { document: { ...workflow }, notes: [] };
  const notes: string[] = [];
  const stages = workflow.stages.map((stage: unknown) => {
    if (!isRecord(stage) || !isRecord(stage.agent) || !Object.hasOwn(stage.agent, 'provider')) return stage;
    const label = `stages.${typeof stage.id === 'string' ? stage.id : '?'}.agent`;
    const lifted = liftBody(stage.agent, label, {
      layer: 'project',
      kind: 'role',
      mergedBody: isRecord(config) ? stage.agent : null,
      otherBody: null,
      clientIds,
    });
    if (lifted.note !== null) notes.push(lifted.note);
    return { ...stage, agent: lifted.body };
  });
  return { document: { ...workflow, stages }, notes };
}
