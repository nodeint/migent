import type { ClientRegistry } from '@nodeint/migent-kernel';
import { agentResumePolicyName, loadWorkspaceConfig, type OnExpired, type ResolvedResumePolicy, selectResumePolicy } from '@nodeint/migent-kernel';
import { type SessionStore } from '@nodeint/migent-session';
import { isRecord } from '@nodeint/migent-workflow';

import { gateResume, type GateVerdict } from './resume-gate.js';
import { readExecutionJson } from './run-facts.js';

/** The policy a role session was created with: its name and the map it was chosen from. */
export interface RolePolicy {
  name: string;
  policies: Record<string, unknown>;
}

/**
 * The policy a new role session selects: the role's agent `resume_policy`, then the single match for the resolved
 * client and model, then `default`. Null when the config has no policy that applies.
 */
export function selectRolePolicy(
  workspace: string,
  target: { role: string; client: string; model: string },
): RolePolicy | null {
  const config = loadWorkspaceConfig(workspace);
  const policies = isRecord(config.resume_policies) ? config.resume_policies : {};
  const agentPolicy = agentResumePolicyName(config, target.role);
  const picked = selectResumePolicy(policies, { agentPolicy, client: target.client, model: target.model });
  return picked === null ? null : { name: picked.name, policies };
}

/** The policy stamped on an execution, read back as a resolved policy; null for a session created without one. */
export function storedRolePolicy(directory: string): { stamp: RolePolicy; policy: ResolvedResumePolicy } | null {
  const stamp = readExecutionJson(directory)?.resume_policy;
  if (!isRecord(stamp) || typeof stamp.name !== 'string' || !isRecord(stamp.policies)) return null;
  const {policies} = stamp;
  const policy = selectResumePolicy(policies, { agentPolicy: stamp.name, client: '', model: '' });
  return policy === null ? null : { stamp: { name: stamp.name, policies }, policy };
}

export interface RoleGateRequest {
  readonly store: SessionStore;
  readonly workspace: string;
  readonly sessionId: string;
  readonly role: string;
  /** The execution whose conversation would be resumed. */
  readonly sourceExecutionId: string;
  readonly clients: ClientRegistry;
  readonly stageOnExpired?: OnExpired | null;
}

/** The gate for a role session, before `runner.run`. The target stage of a role session is its role. */
export function gateRoleResume(request: RoleGateRequest): { verdict: GateVerdict; stamp: RolePolicy | null } {
  const { store, workspace, sessionId, role, sourceExecutionId, clients } = request;
  const context = store.executionContext(sessionId, sourceExecutionId);
  const stored = context === null ? null : storedRolePolicy(context.directory);
  if (stored === null) return { verdict: 'resume', stamp: null };
  const { verdict } = gateResume({
    store, workspace, sessionId, stageId: role, sourceExecutionId,
    policy: stored.policy, stageOnExpired: request.stageOnExpired ?? null, clients,
  });
  return { verdict, stamp: stored.stamp };
}
