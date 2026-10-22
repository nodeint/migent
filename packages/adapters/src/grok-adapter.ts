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
import { GrokClient } from "./clients/grok-client.js";
import { isRecord } from "./clients/json.js";

type MigrationBody = Record<string, unknown>;
type Migration = (entry: MigrationBody) => void;

const GROK_EFFORT_PROBE = "migent-probe";
const GROK_EFFORTS = /use one of: ([^\n]+)/;
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function moveGrokThinking(body: MigrationBody): void {
  const options = body.options;
  if ("options" in body && !isRecord(options)) return;
  if (isRecord(options) && "thinking" in options) {
    const value = options.thinking;
    if (nonempty(value)) {
      const current = options["reasoning-effort"];
      if (!nonempty(current)) options["reasoning-effort"] = value.trim();
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
  const current = record["reasoning-effort"];
  if (!nonempty(current)) record["reasoning-effort"] = value.trim();
  delete body.thinking;
}

function stripDots(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === ".") start += 1;
  while (end > start && value[end - 1] === ".") end -= 1;
  return value.slice(start, end);
}

export class GrokAdapter implements AgentAdapter {
  readonly displayName = "Grok";
  readonly modelMigrations: Record<number, Migration> = { 0: moveGrokThinking };
  readonly roleMigrations: Record<number, Migration> = { 0: moveGrokThinking };
  readonly stageMigrations: Record<number, Migration> = { 0: moveGrokThinking };
  private parseEvent: (line: string) => Record<string, unknown> | null;

  constructor(private readonly client: CliClient = new GrokClient()) {
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
    if (name !== "reasoning-effort") return null;
    return [
      this.command,
      "-m",
      model,
      "--reasoning-effort",
      GROK_EFFORT_PROBE,
      "-p",
      "x",
      "--output-format",
      "plain",
    ];
  }

  parseOptionValues(name: string, text: string, model: string): readonly string[] {
    void model;
    if (name !== "reasoning-effort") throw new Error(`grok does not list values for ${name}.`);
    const match = GROK_EFFORTS.exec(text);
    if (match === null) {
      const detail = text.split(/\s+/).filter((part) => part !== "").join(" ");
      throw new Error(detail || "grok did not list reasoning-effort values.");
    }
    const values: string[] = [];
    for (const part of (match[1] ?? "").split(",")) {
      const value = stripDots(part.trim());
      if (value && !values.includes(value)) values.push(value);
    }
    if (values.length === 0) throw new Error("grok did not list reasoning-effort values.");
    return values;
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

  normalizeUsage(current: UsageCapture): TurnUsage {
    const body = isRecord(current.end)
      ? { usage: isRecord(current.end.usage) ? current.end.usage : null, cost: finite(current.end.total_cost_usd) }
      : { usage: isRecord(current.usage_event) ? current.usage_event : null, cost: null };
    const usage = body.usage;
    return {
      input_tokens: finite(usage?.input_tokens),
      output_tokens: finite(usage?.output_tokens),
      reasoning_tokens: finite(usage?.reasoning_tokens),
      cache_read_tokens: finite(usage?.cache_read_input_tokens),
      cache_write_tokens: finite(usage?.cache_creation_input_tokens),
      cost_usd: body.cost,
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
