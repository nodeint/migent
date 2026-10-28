import { ConfigurationError } from "./errors.js";
import type { CommandSpec } from "./command-executor.js";

/** Methods doctor and config resolution call. Migrations are out of scope. */
export interface ProviderInfo {
  readonly command: string;
  readonly effortOption?: string;
  validateOptions(options: Readonly<Record<string, string>>): void;
  /** True when the provider has no default CLI client and every model must name one. */
  readonly requiresClient?: boolean;
  /** The same provider driving another CLI client, named by its id. Throws on an unknown id. */
  withClient?(clientId: string): ProviderInfo;
}

/** Resolve the provider with its selected CLI client already bound. */
export type ProviderResolver = (providerId: string, clientId?: string) => ProviderInfo;

export function createProviderResolver(providers: Readonly<Record<string, ProviderInfo>>): ProviderResolver {
  return (providerId, clientId) => {
    const provider = Object.hasOwn(providers, providerId) ? providers[providerId] : undefined;
    if (provider === undefined) throw new ConfigurationError(`Unknown provider: ${providerId}.`);
    try {
      if (clientId === undefined) return provider;
      if (provider.withClient === undefined) throw new Error(`${providerId} cannot switch CLI client.`);
      return provider.withClient(clientId);
    } catch (error) {
      throw new ConfigurationError(error instanceof Error ? error.message : String(error));
    }
  };
}

export interface ProviderOption {
  name: string;
  prompt?: boolean;
  allowDefault?: boolean;
  overridable?: boolean;
}

export interface NewSession {
  agentId?: string | null;
  agentIdSource?: string | null;
}

export interface BuildCommandInput {
  model: string;
  workspace: string;
  prompt: string;
  agentId: string | null;
  newAgentId: string | null;
  promptFile: string;
  lastMessageFile: string;
  options: Readonly<Record<string, string>>;
}

/** Provider-shaped JSON selected from one process's stdout. Stored verbatim. */
export type UsageCapture = Record<string, unknown>;

export interface TurnUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
}

export interface QuotaClassification {
  kind: "quota";
  message: string;
  /** UTC ISO instant, or null when the provider did not name one. */
  resetAt: string | null;
  window: string | null;
}

export interface ProviderClassification {
  kind: "provider";
  message: string;
}

/** `null` means this finished process is not a provider failure. */
export type FailureClassification = QuotaClassification | ProviderClassification;

/** Provider CLI surface used by the workflow runner. Not the providers package. */
export interface Provider extends ProviderInfo {
  providerOptions?(): readonly ProviderOption[];
  profileOptions?(options: Readonly<Record<string, string>>): Record<string, string>;
  createNewSession?(): NewSession;
  buildCommand(input: BuildCommandInput): CommandSpec;
  parseResponse(stdout: string, lastMessageFile: string): [string, string | null];
  /** Classify one finished process. Absent means the runner uses its fallback. */
  classifyFailure?(stdout: string, exitCode: number): FailureClassification | null;
  parseProgressEvent?(line: string): Record<string, unknown> | null;
  captureUsage?(stdout: string): UsageCapture | null;
  normalizeUsage?(current: UsageCapture, previous: UsageCapture | null): TurnUsage;
  versionCommand?(): string[];
  parseVersion?(stdout: string): string | null;
}

const grokOptionNames = new Set([
  "reasoning-effort",
  "max_turns",
  "tools",
  "disallowed_tools",
  "permission_mode",
  "rules",
  "allow",
  "deny",
  "sandbox",
]);

export class CodexProvider implements Provider {
  readonly command = "codex";

  validateOptions(options: Readonly<Record<string, string>>): void {
    for (const [key, value] of Object.entries(options)) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key)) throw new Error(`${key} is not a codex option.`);
      if (value.trim() === "") throw new Error(`${key} is empty.`);
    }
  }

  providerOptions(): ProviderOption[] {
    return [{ name: "model_reasoning_effort", prompt: true, allowDefault: true, overridable: true }];
  }

  buildCommand(): CommandSpec {
    throw new Error("codex provider is not available in the kernel.");
  }

  parseResponse(): [string, string | null] {
    throw new Error("codex provider is not available in the kernel.");
  }
}

export class GrokProvider implements Provider {
  readonly command = "grok";

  validateOptions(options: Readonly<Record<string, string>>): void {
    for (const [key, value] of Object.entries(options)) {
      if (!grokOptionNames.has(key)) throw new Error(`${key} is not a grok option.`);
      if (value.trim() === "") throw new Error(`${key} is empty.`);
    }
  }

  providerOptions(): ProviderOption[] {
    return [
      { name: "reasoning-effort", prompt: true, allowDefault: true, overridable: true },
      { name: "max_turns" },
      { name: "tools" },
      { name: "disallowed_tools" },
      { name: "permission_mode" },
      { name: "rules" },
      { name: "allow" },
      { name: "deny" },
      { name: "sandbox" },
    ];
  }

  buildCommand(): CommandSpec {
    throw new Error("grok provider is not available in the kernel.");
  }

  parseResponse(): [string, string | null] {
    throw new Error("grok provider is not available in the kernel.");
  }
}

export function defaultProviders(): Record<string, Provider> {
  return { codex: new CodexProvider(), grok: new GrokProvider() };
}
