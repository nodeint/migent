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
import { CODEX_REASONING_OPTION, CodexClient } from "./clients/codex-client.js";
import { isRecord } from "./clients/json.js";

type MigrationBody = Record<string, unknown>;
type Migration = (entry: MigrationBody) => void;

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function moveCodexThinking(body: MigrationBody): void {
  const options = body.options;
  if ("options" in body && !isRecord(options)) return;
  if (isRecord(options) && "thinking" in options) {
    const value = options.thinking;
    if (nonempty(value)) {
      const current = options.model_reasoning_effort;
      if (!nonempty(current)) options.model_reasoning_effort = value.trim();
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
  const current = record.model_reasoning_effort;
  if (!nonempty(current)) record.model_reasoning_effort = value.trim();
  delete body.thinking;
}

export class CodexAdapter implements AgentAdapter {
  readonly displayName = "Codex";
  readonly modelMigrations: Record<number, Migration> = { 0: moveCodexThinking };
  readonly roleMigrations: Record<number, Migration> = { 0: moveCodexThinking };
  readonly stageMigrations: Record<number, Migration> = { 0: moveCodexThinking };
  private readonly parseEvent: (line: string) => Record<string, unknown> | null;

  constructor(private readonly client: CliClient = new CodexClient()) {
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
    if (name !== CODEX_REASONING_OPTION) return null;
    return this.modelCatalogCommand();
  }

  parseOptionValues(name: string, text: string, model: string): readonly string[] {
    if (name !== CODEX_REASONING_OPTION) throw new Error(`codex does not list values for ${name}.`);
    const values = this.parseModelCatalog(text).valuesFor(model, name);
    if (values === null) throw new Error(`codex did not list ${name} values for ${model}.`);
    return values;
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
    return { kind: "provider", message: raw.message || `CLI exited with code ${exitCode}.` };
  }

  parseProgressEvent(line: string): Record<string, unknown> | null {
    return this.parseEvent(line);
  }

  captureUsage(stdout: string): UsageCapture | null {
    return this.client.captureUsage(stdout);
  }

  normalizeUsage(current: UsageCapture, previous: UsageCapture | null): TurnUsage {
    const usage = lastUsage(current);
    const baseline = previous === null ? null : lastUsage(previous);
    const inputDelta = codexDelta(usage, baseline, "input_tokens", previous === null);
    const cachedDelta = codexDelta(usage, baseline, "cached_input_tokens", previous === null);
    const cachedKnown = usage !== null && finite(usage.cached_input_tokens) !== null;
    let input: number | null = null;
    if (cachedKnown && inputDelta !== null && cachedDelta !== null) {
      const value = inputDelta - cachedDelta;
      input = value < 0 ? null : value;
    }
    return {
      input_tokens: input,
      output_tokens: codexDelta(usage, baseline, "output_tokens", previous === null),
      reasoning_tokens: codexDelta(usage, baseline, "reasoning_output_tokens", previous === null),
      cache_read_tokens: cachedDelta,
      cache_write_tokens: codexDelta(usage, baseline, "cache_write_input_tokens", previous === null),
      cost_usd: null,
    };
  }

  versionCommand(): string[] {
    return this.client.versionCommand().argv;
  }

  parseVersion(stdout: string): string | null {
    return this.client.parseVersion(stdout);
  }
}

function lastUsage(capture: UsageCapture | null): Record<string, unknown> | null {
  if (capture === null) return null;
  const list = capture.turn_completed;
  if (!Array.isArray(list) || list.length === 0) return null;
  const last = list[list.length - 1];
  return isRecord(last) ? last : null;
}

function codexDelta(
  current: Record<string, unknown> | null,
  previous: Record<string, unknown> | null,
  key: string,
  previousIsZero: boolean,
): number | null {
  const currentValue = finite(current?.[key]);
  const previousValue = previousIsZero ? 0 : finite(previous?.[key]);
  if (currentValue === null || previousValue === null) return null;
  const delta = currentValue - previousValue;
  return delta < 0 ? null : delta;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
