import type { ClientRegistry } from '@nodeint/migent-kernel';
import { type SessionStore } from '@nodeint/migent-session';

import { gateResume, type GateVerdict } from './resume-gate.js';
import type { InterceptorChain } from './runtime/interception.js';

export interface RoleGateRequest {
  readonly store: SessionStore;
  readonly workspace: string;
  readonly sessionId: string;
  readonly role: string;
  /** The execution whose conversation would be resumed. */
  readonly sourceExecutionId: string;
  readonly clients: ClientRegistry;
  /** The frozen client and model of the role session. */
  readonly target: { readonly client: string; readonly model: string };
  /** The host's interceptors; the role gate runs with none unless the caller supplies them. */
  readonly interceptors?: InterceptorChain | undefined;
}

/** The gate for a role session, before `runner.run`. The target stage of a role session is its role. */
export async function gateRoleResume(request: RoleGateRequest): Promise<{ verdict: GateVerdict }> {
  const { store, workspace, sessionId, role, sourceExecutionId, clients } = request;
  const { verdict } = await gateResume({
    store, workspace, sessionId, stageId: role, sourceExecutionId, clients,
    path: 'role', target: request.target, interceptors: request.interceptors,
  });
  return { verdict };
}
