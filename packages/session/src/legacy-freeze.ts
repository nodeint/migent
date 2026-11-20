import { type ExtensionValues,isRecord } from '@nodeint/migent-workflow';

/**
 * Read-only adapter for freezes written before the prompt cache policy became the `prompt_cache_ttl` plugin
 * (schema 7 and earlier, pre-#167). It translates, in memory, the three places the old freeze held policy data
 * and never writes: the file and its `plugins.frozen` hash stay as they were.
 *
 * Inputs: a top-level `resume_policies`, `targets.<stage>.resume_policy`, and the frozen workflow's stage
 * `session.on_expired` and inline agent `resume_policy`. A legacy freeze never also has a frozen
 * `plugins.prompt_cache_ttl` entry, because the plugin did not exist when it was written.
 *
 * Lifetime: kept until a separate, announced change drops support for schema 7 files and pre-#167 sessions.
 */

const PLUGIN = 'prompt_cache_ttl';

/** The plugin's view of one legacy freeze. */
export interface LegacyPolicyData {
  /** The options of the implicit plugin entry, by plugin id; empty when the freeze had no policies. */
  readonly options: Readonly<Record<string, Record<string, unknown>>>;
  /** Agent extension values per stage, owner then claimed key: `{ prompt_cache_ttl: { prompt_cache_ttl: {...} } }`. */
  readonly targets: Readonly<Record<string, ExtensionValues>>;
  /** Stage extension values per stage: `{ prompt_cache_ttl: { prompt_cache_ttl: { on_expired } } }`. */
  readonly stages: Readonly<Record<string, ExtensionValues>>;
}

function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

/** A copy of `workflow` without the legacy stage keys, so the current parser accepts it. */
function strippedWorkflow(workflow: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(workflow.stages)) return workflow;
  const stages = workflow.stages.map((stage: unknown) => {
    if (!isRecord(stage)) return stage;
    let result = stage;
    if (isRecord(result.agent) && Object.hasOwn(result.agent, 'resume_policy')) {
      result = { ...result, agent: without(result.agent, 'resume_policy') };
    }
    if (isRecord(result.session) && Object.hasOwn(result.session, 'on_expired')) {
      const session = without(result.session, 'on_expired');
      const rest = without(result, 'session');
      result = Object.keys(session).length === 0 ? rest : { ...rest, session };
    }
    return result;
  });
  return { ...workflow, stages };
}

function stageActions(workflow: Record<string, unknown>): Record<string, ExtensionValues> {
  const found: Record<string, ExtensionValues> = {};
  for (const stage of Array.isArray(workflow.stages) ? workflow.stages : []) {
    if (!isRecord(stage) || typeof stage.id !== 'string' || !isRecord(stage.session)) continue;
    if (typeof stage.session.on_expired === 'string') found[stage.id.trim()] = { [PLUGIN]: { [PLUGIN]: { on_expired: stage.session.on_expired } } };
  }
  return found;
}

function targetNames(targets: unknown): Record<string, ExtensionValues> {
  const found: Record<string, ExtensionValues> = {};
  if (!isRecord(targets)) return found;
  for (const [stageId, raw] of Object.entries(targets)) {
    if (isRecord(raw) && typeof raw.resume_policy === 'string') found[stageId] = { [PLUGIN]: { [PLUGIN]: { policy: raw.resume_policy } } };
  }
  return found;
}

/** What a freeze document holds in the old shape, translated; `workflow` is the same document without the old keys. */
export function readLegacyFreeze(
  parsed: Record<string, unknown>,
): { workflow: Record<string, unknown>; legacy: LegacyPolicyData } {
  const workflow = isRecord(parsed.workflow) ? parsed.workflow : {};
  const saved = parsed.resume_policies;
  const policies = isRecord(saved) && Object.keys(saved).length > 0 ? saved : null;
  return {
    workflow: strippedWorkflow(workflow),
    legacy: {
      options: policies === null ? {} : { [PLUGIN]: { policies } },
      targets: targetNames(parsed.targets),
      stages: stageActions(workflow),
    },
  };
}

/**
 * The legacy stamp of a role session's execution: `resume_policy: { name, policies }` in `execution.json`.
 * Returns the implicit entry options and the role's agent value; `null` when the execution has no stamp.
 */
export function readLegacyRoleStamp(
  stamp: unknown,
): { options: Record<string, unknown>; agent: Record<string, Record<string, Record<string, unknown>>> } | null {
  if (!isRecord(stamp)) return null;
  const saved = stamp.policies;
  const policies = isRecord(saved) && Object.keys(saved).length > 0 ? saved : null;
  if (policies === null) return null;
  return {
    options: { policies },
    agent: { [PLUGIN]: { [PLUGIN]: typeof stamp.name === 'string' && stamp.name !== '' ? { policy: stamp.name } : {} } },
  };
}
