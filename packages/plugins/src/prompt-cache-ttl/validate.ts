import type { PluginValidationInput, PluginValidationProblem } from '@nodeint/migent-contracts';

import { DEFAULT_POLICY, isRecord, ON_EXPIRED_ACTIONS, parseDuration, selectPolicy } from './policy.js';

const POLICY_KEYS = new Set(['match', 'cache_ttl', 'margin', 'min_context_tokens', 'on_expired']);
const MATCH_KEYS = new Set(['client', 'model']);
const PREFIX = 'plugins.prompt_cache_ttl.policies';

type Report = (name: string, field: string, message: string) => void;

function checkMatch(name: string, policy: Record<string, unknown>, report: Report): void {
  if (policy.match === undefined || policy.match === null) return;
  const { match } = policy;
  if (!isRecord(match)) {
    report(name, 'match', 'must be a mapping.');
    return;
  }
  for (const key of Object.keys(match)) {
    if (!MATCH_KEYS.has(key)) report(name, `match.${key}`, 'is not used by Migent.');
  }
  const given = [match.client, match.model].filter((value) => value !== undefined && value !== null);
  if (given.length === 0) report(name, 'match', 'must set `client` or `model`.');
  if (given.some((value) => typeof value !== 'string' || value.trim() === '')) {
    report(name, 'match', 'values must be non-blank strings.');
  }
  if (name === DEFAULT_POLICY) report(name, 'match', 'is not allowed on the `default` policy.');
}

function checkDurations(name: string, policy: Record<string, unknown>, report: Report): void {
  const ttl = parseDuration(policy.cache_ttl);
  if (policy.cache_ttl === undefined || policy.cache_ttl === null) {
    report(name, 'cache_ttl', 'is required.');
  } else if (ttl === null || ttl === 0) {
    report(name, 'cache_ttl', 'must be a positive duration such as `5m`, `30s` or `1h`.');
  }
  const hasMargin = policy.margin !== undefined && policy.margin !== null;
  const margin = hasMargin ? parseDuration(policy.margin) : 0;
  if (margin === null) report(name, 'margin', 'must be a duration such as `30s`.');
  else if (ttl !== null && margin >= ttl) report(name, 'margin', 'must be shorter than `cache_ttl`.');
}

function checkValues(name: string, policy: Record<string, unknown>, report: Report): void {
  const tokens = policy.min_context_tokens;
  if (tokens !== undefined && tokens !== null && !(Number.isInteger(tokens) && (tokens as number) >= 0)) {
    report(name, 'min_context_tokens', 'must be a whole number of at least 0.');
  }
  const action = policy.on_expired;
  if (action !== undefined && action !== null && !(ON_EXPIRED_ACTIONS as readonly unknown[]).includes(action)) {
    report(name, 'on_expired', `must be one of ${ON_EXPIRED_ACTIONS.join(', ')}.`);
  }
}

/** The problems of the `policies` mapping; empty when valid or absent. */
function policyProblems(policies: unknown): PluginValidationProblem[] {
  if (policies === undefined || policies === null) return [];
  if (!isRecord(policies)) return [{ path: PREFIX, message: `${PREFIX} must be a mapping.` }];
  const problems: PluginValidationProblem[] = [];
  const report: Report = (name, field, message) => {
    problems.push({ path: `${PREFIX}.${name}.${field}`, message: `${PREFIX}.${name}.${field} ${message}` });
  };
  for (const [name, policy] of Object.entries(policies)) {
    if (!isRecord(policy)) {
      problems.push({ path: `${PREFIX}.${name}`, message: `${PREFIX}.${name} must be a mapping.` });
      continue;
    }
    for (const key of Object.keys(policy)) {
      if (!POLICY_KEYS.has(key)) report(name, key, 'is not used by Migent.');
    }
    checkMatch(name, policy, report);
    checkDurations(name, policy, report);
    checkValues(name, policy, report);
  }
  return problems;
}

function selectionFailure(
  options: Readonly<Record<string, unknown>>,
  agent: PluginValidationInput['agents'][number],
): PluginValidationProblem | null {
  const own = agent.extensions.prompt_cache_ttl;
  const named = isRecord(own) && typeof own.policy === 'string' && own.policy.trim() !== '' ? own.policy : null;
  try {
    selectPolicy(isRecord(options.policies) ? options.policies : undefined, {
      agentPolicy: named, client: agent.client ?? '', model: agent.model ?? '',
    });
    return null;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return { path: named === null ? agent.path : `${agent.path}.prompt_cache_ttl.policy`, message: `${agent.path}: ${message}` };
  }
}

/** Pure: the policy mapping checks, an unknown policy name even without `policies`, and an agent matching several. */
export function validatePolicies(input: PluginValidationInput): readonly PluginValidationProblem[] {
  const problems = policyProblems(input.options.policies);
  if (problems.length > 0) return problems;
  return input.agents.flatMap((agent) => {
    const failure = selectionFailure(input.options, agent);
    return failure === null ? [] : [failure];
  });
}
