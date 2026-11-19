import {
  type Plugin, PLUGIN_EXTENSIONS,
type PluginBeforeProposal, type PluginCallContext, type PluginManifest, } from '@nodeint/migent-contracts';

import { chooseAction, evaluateExpiry, isRecord, ON_EXPIRED_ACTIONS, type OnExpired, selectPolicy } from './policy.js';
import { validatePolicies } from './validate.js';

const PROMPT_CACHE_TTL_PLUGIN_ID = 'prompt_cache_ttl';
const CONVERSATION_RESUME = 'conversation.resume';

const DURATION = { type: 'string', pattern: String.raw`^\d+(s|m|h)$` };

const POLICY_SCHEMA = {
  type: 'object',
  properties: {
    match: {
      type: 'object',
      properties: { client: { type: 'string' }, model: { type: 'string' } },
      additionalProperties: true,
    },
    cache_ttl: DURATION,
    margin: DURATION,
    min_context_tokens: { type: 'integer', minimum: 0 },
    on_expired: { enum: [...ON_EXPIRED_ACTIONS] },
  },
  required: ['cache_ttl'],
  additionalProperties: true,
};

/** The structure of `policies`; cross-field and selection rules live in the pure `validate`. */
const CONFIG_SCHEMA: PluginManifest['configSchema'] = {
  type: 'object',
  properties: { policies: { type: 'object', additionalProperties: POLICY_SCHEMA } },
  additionalProperties: true,
};

const promptCacheTtlManifest: PluginManifest = {
  id: PROMPT_CACHE_TTL_PLUGIN_ID,
  version: '1.0.0',
  apiVersion: { major: 1, minor: 1 },
  advisory: false,
  defaultEnabled: true,
  uses: {
    operations: [{ target: CONVERSATION_RESUME, phases: ['before'] }],
    events: [],
    session: ['resume_facts'],
    artifacts: [],
    agents: false,
    config: [],
  },
  configSchema: CONFIG_SCHEMA,
  defaults: { on_error: 'ignore' },
  extensions: PLUGIN_EXTENSIONS.find((entry) => entry.plugin === PROMPT_CACHE_TTL_PLUGIN_ID),
};

const RESUME: PluginBeforeProposal = { kind: 'short_circuit', output: { verdict: 'resume', expired: null } };

function ownValue(values: Readonly<Record<string, unknown>> | null, key: string): unknown {
  const own = values?.[PROMPT_CACHE_TTL_PLUGIN_ID];
  return isRecord(own) ? own[key] : undefined;
}

/** The verdict of one `conversation.resume` request. No applicable policy, or a live cache, resumes. */
function decide(policies: Record<string, unknown>) {
  return async (request: Readonly<Record<string, unknown>>, call: PluginCallContext): Promise<PluginBeforeProposal> => {
    const stageId = String(request.stage_id);
    const selector = ownValue(call.config.extensions.agent(stageId), 'policy');
    const policy = selectPolicy(policies, {
      agentPolicy: typeof selector === 'string' && selector.trim() !== '' ? selector : null,
      client: String(request.client), model: String(request.model),
    });
    if (policy === null) return RESUME;
    const facts = await call.session.resumeFacts(String(request.source_execution_id));
    const result = evaluateExpiry(policy, facts, new Date());
    if (!result.expired) return RESUME;
    const override = ownValue(call.config.extensions.stage(stageId), 'on_expired');
    const stage = (ON_EXPIRED_ACTIONS as readonly unknown[]).includes(override) ? (override as OnExpired) : null;
    const { action, origin } = chooseAction(stage, policy);
    return {
      kind: 'short_circuit',
      output: {
        verdict: action,
        expired: {
          action, origin, policy: policy.name,
          estimate: { ...result.estimate, cacheTtlSec: policy.cacheTtlSec, marginSec: policy.marginSec },
        },
      },
    };
  };
}

export const promptCacheTtlPlugin: Plugin = {
  manifest: promptCacheTtlManifest,
  validate: validatePolicies,
  activate: (options, migent) => {
    const { policies } = options;
    if (!isRecord(policies) || Object.keys(policies).length === 0) return;
    migent.operations.intercept(CONVERSATION_RESUME, { before: decide(policies) });
  },
};
