import { classifyProviderError, providerErrorMessage } from "@nodeint/migent-kernel";
import type {
  BuildCommandInput,
  CliClient,
  CliRunOutput,
  CliUsage,
  CommandSpec,
  ProviderOption,
  RawFailure,
  UsageCapture,
} from "@nodeint/migent-kernel";
import { ModelCatalog } from "../catalog.js";
import { compact, finite, isRecord, parseJsonObject } from "./json.js";

const OPENCODE_OPTIONS: readonly ProviderOption[] = [
  { name: "agent" },
  { name: "thinking" },
  { name: "variant", overridable: true },
];

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

/** Reads "exceeded the 5-hour usage quota … reset at 2026-10-22 18:43:08 +0800 CST". */
function quotaFromMessage(message: string): Pick<RawFailure, "rateLimit"> {
  if (!/exceeded[^.]*quota/i.test(message)) return {};
  const window = /(\d+)-hour/i.exec(message);
  const reset = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})/.exec(message);
  const instant = reset === null ? NaN : Date.parse(`${reset[1]}T${reset[2]}${reset[3]}:${reset[4]}`);
  return {
    rateLimit: {
      resetAt: Number.isNaN(instant) ? null : new Date(instant).toISOString(),
      window: window === null ? null : `${window[1]}h`,
    },
  };
}

export function lookup(source: unknown, path: readonly string[]): unknown {
  let value = source;
  for (const key of path) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return value;
}

export class OpencodeClient implements CliClient {
  readonly effortOption = "variant";
  readonly id = "opencode";
  readonly command = "opencode";

  options(): readonly ProviderOption[] {
    return OPENCODE_OPTIONS;
  }

  validateOptions(options: Readonly<Record<string, string>>): void {
    const known = new Set(OPENCODE_OPTIONS.map((item) => item.name));
    for (const [key, value] of Object.entries(options)) {
      if (!known.has(key)) throw new Error(`${key} is not an opencode option.`);
      if (value.trim() === "") throw new Error(`${key} is empty.`);
      if (key === "variant" && /[\s#]/u.test(value)) {
        throw new Error("variant must be a single variant name without whitespace or #.");
      }
      if (key === "thinking" && value !== "true" && value !== "false") {
        throw new Error("thinking must be true or false.");
      }
    }
  }

  runCommand(input: BuildCommandInput): CommandSpec {
    // The workspace is the process cwd, so input.workspace is not passed.
    const variant = input.options.variant;
    if (variant !== undefined && input.model.includes("#")) {
      throw new Error("Model already selects a #variant; use either the model suffix or effort/options.variant, not both.");
    }
    const model = variant === undefined ? input.model : `${input.model}#${variant}`;
    const argv = [this.command, "run", "--format", "json", "--auto", "-m", model];
    const agent = input.options.agent;
    if (agent !== undefined) argv.push("--agent", agent);
    if (input.options.thinking === "true") argv.push("--thinking");
    if (input.agentId) argv.push("-s", input.agentId);
    return { argv, stdin: input.prompt };
  }

  modelsCommand(): CommandSpec {
    return { argv: [this.command, "models"] };
  }

  versionCommand(): CommandSpec {
    return { argv: [this.command, "--version"] };
  }

  parseRun(stdout: string, lastMessageFile: string): CliRunOutput {
    void lastMessageFile;
    const segments: string[][] = [[]];
    let sessionId: string | null = null;
    let errorMessage: string | null = null;
    let sawEvent = false;
    for (const payload of events(stdout)) {
      sawEvent = true;
      const id = payload.sessionID;
      if (typeof id === "string" && id) sessionId = id;
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
    if (text) return { text, sessionId };
    if (errorMessage) return { text: errorMessage, sessionId };
    if (sawEvent) return { text: "", sessionId };
    return { text: stdout.trim(), sessionId: null };
  }

  parseModels(stdout: string): ModelCatalog {
    const ids: string[] = [];
    for (const raw of stdout.split(/\r\n|\n|\r/)) {
      const line = raw.trim();
      if (line && !ids.includes(line)) ids.push(line);
    }
    if (ids.length === 0) throw new Error("opencode model catalog is empty.");
    return new ModelCatalog(ids, null);
  }

  parseVersion(stdout: string): string | null {
    const line = (stdout.split(/\r\n|\n|\r/, 1)[0] ?? "").trim();
    const version = line.replace(/^opencode v/i, "").trim();
    return version === "" ? null : version;
  }

  createEventParser(): (line: string) => Record<string, unknown> | null {
    return (line) => {
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
    };
  }

  extractFailure(stdout: string, exitCode: number): RawFailure | null {
    // An error event followed by a retry that succeeds still counts as a failure; accepted.
    let errorMessage: string | null = null;
    for (const payload of events(stdout)) {
      if (payload.type === "error") errorMessage = errorString(payload);
    }
    if (errorMessage !== null) return { message: errorMessage, exitCode, ...quotaFromMessage(errorMessage) };
    if (exitCode === 0) return null;
    const message = this.parseRun(stdout, "").text.trim() || null;
    return { message, exitCode, ...(message === null ? {} : quotaFromMessage(message)) };
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

  readUsage(capture: UsageCapture): CliUsage {
    const steps = Array.isArray(capture.steps) ? capture.steps : [];
    const sum = (path: readonly string[]): number | null => {
      let total = 0;
      for (const step of steps) {
        const value = finite(lookup(step, path));
        if (value === null) return null;
        total += value;
      }
      return total;
    };
    return {
      values: {
        input_tokens: sum(["tokens", "input"]),
        output_tokens: sum(["tokens", "output"]),
        reasoning_tokens: sum(["tokens", "reasoning"]),
        cache_read_tokens: sum(["tokens", "cache", "read"]),
        cache_write_tokens: sum(["tokens", "cache", "write"]),
        cost_usd: sum(["cost"]),
      },
      cumulative: [],
    };
  }

  optionValuesCommand(option: string, model: string): CommandSpec | null {
    void model;
    return option === "variant" ? { argv: [this.command, "api", "model.list"] } : null;
  }

  parseOptionValues(option: string, stdout: string, model: string): readonly string[] {
    if (option !== "variant") throw new Error(`opencode does not list values for ${option}.`);
    const payload = parseJsonObject(stdout);
    if (!Array.isArray(payload?.data)) throw new Error("opencode did not report its model variants.");
    const entry = payload.data.find((item) => isRecord(item) && `${item.providerID}/${item.id}` === model);
    if (!isRecord(entry) || !Array.isArray(entry.variants)) {
      throw new Error(`opencode does not list variants for ${model}.`);
    }
    return [...new Set(entry.variants.map((item) => {
      if (!isRecord(item) || typeof item.id !== "string" || item.id.trim() === "") {
        throw new Error(`opencode returned an invalid variant for ${model}.`);
      }
      return item.id;
    }))];
  }
}
