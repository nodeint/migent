import type {
  AgentAdapter,
  BuildCommandInput,
  CliClient,
  FailureClassification,
  NewSession,
  ProviderOption,
  TurnUsage,
  UsageCapture,
} from "@nodeint/migent-kernel";
import type { CommandSpec } from "@nodeint/migent-kernel";
import { ModelCatalog } from "./catalog.js";
import { OpencodeClient, lookup } from "./clients/opencode-client.js";

const USAGE_METRICS: ReadonlyArray<readonly [keyof TurnUsage, readonly string[]]> = [
  ["input_tokens", ["tokens", "input"]],
  ["output_tokens", ["tokens", "output"]],
  ["reasoning_tokens", ["tokens", "reasoning"]],
  ["cache_read_tokens", ["tokens", "cache", "read"]],
  ["cache_write_tokens", ["tokens", "cache", "write"]],
];

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Reads "exceeded the 5-hour usage quota … reset at 2026-10-22 18:43:08 +0800 CST". */
function quotaFromMessage(message: string): FailureClassification | null {
  if (!/exceeded[^.]*quota/i.test(message)) return null;
  const window = /(\d+)-hour/i.exec(message);
  const reset = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})/.exec(message);
  const instant = reset === null ? NaN : Date.parse(`${reset[1]}T${reset[2]}${reset[3]}:${reset[4]}`);
  return {
    kind: "quota",
    message,
    resetAt: Number.isNaN(instant) ? null : new Date(instant).toISOString(),
    window: window === null ? null : `${window[1]}h`,
  };
}

export class OpencodeAdapter implements AgentAdapter {
  readonly displayName = "OpenCode";
  private readonly parseEvent: (line: string) => Record<string, unknown> | null;

  constructor(private readonly client: CliClient = new OpencodeClient()) {
    this.parseEvent = client.createEventParser();
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
    void name;
    void model;
    return null;
  }

  parseOptionValues(name: string, text: string, model: string): readonly string[] {
    void text;
    void model;
    throw new Error(`opencode does not list values for ${name}.`);
  }

  validateOptions(options: Readonly<Record<string, string>>): void {
    this.client.validateOptions(options);
  }

  buildCommand(input: BuildCommandInput): CommandSpec {
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
    const message = raw.message || `CLI exited with code ${exitCode}.`;
    return quotaFromMessage(message) ?? { kind: "provider", message };
  }

  parseProgressEvent(line: string): Record<string, unknown> | null {
    return this.parseEvent(line);
  }

  captureUsage(stdout: string): UsageCapture | null {
    return this.client.captureUsage(stdout);
  }

  normalizeUsage(current: UsageCapture): TurnUsage {
    const steps = Array.isArray(current.steps) ? current.steps : [];
    const sum = (read: (step: unknown) => unknown): number | null => {
      let total = 0;
      for (const step of steps) {
        const value = finite(read(step));
        if (value === null) return null;
        total += value;
      }
      return total;
    };
    const usage: TurnUsage = {
      input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      cost_usd: sum((step) => lookup(step, ["cost"])),
    };
    for (const [metric, path] of USAGE_METRICS) {
      usage[metric] = sum((step) => lookup(step, path));
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
