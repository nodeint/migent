import type {
  CliClient,
  ClientOption,
  FailureClassification,
  NewSession,
  TurnUsage,
  UsageCapture,
} from './cli-client.js';

/** The options Migent persists in a session: the client's overridable options only. */
export function sessionOptions(
  client: Pick<CliClient, 'options'>,
  options: Readonly<Record<string, string>>,
): Record<string, string> {
  const names = new Set(
    optionsFor(client)
      .filter((item) => item.overridable)
      .map((item) => item.name),
  );
  const profile: Record<string, string> = {};
  for (const [key, value] of Object.entries(options)) {
    if (names.has(key)) profile[key] = value;
  }
  return profile;
}

function optionsFor(client: Pick<CliClient, 'options'>): readonly ClientOption[] {
  return client.options();
}

/**
 * Map one finished process to Migent's failure vocabulary. `null` means the
 * process is not a failure. Messages and origins are unchanged from the
 * historical provider policy.
 */
export function classifyFailure(
  client: Pick<CliClient, 'extractFailure'>,
  stdout: string,
  exitCode: number,
): FailureClassification | null {
  const raw = client.extractFailure(stdout, exitCode);
  if (raw === null) return null;
  if (raw.rateLimit !== undefined) {
    return {
      kind: 'quota',
      origin: raw.origin,
      message: raw.message || 'quota',
      resetAt: raw.rateLimit.resetAt,
      window: raw.rateLimit.window,
    };
  }
  return { kind: 'provider', origin: raw.origin, message: raw.message || `CLI exited with code ${exitCode}.` };
}

/** Running totals become this turn's share; per-turn figures pass through. */
export function normalizeUsage(
  client: Pick<CliClient, 'readUsage'>,
  current: UsageCapture,
  previous: UsageCapture | null,
): TurnUsage {
  const now = client.readUsage(current);
  const before = previous === null ? null : client.readUsage(previous);
  const usage = { ...now.values };
  for (const field of now.cumulative) {
    const value = now.values[field];
    const base = before === null ? 0 : before.values[field];
    if (value === null || base === null || value < base) usage[field] = null;
    else usage[field] = value - base;
  }
  return usage;
}

/** The fresh native identity a client accepts on its first run. */
export function createNewSession(client: Pick<CliClient, 'newSessionId'>): NewSession {
  const agentId = client.newSessionId?.() ?? null;
  return agentId === null ? {} : { agentId };
}
