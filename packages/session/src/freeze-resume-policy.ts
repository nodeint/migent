import type { ModelOverride, ResolvedResumePolicy, StageTarget } from '@nodeint/migent-kernel';
import { agentResumePolicyName, selectResumePolicy, validateResumePolicies } from '@nodeint/migent-kernel';
import { isRecord, type RoleStageSpec } from '@nodeint/migent-workflow';

import type { WorkflowFreeze } from './session-freeze.js';

/** The config's `resume_policies`, validated; null when it has none. An invalid set is refused. */
export function frozenPolicyMap(config: Record<string, unknown>): Record<string, unknown> | null {
  const [problem] = validateResumePolicies(config);
  if (problem !== undefined) throw problem;
  return isRecord(config.resume_policies) ? config.resume_policies : null;
}

/** The name of the policy a stage selects at creation, or null when none applies. */
export function freezeStagePolicy(
  config: Record<string, unknown>,
  stage: RoleStageSpec,
  target: StageTarget,
): string | null {
  const agentPolicy = agentResumePolicyName(config, stage.role, stage.agent);
  const policies = isRecord(config.resume_policies) ? config.resume_policies : null;
  return selectResumePolicy(policies, { agentPolicy, client: target.client, model: target.model })?.name ?? null;
}

/**
 * The policy a stage runs under. Without an override it is the one selected at creation. A
 * `--client/--model` override selects again from the frozen map by `match`, then `default`; a config
 * edit after creation never applies. Null when no policy applies.
 */
export function frozenResumePolicy(
  freeze: Pick<WorkflowFreeze, 'resumePolicies' | 'resumePolicyNames'>,
  stageId: string,
  override?: ModelOverride,
): ResolvedResumePolicy | null {
  const client = override?.client ?? null;
  const model = override?.model ?? null;
  if (client !== null && model !== null) return selectResumePolicy(freeze.resumePolicies, { client, model });
  const name = freeze.resumePolicyNames[stageId] ?? null;
  if (name === null) return null;
  return selectResumePolicy(freeze.resumePolicies, { agentPolicy: name, client: '', model: '' });
}

/** `targets.<stage>.resume_policy`; an old freeze, or a stage without one, reads as null. */
export function readResumePolicyNames(targets: unknown): Record<string, string | null> {
  const names: Record<string, string | null> = {};
  if (!isRecord(targets)) return names;
  for (const [stageId, raw] of Object.entries(targets)) {
    if (isRecord(raw) && typeof raw.resume_policy === 'string') names[stageId] = raw.resume_policy;
  }
  return names;
}
