import { randomUUID } from "node:crypto";
import { classifyProviderError } from "@nodeint/migent-kernel";
import type {
  AgentAdapter,
  BuildCommandInput,
  NewSession,
  ProviderOption,
} from "@nodeint/migent-kernel";
import type { CommandSpec } from "@nodeint/migent-kernel";
import { ModelCatalog } from "./catalog.js";

// `claude` has no command that lists models, so the catalog is the documented
// aliases plus the current full model ids.
const CLAUDE_MODELS = [
  "fable",
  "opus",
  "sonnet",
  "haiku",
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
] as const;
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
] as const;
const DEFAULT_PERMISSION_MODE = "bypassPermissions";

const CLAUDE_OPTIONS: readonly ProviderOption[] = [
  { name: "effort", prompt: true, allowDefault: true, overridable: true },
  { name: "permission_mode" },
  { name: "tools" },
  { name: "allowed_tools" },
  { name: "disallowed_tools" },
  { name: "max_budget_usd" },
  { name: "fallback_model" },
  { name: "append_system_prompt" },
];

function oneOf(value: string, allowed: readonly string[], field: string): void {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of: ${allowed.join(", ")}.`);
  }
}

function claudeBudget(value: string): void {
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(value) || Number(value) <= 0) {
    throw new Error("max_budget_usd must be a positive number.");
  }
}

function claudeText(value: string): void {
  void value;
}

const CLAUDE_OPTION_CHECKS: Record<string, (value: string) => void> = {
  effort: claudeText,
  permission_mode: (value) => oneOf(value, PERMISSION_MODES, "permission_mode"),
  tools: claudeText,
  allowed_tools: claudeText,
  disallowed_tools: claudeText,
  max_budget_usd: claudeBudget,
  fallback_model: claudeText,
  append_system_prompt: claudeText,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendOptions(argv: string[], options: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(options)) {
    argv.push(`--${key.replaceAll("_", "-")}`, value);
  }
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  const text = line.trim();
  if (!text) return null;
  try {
    const payload: unknown = JSON.parse(text);
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

function compact(value: string, limit = 160): string {
  const text = value.split(/\s+/).filter((part) => part !== "").join(" ");
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function contentBlocks(payload: Record<string, unknown>): Record<string, unknown>[] {
  const message = payload.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

function assistantText(payload: Record<string, unknown>): string {
  return contentBlocks(payload)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

function inputString(input: unknown, ...keys: string[]): string | null {
  if (!isRecord(input)) return null;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function toolSummary(block: Record<string, unknown>, action: string): string {
  const name = typeof block.name === "string" && block.name ? block.name : "tool";
  const command = inputString(block.input, "command");
  if (command) return `command ${action}: ${compact(command)}`;
  const target = inputString(block.input, "file_path", "notebook_path", "path", "pattern", "url");
  if (target) return `${name} ${action}: ${compact(target)}`;
  return `${name} ${action}`;
}

function toolDetails(block: Record<string, unknown>): Record<string, unknown> {
  const name = block.name;
  if (typeof name === "string" && name) return { item_type: name };
  return {};
}

function resultError(payload: Record<string, unknown>): string | null {
  const result = payload.result;
  if (typeof result === "string" && result.trim()) return result.trim();
  const errors = payload.errors;
  if (Array.isArray(errors)) {
    const messages = errors.filter((item): item is string => typeof item === "string" && item !== "");
    if (messages.length > 0) return messages.join("; ");
  }
  const subtype = payload.subtype;
  if (typeof subtype === "string" && subtype) return `claude failed: ${subtype}`;
  return null;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly command = "claude";
  readonly displayName = "Claude";
  private toolUses: Record<string, Record<string, unknown>> = {};

  providerOptions(): readonly ProviderOption[] {
    return CLAUDE_OPTIONS;
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
    return [this.command, "--version"];
  }

  parseModelCatalog(stdout: string): ModelCatalog {
    if (!/\d+\.\d+/.test(stdout)) {
      const detail = compact(stdout);
      throw new Error(detail || "claude did not report a version.");
    }
    return new ModelCatalog(
      CLAUDE_MODELS,
      null,
      CLAUDE_MODELS.map((model) => [model, "effort", CLAUDE_EFFORTS] as const),
    );
  }

  optionValuesCommand(name: string, model: string): string[] | null {
    void model;
    if (name !== "effort") return null;
    return this.modelCatalogCommand();
  }

  parseOptionValues(name: string, text: string, model: string): readonly string[] {
    if (name !== "effort") throw new Error(`claude does not list values for ${name}.`);
    const values = this.parseModelCatalog(text).valuesFor(model, name);
    return values ?? CLAUDE_EFFORTS;
  }

  validateOptions(options: Readonly<Record<string, string>>): void {
    for (const [key, value] of Object.entries(options)) {
      const check = CLAUDE_OPTION_CHECKS[key];
      if (check === undefined) throw new Error(`${key} is not a claude option.`);
      if (value.trim() === "") throw new Error(`${key} is empty.`);
      check(value);
    }
  }

  buildCommand(input: BuildCommandInput): CommandSpec {
    this.toolUses = {};
    this.validateOptions(input.options);
    const argv = [
      this.command,
      "-p",
      "--model",
      input.model,
      "--output-format",
      "stream-json",
      "--verbose",
    ];
    const options = { ...input.options };
    if (options.permission_mode === undefined) options.permission_mode = DEFAULT_PERMISSION_MODE;
    appendOptions(argv, options);
    if (input.agentId) argv.push("--resume", input.agentId);
    else if (input.newAgentId) argv.push("--session-id", input.newAgentId);
    // The prompt goes on stdin; the workspace is the process cwd.
    return { argv, stdin: input.prompt };
  }

  parseResponse(stdout: string, lastMessageFile: string): [string, string | null] {
    void lastMessageFile;
    let agentId: string | null = null;
    let lastText: string | null = null;
    let resultText: string | null = null;
    let sawEvent = false;
    for (const rawLine of stdout.split(/\r\n|\n|\r/)) {
      const payload = parseJsonObject(rawLine);
      if (payload === null) continue;
      sawEvent = true;
      const sessionId = payload.session_id;
      if (typeof sessionId === "string" && sessionId) agentId = sessionId;
      const eventType = payload.type;
      if (eventType === "assistant" && payload.parent_tool_use_id == null) {
        const text = assistantText(payload).trim();
        if (text) lastText = text;
      } else if (eventType === "result") {
        if (payload.is_error === true) {
          resultText = resultError(payload);
        } else {
          const result = payload.result;
          if (typeof result === "string" && result.trim()) resultText = result.trim();
        }
      }
    }
    if (resultText !== null) return [resultText, agentId];
    if (lastText !== null) return [lastText, agentId];
    if (sawEvent) return ["", agentId];
    return [stdout.trim(), null];
  }

  parseProgressEvent(line: string): Record<string, unknown> | null {
    const payload = parseJsonObject(line);
    if (payload === null) return null;
    const eventType = payload.type;
    if (eventType === "assistant") {
      const block = contentBlocks(payload).find((item) => item.type === "tool_use");
      if (block === undefined) return null;
      if (typeof block.id === "string" && block.id) this.toolUses[block.id] = block;
      return {
        event: "provider.item_started",
        summary: toolSummary(block, "started"),
        details: toolDetails(block),
      };
    }
    if (eventType === "user") {
      const block = contentBlocks(payload).find((item) => item.type === "tool_result");
      if (block === undefined) return null;
      const id = block.tool_use_id;
      const toolUse = (typeof id === "string" ? this.toolUses[id] : undefined) ?? {};
      const action = block.is_error === true ? "failed" : "completed";
      return {
        event: "provider.item_completed",
        summary: toolSummary(toolUse, action),
        details: toolDetails(toolUse),
      };
    }
    if (eventType === "result" && payload.is_error === true) {
      const failed = classifyProviderError(resultError(payload));
      if (failed.event === "provider.warning") return failed;
      return { event: "provider.turn_failed", summary: failed.summary };
    }
    return null;
  }
}
