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
import { AGY_EFFORTS, AgyClient } from "./clients/agy-client.js";
import { isRecord } from "./clients/json.js";

export class AgyAdapter implements AgentAdapter {
  readonly displayName = "Antigravity";
  private parseEvent: (line: string) => Record<string, unknown> | null;

  constructor(private readonly client: CliClient = new AgyClient()) {
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
    void model;
    if (name !== "effort") return null;
    return this.modelCatalogCommand();
  }

  parseOptionValues(name: string, text: string, model: string): readonly string[] {
    if (name !== "effort") throw new Error(`agy does not list values for ${name}.`);
    const values = this.parseModelCatalog(text).valuesFor(model, name);
    return values ?? AGY_EFFORTS;
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
    return { kind: "provider", message: raw.message || `CLI exited with code ${exitCode}.` };
  }

  parseProgressEvent(line: string): Record<string, unknown> | null {
    return this.parseEvent(line);
  }

  captureUsage(stdout: string): UsageCapture | null {
    return this.client.captureUsage(stdout);
  }

  normalizeUsage(current: UsageCapture, previous: UsageCapture | null): TurnUsage {
    const steps = Array.isArray(current.steps) ? current.steps : [];
    if (steps.length > 0) return sumAgySteps(steps);
    return agyDelta(resultUsage(current), previous === null ? null : resultUsage(previous), previous === null);
  }

  versionCommand(): string[] {
    return this.client.versionCommand().argv;
  }

  parseVersion(stdout: string): string | null {
    return this.client.parseVersion(stdout);
  }
}

const AGY_FIELDS = ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens"] as const;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function resultUsage(capture: UsageCapture | null): Record<string, unknown> | null {
  if (capture === null || !isRecord(capture.result)) return null;
  return isRecord(capture.result.usage) ? capture.result.usage : null;
}

function sumAgySteps(steps: unknown[]): TurnUsage {
  const sums = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0 };
  const missing = { input_tokens: false, output_tokens: false, thinking_tokens: false, cache_read_tokens: false };
  for (const step of steps) {
    const usage = isRecord(step) ? step : null;
    for (const field of AGY_FIELDS) {
      const value = finite(usage?.[field]);
      if (value === null) missing[field] = true;
      else sums[field] += value;
    }
  }
  return {
    input_tokens: missing.input_tokens ? null : sums.input_tokens,
    output_tokens: missing.output_tokens ? null : sums.output_tokens,
    reasoning_tokens: missing.thinking_tokens ? null : sums.thinking_tokens,
    cache_read_tokens: missing.cache_read_tokens ? null : sums.cache_read_tokens,
    cache_write_tokens: null,
    cost_usd: null,
  };
}

function agyDelta(
  current: Record<string, unknown> | null,
  previous: Record<string, unknown> | null,
  previousIsZero: boolean,
): TurnUsage {
  const delta = (key: (typeof AGY_FIELDS)[number]): number | null => {
    const currentValue = finite(current?.[key]);
    const previousValue = previousIsZero ? 0 : finite(previous?.[key]);
    if (currentValue === null || previousValue === null) return null;
    const value = currentValue - previousValue;
    return value < 0 ? null : value;
  };
  return {
    input_tokens: delta("input_tokens"),
    output_tokens: delta("output_tokens"),
    reasoning_tokens: delta("thinking_tokens"),
    cache_read_tokens: delta("cache_read_tokens"),
    cache_write_tokens: null,
    cost_usd: null,
  };
}
