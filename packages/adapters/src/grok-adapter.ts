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

type MigrationBody = Record<string, unknown>;
type Migration = (entry: MigrationBody) => void;

const GROK_EFFORT_PROBE = "migent-probe";
const GROK_EFFORTS = /use one of: ([^\n]+)/;
const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "plan",
] as const;
const GROK_FLAGS: Record<string, string> = {};

const GROK_OPTIONS: readonly ProviderOption[] = [
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

function oneOf(value: string, allowed: readonly string[], field: string): void {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of: ${allowed.join(", ")}.`);
  }
}

function grokMaxTurns(value: string): void {
  if (!/^[0-9]+$/.test(value) || Number(value) < 1) {
    throw new Error("max_turns must be an integer of at least 1.");
  }
}

function grokText(value: string): void {
  void value;
}

const GROK_OPTION_CHECKS: Record<string, (value: string) => void> = {
  "reasoning-effort": grokText,
  max_turns: grokMaxTurns,
  tools: grokText,
  disallowed_tools: grokText,
  permission_mode: (value) => oneOf(value, PERMISSION_MODES, "permission_mode"),
  rules: grokText,
  allow: grokText,
  deny: grokText,
  sandbox: grokText,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function appendOptions(argv: string[], options: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(options)) {
    const flag = GROK_FLAGS[key] ?? key.replaceAll("_", "-");
    argv.push(`--${flag}`, value);
  }
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  try {
    const payload: unknown = JSON.parse(line);
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

function compact(value: string, limit = 160): string {
  const text = value.split(/\s+/).filter((part) => part !== "").join(" ");
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function trimToStatusHeader(text: string): string {
  const header = /(?:^|\n)[ \t]*status:[ \t]*(?:complete|blocked)\b/im.exec(text);
  if (header !== null) return text.slice(header.index).trimStart();
  const glued = /status:[ \t]*(?:complete|blocked)\b/i.exec(text);
  if (glued !== null) return text.slice(glued.index).trim();
  return text;
}

function hasStatusHeader(text: string): boolean {
  return (
    /(?:^|\n)[ \t]*status:[ \t]*(?:complete|blocked)\b/im.test(text) ||
    /status:[ \t]*(?:complete|blocked)\b/i.test(text)
  );
}

function textWithStatusHeader(segments: readonly (readonly string[])[]): string {
  let lastNonempty = "";
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const text = (segments[index] ?? []).join("").trim();
    if (!text) continue;
    if (!lastNonempty) lastNonempty = text;
    const trimmed = trimToStatusHeader(text);
    if (hasStatusHeader(trimmed)) return trimmed;
  }
  if (lastNonempty) return trimToStatusHeader(lastNonempty);
  return "";
}

function toolNameOf(payload: Record<string, unknown>): string {
  for (const key of ["toolName", "title", "kind"]) {
    const value = payload[key];
    if (typeof value === "string" && value) return value;
  }
  return "tool";
}

function inputString(rawInput: unknown, ...keys: string[]): string | null {
  if (!isRecord(rawInput)) return null;
  for (const key of keys) {
    const value = rawInput[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function toolSummary(payload: Record<string, unknown>, action: string): string {
  const command = inputString(payload.rawInput, "command", "cmd");
  if (command) return `command ${action}: ${compact(command)}`;
  const path = inputString(payload.rawInput, "path", "target_file");
  const name = toolNameOf(payload);
  if (path) return `${name} ${action}: ${compact(path)}`;
  return `${name} ${action}`;
}

function toolDetails(payload: Record<string, unknown>): Record<string, unknown> {
  const toolName = payload.toolName;
  if (typeof toolName === "string" && toolName) return { item_type: toolName };
  return {};
}

function stripDots(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === ".") start += 1;
  while (end > start && value[end - 1] === ".") end -= 1;
  return value.slice(start, end);
}

export class GrokAdapter implements AgentAdapter {
  readonly command = "grok";
  readonly displayName = "Grok";
  readonly modelMigrations: Record<number, Migration> = { 0: moveGrokThinking };
  readonly roleMigrations: Record<number, Migration> = { 0: moveGrokThinking };
  readonly stageMigrations: Record<number, Migration> = { 0: moveGrokThinking };
  private toolCalls: Record<string, Record<string, unknown>> = {};

  providerOptions(): readonly ProviderOption[] {
    return GROK_OPTIONS;
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
    return [this.command, "models"];
  }

  parseModelCatalog(stdout: string): ModelCatalog {
    const ids: string[] = [];
    let defaultId: string | null = null;
    let inList = false;
    for (const raw of stdout.split(/\r\n|\n|\r/)) {
      const line = raw.trim();
      if (line.toLowerCase().startsWith("default model:")) {
        defaultId = line.split(":").slice(1).join(":").trim();
        continue;
      }
      if (line.toLowerCase().startsWith("available models")) {
        inList = true;
        continue;
      }
      if (!inList || (!line.startsWith("*") && !line.startsWith("-"))) continue;
      const name = line.slice(1).trim().split(/\s+/)[0] ?? "";
      if (name && !ids.includes(name)) ids.push(name);
      if (line.includes("(default)")) defaultId = name;
    }
    if (ids.length === 0) throw new Error("grok model catalog is empty.");
    if (defaultId === null || !ids.includes(defaultId)) defaultId = null;
    return new ModelCatalog(ids, defaultId);
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
    for (const [key, value] of Object.entries(options)) {
      const check = GROK_OPTION_CHECKS[key];
      if (check === undefined) throw new Error(`${key} is not a grok option.`);
      if (value.trim() === "") throw new Error(`${key} is empty.`);
      check(value);
    }
  }

  buildCommand(input: BuildCommandInput): CommandSpec {
    this.toolCalls = {};
    this.validateOptions(input.options);
    const argv = [
      this.command,
      "--prompt-file",
      input.promptFile,
      "-m",
      input.model,
      "--cwd",
      input.workspace,
      "--output-format",
      "streaming-json",
      "--always-approve",
      "--verbatim",
    ];
    appendOptions(argv, input.options);
    if (input.agentId) argv.push("--resume", input.agentId);
    else if (input.newAgentId) argv.push("--session-id", input.newAgentId);
    return { argv };
  }

  parseResponse(stdout: string, lastMessageFile: string): [string, string | null] {
    void lastMessageFile;
    const segments: string[][] = [[]];
    let agentId: string | null = null;
    let errorMessage: string | null = null;
    let sawEvent = false;
    for (const rawLine of stdout.split(/\r\n|\n|\r/)) {
      const payload = parseJsonObject(rawLine);
      if (payload === null) continue;
      sawEvent = true;
      const eventType = payload.type;
      if (
        eventType === "tool_call" ||
        (eventType === "tool_call_update" &&
          (payload.status === "completed" || payload.status === "failed"))
      ) {
        if (segments[segments.length - 1]?.length) segments.push([]);
      } else if (eventType === "text") {
        const data = payload.data;
        if (typeof data === "string" && data) segments[segments.length - 1]?.push(data);
      } else if (eventType === "end") {
        const sessionId = payload.sessionId;
        if (typeof sessionId === "string" && sessionId) agentId = sessionId;
      } else if (eventType === "error") {
        const message = payload.message;
        if (typeof message === "string" && message) errorMessage = message;
      }
    }
    const text = textWithStatusHeader(segments);
    if (text) return [text, agentId];
    if (errorMessage) return [errorMessage, agentId];
    if (sawEvent) return ["", agentId];
    return [stdout.trim(), null];
  }

  parseProgressEvent(line: string): Record<string, unknown> | null {
    const payload = parseJsonObject(line);
    if (payload === null) return null;
    const eventType = payload.type;
    if (eventType === "tool_call") {
      this.rememberToolCall(payload);
      return {
        event: "provider.item_started",
        summary: toolSummary(payload, "started"),
        details: toolDetails(payload),
      };
    }
    if (eventType === "tool_call_update") {
      const status = payload.status;
      if (status !== "completed" && status !== "failed") return null;
      const merged = { ...this.rememberedToolCall(payload), ...payload };
      const action = status === "failed" ? "failed" : "completed";
      return {
        event: "provider.item_completed",
        summary: toolSummary(merged, action),
        details: toolDetails(merged),
      };
    }
    if (eventType === "error") return classifyProviderError(providerErrorMessage(payload));
    return null;
  }

  private rememberToolCall(payload: Record<string, unknown>): void {
    const toolCallId = payload.toolCallId;
    if (typeof toolCallId === "string" && toolCallId) this.toolCalls[toolCallId] = payload;
  }

  private rememberedToolCall(payload: Record<string, unknown>): Record<string, unknown> {
    const toolCallId = payload.toolCallId;
    if (typeof toolCallId === "string") return this.toolCalls[toolCallId] ?? {};
    return {};
  }

  captureUsage(stdout: string): UsageCapture | null {
    let end: Record<string, unknown> | null = null;
    let usageEvent: Record<string, unknown> | null = null;
    for (const rawLine of stdout.split(/\r\n|\n|\r/)) {
      const payload = parseJsonObject(rawLine);
      if (payload === null) continue;
      if (payload.type === "end") end = payload;
      else if (payload.type === "usage" && isRecord(payload.usage)) usageEvent = payload.usage;
    }
    if (end) return { end: picked(end, ["usage", "total_cost_usd", "num_turns"]) };
    if (usageEvent) return { usage_event: usageEvent };
    return null;
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
    return [this.command, "--version"];
  }

  parseVersion(stdout: string): string | null {
    return versionLine(stdout);
  }
}

function picked(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key)) out[key] = source[key];
  }
  return out;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function versionLine(stdout: string): string | null {
  const line = (stdout.split(/\r\n|\n|\r/, 1)[0] ?? "").trim();
  return line === "" ? null : line;
}
