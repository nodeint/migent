import { classifyProviderError, providerErrorMessage } from "@nodeint/migent-kernel";
import type {
  AgentAdapter,
  BuildCommandInput,
  FailureClassification,
  NewSession,
  ProviderOption,
  TurnUsage,
  UsageCapture,
} from "@nodeint/migent-kernel";
import type { CommandSpec } from "@nodeint/migent-kernel";
import { ModelCatalog } from "./catalog.js";

const OPENCODE_OPTIONS: readonly ProviderOption[] = [{ name: "agent" }, { name: "thinking" }];

const USAGE_METRICS: ReadonlyArray<readonly [keyof TurnUsage, readonly string[]]> = [
  ["input_tokens", ["tokens", "input"]],
  ["output_tokens", ["tokens", "output"]],
  ["reasoning_tokens", ["tokens", "reasoning"]],
  ["cache_read_tokens", ["tokens", "cache", "read"]],
  ["cache_write_tokens", ["tokens", "cache", "write"]],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
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

function events(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const rawLine of stdout.split(/\r\n|\n|\r/)) {
    const payload = parseJsonObject(rawLine);
    if (payload !== null) out.push(payload);
  }
  return out;
}

function partOf(payload: Record<string, unknown>): Record<string, unknown> {
  return isRecord(payload.part) ? payload.part : {};
}

function errorString(payload: Record<string, unknown>): string {
  const message = providerErrorMessage(payload);
  if (message !== null) return message;
  const error = payload.error;
  if (isRecord(error) && typeof error.type === "string" && error.type !== "") return error.type;
  return "opencode reported an error.";
}

function lookup(source: unknown, path: readonly string[]): unknown {
  let value = source;
  for (const key of path) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return value;
}

export class OpencodeAdapter implements AgentAdapter {
  readonly command = "opencode";
  readonly displayName = "OpenCode";

  providerOptions(): readonly ProviderOption[] {
    return OPENCODE_OPTIONS;
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
    for (const raw of stdout.split(/\r\n|\n|\r/)) {
      const line = raw.trim();
      if (line && !ids.includes(line)) ids.push(line);
    }
    if (ids.length === 0) throw new Error("opencode model catalog is empty.");
    return new ModelCatalog(ids, null);
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
    const known = new Set(OPENCODE_OPTIONS.map((item) => item.name));
    for (const [key, value] of Object.entries(options)) {
      if (!known.has(key)) throw new Error(`${key} is not an opencode option.`);
      if (value.trim() === "") throw new Error(`${key} is empty.`);
      if (key === "thinking" && value !== "true" && value !== "false") {
        throw new Error("thinking must be true or false.");
      }
    }
  }

  buildCommand(input: BuildCommandInput): CommandSpec {
    this.validateOptions(input.options);
    // The workspace is the process cwd, so input.workspace is not passed.
    const argv = [this.command, "run", "--format", "json", "--auto", "-m", input.model];
    const agent = input.options.agent;
    if (agent !== undefined) argv.push("--agent", agent);
    if (input.options.thinking === "true") argv.push("--thinking");
    if (input.agentId) argv.push("-s", input.agentId);
    return { argv, stdin: input.prompt };
  }

  parseResponse(stdout: string, lastMessageFile: string): [string, string | null] {
    void lastMessageFile;
    const segments: string[][] = [[]];
    let agentId: string | null = null;
    let errorMessage: string | null = null;
    let sawEvent = false;
    for (const payload of events(stdout)) {
      sawEvent = true;
      const sessionId = payload.sessionID;
      if (typeof sessionId === "string" && sessionId) agentId = sessionId;
      const eventType = payload.type;
      if (eventType === "text") {
        const text = partOf(payload).text;
        if (typeof text === "string" && text) segments[segments.length - 1]?.push(text);
      } else if (eventType === "tool_use") {
        if (segments[segments.length - 1]?.length) segments.push([]);
      } else if (eventType === "error") {
        errorMessage = errorString(payload);
      }
    }
    const text = textWithStatusHeader(segments);
    if (text) return [text, agentId];
    if (errorMessage) return [errorMessage, agentId];
    if (sawEvent) return ["", agentId];
    return [stdout.trim(), null];
  }

  classifyFailure(stdout: string, exitCode: number): FailureClassification | null {
    // An error event followed by a retry that succeeds still classifies as a failure; accepted.
    let errorMessage: string | null = null;
    for (const payload of events(stdout)) {
      if (payload.type === "error") errorMessage = errorString(payload);
    }
    if (errorMessage !== null) return { kind: "provider", message: errorMessage };
    if (exitCode === 0) return null;
    const [text] = this.parseResponse(stdout, "");
    return { kind: "provider", message: text.trim() || `CLI exited with code ${exitCode}.` };
  }

  parseProgressEvent(line: string): Record<string, unknown> | null {
    const payload = parseJsonObject(line);
    if (payload === null) return null;
    if (payload.type === "error") return classifyProviderError(providerErrorMessage(payload));
    if (payload.type !== "tool_use") return null;
    const part = partOf(payload);
    const state = isRecord(part.state) ? part.state : {};
    let event: string;
    let action: string;
    if (state.status === "running" || state.status === "pending") {
      event = "provider.item_started";
      action = "started";
    } else if (state.status === "completed") {
      event = "provider.item_completed";
      action = "completed";
    } else if (state.status === "error") {
      event = "provider.item_completed";
      action = "failed";
    } else {
      return null;
    }
    const tool = typeof part.tool === "string" && part.tool !== "" ? part.tool : null;
    const command = lookup(state, ["input", "command"]);
    const summary =
      typeof command === "string" && command !== ""
        ? `command ${action}: ${compact(command)}`
        : `${tool ?? "tool"} ${action}`;
    return { event, summary, details: tool === null ? {} : { item_type: tool } };
  }

  captureUsage(stdout: string): UsageCapture | null {
    const steps: Record<string, unknown>[] = [];
    for (const payload of events(stdout)) {
      if (payload.type !== "step_finish") continue;
      const part = partOf(payload);
      steps.push({ tokens: part.tokens, cost: part.cost });
    }
    return steps.length === 0 ? null : { steps };
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
    return [this.command, "--version"];
  }

  parseVersion(stdout: string): string | null {
    const line = (stdout.split(/\r\n|\n|\r/, 1)[0] ?? "").trim();
    const version = line.replace(/^opencode v/i, "").trim();
    return version === "" ? null : version;
  }
}
