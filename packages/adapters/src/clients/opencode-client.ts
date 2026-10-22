import { classifyProviderError, providerErrorMessage } from "@nodeint/migent-kernel";
import type {
  BuildCommandInput,
  CliClient,
  CliRunOutput,
  CommandSpec,
  ProviderOption,
  RawFailure,
  UsageCapture,
} from "@nodeint/migent-kernel";
import { ModelCatalog } from "../catalog.js";
import { compact, isRecord, parseJsonObject } from "./json.js";

const OPENCODE_OPTIONS: readonly ProviderOption[] = [{ name: "agent" }, { name: "thinking" }];

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

export function lookup(source: unknown, path: readonly string[]): unknown {
  let value = source;
  for (const key of path) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return value;
}

export class OpencodeClient implements CliClient {
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
      if (key === "thinking" && value !== "true" && value !== "false") {
        throw new Error("thinking must be true or false.");
      }
    }
  }

  runCommand(input: BuildCommandInput): CommandSpec {
    // The workspace is the process cwd, so input.workspace is not passed.
    const argv = [this.command, "run", "--format", "json", "--auto", "-m", input.model];
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
    if (errorMessage !== null) return { message: errorMessage, exitCode };
    if (exitCode === 0) return null;
    return { message: this.parseRun(stdout, "").text.trim() || null, exitCode };
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
}
