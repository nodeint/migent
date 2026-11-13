import { isRecord } from '@nodeint/migent-workflow';
import { type StageAgent } from '@nodeint/migent-workflow';

import { ConfigurationError } from './errors.js';

/** What a resume does when the prompt cache may have expired. */
export type OnExpired = 'ask' | 'fresh' | 'resume';

export const ON_EXPIRED_ACTIONS: readonly OnExpired[] = ['ask', 'fresh', 'resume'];

/** The name of the policy that applies when no explicit name and no `match` selects one. */
export const DEFAULT_RESUME_POLICY = 'default';

const SECONDS_PER_UNIT = { s: 1, m: 60, h: 3600 } as const;
const MS_PER_SECOND = 1000;
const DURATION = /^(\d+)(s|m|h)$/;
const POLICY_KEYS = new Set(['match', 'cache_ttl', 'margin', 'min_context_tokens', 'on_expired']);
const MATCH_KEYS = new Set(['client', 'model']);

/** A duration such as `30s`, `5m` or `1h`, in seconds; null when the text is not one. */
export function parseDuration(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const found = DURATION.exec(text);
  if (found === null) return null;
  return Number(found[1]) * SECONDS_PER_UNIT[found[2] as keyof typeof SECONDS_PER_UNIT];
}

export interface ResolvedResumePolicy {
  name: string;
  cacheTtlSec: number;
  marginSec: number;
  minContextTokens: number;
  /** Null when the policy does not say; the caller falls back to `ask`. */
  onExpired: OnExpired | null;
  match: { client?: string; model?: string } | null;
}

function problem(name: string, field: string, message: string): ConfigurationError {
  return new ConfigurationError(`resume_policies.${name}.${field} ${message}`);
}

function checkKeys(name: string, policy: Record<string, unknown>, errors: ConfigurationError[]): void {
  for (const key of Object.keys(policy)) {
    if (!POLICY_KEYS.has(key)) errors.push(problem(name, key, 'is not used by Migent.'));
  }
}

function checkMatch(name: string, policy: Record<string, unknown>, errors: ConfigurationError[]): void {
  if (policy.match === undefined || policy.match === null) return;
  const { match } = policy;
  if (!isRecord(match)) {
    errors.push(problem(name, 'match', 'must be a mapping.'));
    return;
  }
  for (const key of Object.keys(match)) {
    if (!MATCH_KEYS.has(key)) errors.push(problem(name, `match.${key}`, 'is not used by Migent.'));
  }
  const values = [match.client, match.model];
  const given = values.filter((value) => value !== undefined && value !== null);
  if (given.length === 0) errors.push(problem(name, 'match', 'must set `client` or `model`.'));
  if (given.some((value) => typeof value !== 'string' || value.trim() === '')) {
    errors.push(problem(name, 'match', 'values must be non-blank strings.'));
  }
  if (name === DEFAULT_RESUME_POLICY) errors.push(problem(name, 'match', 'is not allowed on the `default` policy.'));
}

function checkDurations(name: string, policy: Record<string, unknown>, errors: ConfigurationError[]): void {
  const ttl = parseDuration(policy.cache_ttl);
  if (policy.cache_ttl === undefined || policy.cache_ttl === null) {
    errors.push(problem(name, 'cache_ttl', 'is required.'));
  } else if (ttl === null || ttl === 0) {
    errors.push(problem(name, 'cache_ttl', 'must be a positive duration such as `5m`, `30s` or `1h`.'));
  }
  const hasMargin = policy.margin !== undefined && policy.margin !== null;
  const margin = hasMargin ? parseDuration(policy.margin) : 0;
  if (margin === null) errors.push(problem(name, 'margin', 'must be a duration such as `30s`.'));
  else if (ttl !== null && margin >= ttl) errors.push(problem(name, 'margin', 'must be shorter than `cache_ttl`.'));
}

function checkValues(name: string, policy: Record<string, unknown>, errors: ConfigurationError[]): void {
  const tokens = policy.min_context_tokens;
  if (tokens !== undefined && tokens !== null && !(Number.isInteger(tokens) && (tokens as number) >= 0)) {
    errors.push(problem(name, 'min_context_tokens', 'must be a whole number of at least 0.'));
  }
  const action = policy.on_expired;
  if (action !== undefined && action !== null && !(ON_EXPIRED_ACTIONS as readonly unknown[]).includes(action)) {
    errors.push(problem(name, 'on_expired', `must be one of ${ON_EXPIRED_ACTIONS.join(', ')}.`));
  }
}

/** Every problem of the `resume_policies` mapping of an effective config; empty when it is valid or absent. */
export function validateResumePolicies(config: Record<string, unknown>): ConfigurationError[] {
  const policies = config.resume_policies;
  if (policies === undefined || policies === null) return [];
  if (!isRecord(policies)) return [new ConfigurationError('resume_policies must be a mapping.')];
  const errors: ConfigurationError[] = [];
  for (const [name, policy] of Object.entries(policies)) {
    if (!isRecord(policy)) {
      errors.push(new ConfigurationError(`resume_policies.${name} must be a mapping.`));
      continue;
    }
    checkKeys(name, policy, errors);
    checkMatch(name, policy, errors);
    checkDurations(name, policy, errors);
    checkValues(name, policy, errors);
  }
  return errors;
}

function isOnExpired(value: unknown): value is OnExpired {
  return (ON_EXPIRED_ACTIONS as readonly unknown[]).includes(value);
}

function resolve(name: string, policy: Record<string, unknown>): ResolvedResumePolicy {
  const cacheTtlSec = parseDuration(policy.cache_ttl);
  if (cacheTtlSec === null) throw new ConfigurationError(`resume_policies.${name}.cache_ttl is not a valid duration.`);
  const marginSec = policy.margin === undefined || policy.margin === null ? 0 : (parseDuration(policy.margin) ?? 0);
  const match = isRecord(policy.match)
    ? {
        ...(typeof policy.match.client === 'string' ? { client: policy.match.client } : {}),
        ...(typeof policy.match.model === 'string' ? { model: policy.match.model } : {}),
      }
    : null;
  return {
    name,
    cacheTtlSec,
    marginSec,
    minContextTokens: typeof policy.min_context_tokens === 'number' ? policy.min_context_tokens : 0,
    onExpired: isOnExpired(policy.on_expired) ? policy.on_expired : null,
    match,
  };
}

const GLOB_WILDCARDS: Record<string, string> = { '*': '.*', '?': '.' };

function globChar(char: string): string {
  return GLOB_WILDCARDS[char] ?? char.replace(/[$()+.[\\\]^{|}]/g, '\\$&');
}

/** `*` matches any run of characters and `?` one character; everything else is literal. */
export function globMatches(pattern: string, value: string): boolean {
  const source = [...pattern].map(globChar).join('');
  return new RegExp(`^${source}$`, 'i').test(value);
}

function policyMatches(policy: ResolvedResumePolicy, client: string, model: string): boolean {
  const { match } = policy;
  if (match === null) return false;
  if (match.client !== undefined && match.client.toLowerCase() !== client.toLowerCase()) return false;
  return match.model === undefined || globMatches(match.model, model);
}

export interface PolicySelection {
  /** The agent's explicit `resume_policy` name, when it has one. */
  agentPolicy?: string | null;
  client: string;
  model: string;
}

/**
 * The policy that applies to an agent: the explicit name, then the single policy whose `match` fits the
 * client and model, then `default`. Null when there are no policies or none applies. An unknown name or
 * several matches is a configuration error.
 */
export function selectResumePolicy(
  policies: Record<string, unknown> | null | undefined,
  selection: PolicySelection,
): ResolvedResumePolicy | null {
  const table: Record<string, unknown> = isRecord(policies) ? policies : {};
  const named = (name: string): ResolvedResumePolicy => {
    const entry = table[name];
    if (!isRecord(entry)) throw new ConfigurationError(`Unknown resume policy: ${name}`);
    return resolve(name, entry);
  };
  if (selection.agentPolicy !== undefined && selection.agentPolicy !== null) return named(selection.agentPolicy);
  const matched = Object.keys(table)
    .filter((name) => name !== DEFAULT_RESUME_POLICY && isRecord(table[name]))
    .map(named)
    .filter((policy) => policyMatches(policy, selection.client, selection.model));
  if (matched.length > 1) {
    const names = matched.map((policy) => policy.name).join(', ');
    throw new ConfigurationError(`Several resume policies match ${selection.client}/${selection.model}: ${names}. Name one with the agent's \`resume_policy\`.`);
  }
  if (matched[0] !== undefined) return matched[0];
  return isRecord(table[DEFAULT_RESUME_POLICY]) ? named(DEFAULT_RESUME_POLICY) : null;
}

export interface ResumeFacts {
  /** ISO timestamp the source execution ended; null when unknown. */
  completedAt: string | null;
  now: Date;
  /** Tokens in the last captured context; null when the client reported none. */
  contextTokens: number | null;
}

export interface ResumeEstimate {
  idleSec: number | null;
  contextTokens: number | null;
  /** `cache_ttl - margin`, the idle time from which the cache is treated as expired. */
  thresholdSec: number;
}

export interface ResumeEvaluation {
  expired: boolean;
  estimate: ResumeEstimate;
}

/**
 * Whether the prompt cache is treated as expired. Idle time is clamped at zero. A source with no
 * `completed_at` is never expired. A context under `min_context_tokens` is not worth guarding; an
 * unknown context is guarded.
 */
export function evaluateResume(policy: ResolvedResumePolicy, facts: ResumeFacts): ResumeEvaluation {
  const thresholdSec = policy.cacheTtlSec - policy.marginSec;
  const completed = facts.completedAt === null ? Number.NaN : Date.parse(facts.completedAt);
  const idleMs = facts.now.getTime() - completed;
  const idleSec = Number.isNaN(completed) ? null : Math.max(0, Math.floor(idleMs / MS_PER_SECOND));
  const estimate: ResumeEstimate = { idleSec, contextTokens: facts.contextTokens, thresholdSec };
  if (idleSec === null || idleSec < thresholdSec) return { expired: false, estimate };
  const small = facts.contextTokens !== null && facts.contextTokens < policy.minContextTokens;
  return { expired: !small, estimate };
}

export type OnExpiredOrigin = 'human' | 'stage' | 'policy' | 'default';

export interface OnExpiredInput {
  /** A human decision for this `(stage, source)`; `superseded` decisions are not a choice. */
  decision?: 'resume' | 'fresh' | null;
  stageOnExpired?: OnExpired | null;
  policy?: ResolvedResumePolicy | null;
}

/** The action for an expired resume: a human decision, then the stage, then the policy, then `ask`. */
export function effectiveOnExpired(input: OnExpiredInput): { action: OnExpired; origin: OnExpiredOrigin } {
  if (input.decision !== undefined && input.decision !== null) return { action: input.decision, origin: 'human' };
  if (input.stageOnExpired !== undefined && input.stageOnExpired !== null) return { action: input.stageOnExpired, origin: 'stage' };
  if (input.policy?.onExpired !== undefined && input.policy.onExpired !== null) return { action: input.policy.onExpired, origin: 'policy' };
  return { action: 'ask', origin: 'default' };
}

/**
 * The `resume_policy` name of the agent a role cascade selects: the stage's agent, else the role's.
 * Null when the agent sets none. An unknown agent is reported by the cascade itself, not here.
 */
export function agentResumePolicyName(
  config: Record<string, unknown>,
  roleKey: string,
  stageAgent: StageAgent | null = null,
): string | null {
  const role = isRecord(config.roles) ? config.roles[roleKey] : undefined;
  let selection: unknown = isRecord(role) ? role.agent : undefined;
  if (stageAgent !== null) selection = stageAgent.kind === 'named' ? stageAgent.name : stageAgent.value;
  let definition: unknown = selection;
  if (typeof selection === 'string') definition = isRecord(config.agents) ? config.agents[selection] : undefined;
  const name = isRecord(definition) ? definition.resume_policy : undefined;
  return typeof name === 'string' && name.trim() !== '' ? name : null;
}
