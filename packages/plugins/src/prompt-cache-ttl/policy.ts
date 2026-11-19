import type { PluginResumeFacts } from '@nodeint/migent-contracts';

/** What an expired resume does: `ask` stops for a human, `fresh` starts anew, `resume` resumes anyway. */
export type OnExpired = 'ask' | 'fresh' | 'resume';

export const ON_EXPIRED_ACTIONS: readonly OnExpired[] = ['ask', 'fresh', 'resume'];

/** The policy that applies when no explicit name and no `match` selects one. */
export const DEFAULT_POLICY = 'default';

const SECONDS_PER_UNIT = { s: 1, m: 60, h: 3600 } as const;
const MS_PER_SECOND = 1000;
const DURATION = /^(\d+)(s|m|h)$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A duration such as `30s`, `5m` or `1h`, in seconds; null when the text is not one. */
export function parseDuration(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const found = DURATION.exec(text);
  if (found === null) return null;
  return Number(found[1]) * SECONDS_PER_UNIT[found[2] as keyof typeof SECONDS_PER_UNIT];
}

export interface ResolvedPolicy {
  readonly name: string;
  readonly cacheTtlSec: number;
  readonly marginSec: number;
  readonly minContextTokens: number;
  /** Null when the policy does not say; the caller falls back to `ask`. */
  readonly onExpired: OnExpired | null;
  readonly match: { readonly client?: string; readonly model?: string } | null;
}

function isOnExpired(value: unknown): value is OnExpired {
  return (ON_EXPIRED_ACTIONS as readonly unknown[]).includes(value);
}

function resolve(name: string, policy: Record<string, unknown>): ResolvedPolicy {
  const cacheTtlSec = parseDuration(policy.cache_ttl);
  if (cacheTtlSec === null) throw new Error(`plugins.prompt_cache_ttl.policies.${name}.cache_ttl is not a valid duration.`);
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
  return GLOB_WILDCARDS[char] ?? char.replace(/[$()+.[\\\]^{|}]/g, String.raw`\$&`);
}

/** `*` matches any run of characters and `?` one character; everything else is literal. */
function globMatches(pattern: string, value: string): boolean {
  const source = [...pattern].map(globChar).join('');
  return new RegExp(`^${source}$`, 'i').test(value);
}

function policyMatches(policy: ResolvedPolicy, client: string, model: string): boolean {
  const { match } = policy;
  if (match === null) return false;
  if (match.client !== undefined && match.client.toLowerCase() !== client.toLowerCase()) return false;
  return match.model === undefined || globMatches(match.model, model);
}

export interface PolicySelection {
  /** The agent's explicit policy name, when it has one. */
  readonly agentPolicy?: string | null;
  readonly client: string;
  readonly model: string;
}

/**
 * The policy that applies to an agent: the explicit name, then the single policy whose `match` fits the
 * client and model, then `default`. Null when there are no policies or none applies. An unknown name or
 * several matches throws.
 */
export function selectPolicy(
  policies: Record<string, unknown> | null | undefined,
  selection: PolicySelection,
): ResolvedPolicy | null {
  const table: Record<string, unknown> = isRecord(policies) ? policies : {};
  const named = (name: string): ResolvedPolicy => {
    const entry = table[name];
    if (!isRecord(entry)) throw new Error(`Unknown resume policy: ${name}`);
    return resolve(name, entry);
  };
  if (selection.agentPolicy !== undefined && selection.agentPolicy !== null) return named(selection.agentPolicy);
  const matched = Object.keys(table)
    .filter((name) => name !== DEFAULT_POLICY && isRecord(table[name]))
    .map(named)
    .filter((policy) => policyMatches(policy, selection.client, selection.model));
  if (matched.length > 1) {
    const names = matched.map((policy) => policy.name).join(', ');
    throw new Error(`Several resume policies match ${selection.client}/${selection.model}: ${names}. Name one with the agent's \`prompt_cache_ttl.policy\`.`);
  }
  if (matched[0] !== undefined) return matched[0];
  return isRecord(table[DEFAULT_POLICY]) ? named(DEFAULT_POLICY) : null;
}

export interface Estimate {
  readonly idleSec: number | null;
  readonly contextTokens: number | null;
  /** `cache_ttl - margin`, the idle time from which the cache is treated as expired. */
  readonly thresholdSec: number;
}

/**
 * Whether the prompt cache is treated as expired. Idle time is clamped at zero. A source with no known
 * activity time is never expired. A context under `min_context_tokens` is not worth guarding; an unknown
 * context is guarded.
 */
export function evaluateExpiry(
  policy: ResolvedPolicy,
  facts: PluginResumeFacts,
  now: Date,
): { readonly expired: boolean; readonly estimate: Estimate } {
  const thresholdSec = policy.cacheTtlSec - policy.marginSec;
  const lastActivity = facts.lastActivityAt ?? facts.completedAt;
  const completed = lastActivity === null ? Number.NaN : Date.parse(lastActivity);
  const idleSec = Number.isNaN(completed) ? null : Math.max(0, Math.floor((now.getTime() - completed) / MS_PER_SECOND));
  const estimate: Estimate = { idleSec, contextTokens: facts.contextTokens, thresholdSec };
  if (idleSec === null || idleSec < thresholdSec) return { expired: false, estimate };
  const small = facts.contextTokens !== null && facts.contextTokens < policy.minContextTokens;
  return { expired: !small, estimate };
}

/** The action for an expired resume: the stage, then the policy, then `ask`. */
export function chooseAction(
  stageOnExpired: OnExpired | null,
  policy: ResolvedPolicy,
): { readonly action: OnExpired; readonly origin: 'stage' | 'policy' | 'default' } {
  if (stageOnExpired !== null) return { action: stageOnExpired, origin: 'stage' };
  if (policy.onExpired !== null) return { action: policy.onExpired, origin: 'policy' };
  return { action: 'ask', origin: 'default' };
}
