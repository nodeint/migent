import { classifyProviderError, providerErrorMessage } from "@nodeint/migent-kernel";
import type {
  AgentAdapter,
  BuildCommandInput,
  NewSession,
  ProviderOption,
  TurnUsage,
  UsageCapture,
} from "@nodeint/migent-kernel";
import type { CommandSpec } from "@nodeint/migent-kernel";
import { ModelCatalog } from "./catalog.js";
import { readExistingText } from "./read-text.js";

type MigrationBody = Record<string, unknown>;
type Migration = (entry: MigrationBody) => void;

const OPTION_KEY = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const TOML_BARE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$|^true$|^false$/;
const CODEX_CONFIG_KEYS: Record<string, string> = {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function reasoningLevels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const values: string[] = [];
  for (const level of raw) {
    let effort: unknown;
    if (isRecord(level)) effort = level.effort;
    else if (typeof level === "string") effort = level;
    else continue;
    if (typeof effort === "string" && effort && !values.includes(effort)) values.push(effort);
  }
  return values;
}

function tomlLiteral(value: string): string {
  if (TOML_BARE.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function appendOptions(argv: string[], options: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(options)) {
    const configKey = CODEX_CONFIG_KEYS[key] ?? key;
    argv.push("-c", `${configKey}=${tomlLiteral(value)}`);
  }
}

function compact(value: string, limit = 160): string {
  const text = value.split(/\s+/).filter((part) => part !== "").join(" ");
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function itemSummary(item: unknown, itemType: unknown, action: string): string {
  if (isRecord(item) && itemType === "command_execution") {
    const command = item.command;
    if (typeof command === "string" && command) return `command ${action}: ${compact(command)}`;
  }
  if (isRecord(item) && itemType === "agent_message") {
    const text = item.text;
    if (typeof text === "string" && text) return `agent: ${compact(text)}`;
  }
  const label = typeof itemType === "string" && itemType ? itemType : "provider item";
  return `${label} ${action}`;
}

export class CodexAdapter implements AgentAdapter {
  readonly command = "codex";
  readonly displayName = "Codex";
  readonly modelMigrations: Record<number, Migration> = { 0: moveCodexThinking };
  readonly roleMigrations: Record<number, Migration> = { 0: moveCodexThinking };
  readonly stageMigrations: Record<number, Migration> = { 0: moveCodexThinking };

  providerOptions(): readonly ProviderOption[] {
    return [{ name: "model_reasoning_effort", prompt: true, allowDefault: true, overridable: true }];
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
    return [this.command, "debug", "models"];
  }

  parseModelCatalog(stdout: string): ModelCatalog {
    let payload: unknown;
    try {
      payload = JSON.parse(stdout);
    } catch {
      throw new Error("codex model catalog is not JSON.");
    }
    const models = isRecord(payload) ? payload.models : null;
    if (!Array.isArray(models)) throw new Error("codex model catalog has no models.");
    const ids: string[] = [];
    const optionValues: Array<readonly [string, string, readonly string[]]> = [];
    for (const item of models) {
      if (!isRecord(item)) continue;
      const visibility = item.visibility;
      if (visibility !== undefined && visibility !== null && visibility !== "list") continue;
      const slug = item.slug;
      if (typeof slug === "string" && slug && !ids.includes(slug)) {
        ids.push(slug);
        optionValues.push([slug, "model_reasoning_effort", reasoningLevels(item.supported_reasoning_levels)]);
      }
    }
    if (ids.length === 0) throw new Error("codex model catalog is empty.");
    return new ModelCatalog(ids, null, optionValues);
  }

  optionValuesCommand(name: string, model: string): string[] | null {
    void model;
    if (name !== "model_reasoning_effort") return null;
    return this.modelCatalogCommand();
  }

  parseOptionValues(name: string, text: string, model: string): readonly string[] {
    if (name !== "model_reasoning_effort") throw new Error(`codex does not list values for ${name}.`);
    const values = this.parseModelCatalog(text).valuesFor(model, name);
    if (values === null) throw new Error(`codex did not list ${name} values for ${model}.`);
    return values;
  }

  validateOptions(options: Readonly<Record<string, string>>): void {
    for (const [key, value] of Object.entries(options)) {
      if (!OPTION_KEY.test(key)) throw new Error(`${key} is not a codex option.`);
      if (value.trim() === "") throw new Error(`${key} is empty.`);
    }
  }

  buildCommand(input: BuildCommandInput): CommandSpec {
    this.validateOptions(input.options);
    const argv = [
      this.command,
      "exec",
      "-C",
      input.workspace,
      "-m",
      input.model,
      "--color",
      "never",
      "--json",
      "--output-last-message",
      input.lastMessageFile,
    ];
    appendOptions(argv, input.options);
    if (input.agentId) {
      argv.push("resume", input.agentId, "-");
    } else {
      // `--approve-for-me` already selects the workspace-write sandbox.
      argv.push("--approve-for-me", "-");
    }
    return { argv, stdin: input.prompt };
  }

  parseResponse(stdout: string, lastMessageFile: string): [string, string | null] {
    let agentId: string | null = null;
    let lastText: string | null = null;
    for (const rawLine of stdout.split(/\r\n|\n|\r/)) {
      const line = rawLine.trim();
      if (!line) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(event)) continue;
      const eventType = event.type;
      if (eventType === "thread.started") {
        const threadId = event.thread_id;
        if (typeof threadId === "string" && threadId) agentId = threadId;
      } else if (eventType === "item.completed") {
        const item = event.item;
        if (isRecord(item) && item.type === "agent_message") {
          const text = item.text;
          if (typeof text === "string" && text) lastText = text;
        }
      } else if (eventType === "turn.failed") {
        const error = event.error;
        const message = isRecord(error) ? error.message : undefined;
        if (typeof message === "string" && message) lastText = message;
      } else if (eventType === "error") {
        const message = event.message;
        if (typeof message === "string" && message) lastText = message;
      }
    }
    const fileText = readExistingText(lastMessageFile);
    if (fileText !== null) {
      const stripped = fileText.trim();
      if (stripped) lastText = stripped;
    }
    return [lastText !== null ? lastText : stdout.trim(), agentId];
  }

  parseProgressEvent(line: string): Record<string, unknown> | null {
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isRecord(payload)) return null;
    const eventType = payload.type;
    if (typeof eventType !== "string") return null;
    if (eventType === "item.started" || eventType === "item.completed") {
      const item = payload.item;
      const itemType = isRecord(item) ? item.type : undefined;
      const action = eventType.endsWith("started") ? "started" : "completed";
      return {
        event: eventType.endsWith("started") ? "provider.item_started" : "provider.item_completed",
        summary: itemSummary(item, itemType, action),
        details: typeof itemType === "string" ? { item_type: itemType } : {},
      };
    }
    if (eventType === "turn.failed") {
      const failed = classifyProviderError(providerErrorMessage(payload));
      if (failed.event === "provider.warning") return failed;
      return { event: "provider.turn_failed", summary: failed.summary };
    }
    if (eventType === "error") return classifyProviderError(providerErrorMessage(payload));
    return null;
  }

  captureUsage(stdout: string): UsageCapture | null {
    const turnCompleted: Record<string, unknown>[] = [];
    for (const rawLine of stdout.split(/\r\n|\n|\r/)) {
      const line = rawLine.trim();
      if (!line) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(event) || event.type !== "turn.completed" || !isRecord(event.usage)) continue;
      turnCompleted.push(event.usage);
    }
    if (turnCompleted.length === 0) return null;
    return { turn_completed: turnCompleted };
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
    return [this.command, "--version"];
  }

  parseVersion(stdout: string): string | null {
    return versionLine(stdout);
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

function versionLine(stdout: string): string | null {
  const line = (stdout.split(/\r\n|\n|\r/, 1)[0] ?? "").trim();
  return line === "" ? null : line;
}
