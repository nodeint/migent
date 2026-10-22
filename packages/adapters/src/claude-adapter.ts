import { randomUUID } from "node:crypto";
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
import { ClaudeCodeClient } from "./clients/claude-code-client.js";
import { isRecord } from "./clients/json.js";

const DEFAULT_PERMISSION_MODE = "bypassPermissions";

export class ClaudeAdapter implements AgentAdapter {
  readonly displayName = "Claude";
  private parseEvent: (line: string) => Record<string, unknown> | null;

  constructor(private readonly client: CliClient = new ClaudeCodeClient()) {
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
    return { agentId: randomUUID() };
  }

  modelCatalogCommand(): string[] {
    return this.client.modelsCommand().argv;
  }

  modelCatalogInput(): string {
    return this.client.modelsCommand().stdin ?? "";
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
    const values = this.parseModelCatalog(text).valuesFor(model, name);
    if (values === null) throw new Error(`claude does not list ${name} values for ${model}.`);
    return values;
  }

  validateOptions(options: Readonly<Record<string, string>>): void {
    this.client.validateOptions(options);
  }

  buildCommand(input: BuildCommandInput): CommandSpec {
    this.parseEvent = this.client.createEventParser();
    this.validateOptions(input.options);
    const options = { ...input.options };
    if (options.permission_mode === undefined) options.permission_mode = DEFAULT_PERMISSION_MODE;
    return this.client.runCommand({ ...input, options });
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

  normalizeUsage(current: UsageCapture, previous: UsageCapture | null): TurnUsage {
    const result = isRecord(current.result) ? current.result : null;
    const usage = result !== null && isRecord(result.usage) ? result.usage : null;
    const details = usage !== null && isRecord(usage.output_tokens_details) ? usage.output_tokens_details : null;
    return {
      input_tokens: finite(usage?.input_tokens),
      output_tokens: finite(usage?.output_tokens),
      reasoning_tokens: finite(details?.thinking_tokens),
      cache_read_tokens: finite(usage?.cache_read_input_tokens),
      cache_write_tokens: finite(usage?.cache_creation_input_tokens),
      cost_usd: claudeCost(result, previous),
    };
  }

  versionCommand(): string[] {
    return this.client.versionCommand().argv;
  }

  parseVersion(stdout: string): string | null {
    return this.client.parseVersion(stdout);
  }
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function claudeCost(result: Record<string, unknown> | null, previous: UsageCapture | null): number | null {
  const currentCost = finite(result?.total_cost_usd);
  if (currentCost === null) return null;
  if (previous === null) return currentCost;
  const previousResult = isRecord(previous.result) ? previous.result : null;
  const previousCost = finite(previousResult?.total_cost_usd);
  if (previousCost === null) return null;
  const delta = currentCost - previousCost;
  return delta < 0 ? null : delta;
}
