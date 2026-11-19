import { isRecord } from '@nodeint/migent-workflow';

import type { Lifted } from './migration-config.js';

/**
 * The schema_version 7 to 8 rewrite. The estimated prompt cache expiry feature became the first-party
 * `prompt_cache_ttl` plugin, so its legacy keys move to the plugin's keys within the layer that defines them:
 *
 * - config `resume_policies` becomes `plugins.prompt_cache_ttl.policies`
 * - an agent's `resume_policy: X` becomes `prompt_cache_ttl: { policy: X }`
 * - a workflow stage's `session.on_expired: A` becomes `prompt_cache_ttl: { on_expired: A }`
 *
 * The new key wins when both exist (design D13), and every dropped value is reported. This module and the
 * read-only freeze adapters in `session` are the only places that still know the old keys.
 */

const PLUGIN = 'prompt_cache_ttl';

/** `resume_policy` of one agent body, moved to `prompt_cache_ttl.policy`. */
function liftAgent(body: Record<string, unknown>, label: string, notes: string[]): Record<string, unknown> {
  if (!Object.hasOwn(body, 'resume_policy')) return body;
  const { resume_policy: legacy, ...rest } = body;
  const current = isRecord(rest[PLUGIN]) ? rest[PLUGIN] : {};
  if (Object.hasOwn(current, 'policy')) {
    notes.push(`${label}.resume_policy ${JSON.stringify(legacy)} dropped: ${label}.${PLUGIN}.policy ${JSON.stringify(current.policy)} wins`);
    return rest;
  }
  notes.push(`${label}.resume_policy -> ${label}.${PLUGIN}.policy`);
  return { ...rest, [PLUGIN]: { ...current, policy: legacy } };
}

function liftPolicies(document: Record<string, unknown>, notes: string[]): Record<string, unknown> {
  if (!Object.hasOwn(document, 'resume_policies')) return document;
  const { resume_policies: legacy, ...rest } = document;
  const plugins = isRecord(rest.plugins) ? rest.plugins : {};
  const entry = isRecord(plugins[PLUGIN]) ? plugins[PLUGIN] : {};
  const existing = isRecord(entry.policies) ? entry.policies : {};
  if (!isRecord(legacy)) {
    notes.push(`resume_policies -> plugins.${PLUGIN}.policies`);
    return { ...rest, plugins: { ...plugins, [PLUGIN]: { ...entry, policies: legacy } } };
  }
  const policies: Record<string, unknown> = { ...existing };
  for (const [name, policy] of Object.entries(legacy)) {
    if (Object.hasOwn(existing, name)) {
      notes.push(`resume_policies.${name} ${JSON.stringify(policy)} dropped: plugins.${PLUGIN}.policies.${name} ${JSON.stringify(existing[name])} wins`);
    } else {
      policies[name] = policy;
    }
  }
  notes.push(`resume_policies -> plugins.${PLUGIN}.policies`);
  return { ...rest, plugins: { ...plugins, [PLUGIN]: { ...entry, policies } } };
}

function mapValues(
  record: unknown,
  change: (name: string, value: Record<string, unknown>) => Record<string, unknown>,
): unknown {
  if (!isRecord(record)) return record;
  return Object.fromEntries(
    Object.entries(record).map(([name, value]) => [name, isRecord(value) ? change(name, value) : value]),
  );
}

/** Config layer: `resume_policies`, named agents, and inline role agents. */
export function liftConfigCacheTtl(config: Readonly<Record<string, unknown>>): Lifted {
  const notes: string[] = [];
  let document: Record<string, unknown> = { ...config };
  if (Object.hasOwn(document, 'agents')) {
    document.agents = mapValues(document.agents, (name, body) => liftAgent(body, `agents.${name}`, notes));
  }
  if (Object.hasOwn(document, 'roles')) {
    document.roles = mapValues(document.roles, (name, role) => {
      if (!isRecord(role.agent)) return role;
      return { ...role, agent: liftAgent(role.agent, `roles.${name}.agent`, notes) };
    });
  }
  document = liftPolicies(document, notes);
  return { document, notes };
}

/** The stage with `session` replaced, or without it when nothing is left. */
function replaceSession(stage: Record<string, unknown>, session: Record<string, unknown>): Record<string, unknown> {
  const rest = Object.fromEntries(Object.entries(stage).filter(([key]) => key !== 'session'));
  return Object.keys(session).length === 0 ? rest : { ...rest, session };
}

function liftStage(stage: Record<string, unknown>, notes: string[]): Record<string, unknown> {
  const label = `stages.${typeof stage.id === 'string' ? stage.id : '?'}`;
  let result = stage;
  if (isRecord(result.agent)) result = { ...result, agent: liftAgent(result.agent, `${label}.agent`, notes) };
  if (!isRecord(result.session) || !Object.hasOwn(result.session, 'on_expired')) return result;
  const { on_expired: legacy, ...session } = result.session;
  const current = isRecord(result[PLUGIN]) ? result[PLUGIN] : {};
  const withSession = replaceSession(result, session);
  if (Object.hasOwn(current, 'on_expired')) {
    notes.push(`${label}.session.on_expired ${JSON.stringify(legacy)} dropped: ${label}.${PLUGIN}.on_expired ${JSON.stringify(current.on_expired)} wins`);
    return withSession;
  }
  notes.push(`${label}.session.on_expired -> ${label}.${PLUGIN}.on_expired`);
  return { ...withSession, [PLUGIN]: { ...current, on_expired: legacy } };
}

/** Workflow: each stage's `session.on_expired` and its inline agent's `resume_policy`. */
export function liftWorkflowCacheTtl(workflow: Readonly<Record<string, unknown>>): Lifted {
  if (!Array.isArray(workflow.stages)) return { document: { ...workflow }, notes: [] };
  const notes: string[] = [];
  const stages = workflow.stages.map((stage: unknown) => (isRecord(stage) ? liftStage(stage, notes) : stage));
  return { document: { ...workflow, stages }, notes };
}
