import type {
  Provider,
  BuildCommandInput,
  CliClient,
  FailureClassification,
  NewSession,
  ProviderOption,
  TurnUsage,
  UsageCapture,
} from "@nodeint/migent-kernel";
import type { CommandSpec } from "@nodeint/migent-kernel";
import { ModelCatalog } from "../catalog.js";
import { AgyClient } from "../clients/agy-client.js";
import { ClaudeCodeClient } from "../clients/claude-code-client.js";
import { CodexClient } from "../clients/codex-client.js";
import { GrokClient } from "../clients/grok-client.js";
import { isRecord } from "../clients/json.js";
import { OpencodeClient } from "../clients/opencode-client.js";

const clientFactories: Record<string, () => CliClient> = {
  agy: () => new AgyClient(),
  "claude-code": () => new ClaudeCodeClient(),
  codex: () => new CodexClient(),
  grok: () => new GrokClient(),
  opencode: () => new OpencodeClient(),
};

export function clientIds(): string[] {
  return Object.keys(clientFactories).sort();
}

export function createClient(clientId: string): CliClient {
  const factory = Object.hasOwn(clientFactories, clientId) ? clientFactories[clientId] : undefined;
  if (factory === undefined) {
    throw new Error(`Unknown CLI client: ${clientId}. Supported: ${clientIds().join(", ")}`);
  }
  return factory();
}

type MigrationBody = Record<string, unknown>;
export type Migration = (entry: MigrationBody) => void;

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Renames the generic `thinking` setting to the CLI's own option, never overwriting one already set. */
export function moveThinkingTo(option: string): Migration {
  return (body) => {
    const options = body.options;
    if ("options" in body && !isRecord(options)) return;
    if (isRecord(options) && "thinking" in options) {
      const value = options.thinking;
      if (nonempty(value)) {
        if (!nonempty(options[option])) options[option] = value.trim();
        delete options.thinking;
      }
    }
    const value = body.thinking;
    if (!nonempty(value)) return;
    let record = isRecord(body.options) ? body.options : null;
    if (record === null) {
      record = {};
      body.options = record;
    }
    if (!nonempty(record[option])) record[option] = value.trim();
    delete body.thinking;
  };
}

/**
 * What every provider shares: delegate to the CLI client, then apply migent's
 * own policy (usage deltas, failure kinds, defaults). A subclass adds only its
 * policy; anything that reads the CLI's output belongs in the client.
 */
export abstract class ProviderBase implements Provider {
  abstract readonly displayName: string;
  protected readonly client: CliClient;
  private parseEvent: (line: string) => Record<string, unknown> | null;

  constructor(readonly clientId: string) {
    this.client = createClient(clientId);
    this.parseEvent = this.client.createEventParser();
  }

  /** The same provider policy over another CLI client. */
  withClient(clientId: string): Provider {
    if (clientId === this.clientId) return this;
    return new (this.constructor as new (clientId: string) => Provider)(clientId);
  }

  get command(): string {
    return this.client.command;
  }

  providerOptions(): readonly ProviderOption[] {
    return this.client.options();
  }

  profileOptions(options: Readonly<Record<string, string>>): Record<string, string> {
    const names = new Set(
      this.providerOptions().filter((item) => item.overridable).map((item) => item.name),
    );
    const profile: Record<string, string> = {};
    for (const [key, value] of Object.entries(options)) {
      if (names.has(key)) profile[key] = value;
    }
    return profile;
  }

  createNewSession(): NewSession {
    return {};
  }

  modelCatalogCommand(): string[] {
    return this.client.modelsCommand().argv;
  }

  parseModelCatalog(stdout: string): ModelCatalog {
    const catalog = this.client.parseModels(stdout);
    return new ModelCatalog(catalog.ids, catalog.defaultId, catalog.optionValues);
  }

  optionValuesCommand(name: string, model: string): string[] | null {
    return this.client.optionValuesCommand(name, model)?.argv ?? null;
  }

  parseOptionValues(name: string, text: string, model: string): readonly string[] {
    return this.client.parseOptionValues(name, text, model);
  }

  validateOptions(options: Readonly<Record<string, string>>): void {
    this.client.validateOptions(options);
  }

  buildCommand(input: BuildCommandInput): CommandSpec {
    this.parseEvent = this.client.createEventParser();
    this.validateOptions(input.options);
    return this.client.runCommand(input);
  }

  parseResponse(stdout: string, lastMessageFile: string): [string, string | null] {
    const { text, sessionId } = this.client.parseRun(stdout, lastMessageFile);
    return [text, sessionId];
  }

  classifyFailure(stdout: string, exitCode: number): FailureClassification | null {
    const raw = this.client.extractFailure(stdout, exitCode);
    if (raw === null) return null;
    if (raw.rateLimit !== undefined) {
      return {
        kind: "quota",
        message: raw.message || "quota",
        resetAt: raw.rateLimit.resetAt,
        window: raw.rateLimit.window,
      };
    }
    return { kind: "provider", message: raw.message || `CLI exited with code ${exitCode}.` };
  }

  parseProgressEvent(line: string): Record<string, unknown> | null {
    return this.parseEvent(line);
  }

  captureUsage(stdout: string): UsageCapture | null {
    return this.client.captureUsage(stdout);
  }

  /** Running totals become this turn's share; per-turn figures pass through. */
  normalizeUsage(current: UsageCapture, previous: UsageCapture | null): TurnUsage {
    const now = this.client.readUsage(current);
    const before = previous === null ? null : this.client.readUsage(previous);
    const usage = { ...now.values };
    for (const field of now.cumulative) {
      const value = now.values[field];
      const base = before === null ? 0 : before.values[field];
      if (value === null || base === null || value < base) usage[field] = null;
      else usage[field] = value - base;
    }
    return usage;
  }

  versionCommand(): string[] {
    return this.client.versionCommand().argv;
  }

  parseVersion(stdout: string): string | null {
    return this.client.parseVersion(stdout);
  }
}
