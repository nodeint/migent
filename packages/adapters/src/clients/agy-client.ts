import { classifyProviderError } from "@nodeint/migent-kernel";
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
import { compact, isRecord, parseJsonObject, picked } from "./json.js";

// `agy models` lists slugs, not effort levels. `--help` fixes the enum.
export const AGY_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const AGY_MODES = ["accept-edits", "auto", "plan"] as const;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const AGY_OPTIONS: readonly ProviderOption[] = [
  { name: "effort", prompt: true, allowDefault: true, overridable: true },
  { name: "mode" },
  { name: "agent" },
  { name: "sandbox" },
  { name: "skip_permissions" },
];

function oneOf(value: string, allowed: readonly string[], field: string): void {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of: ${allowed.join(", ")}.`);
  }
}

function agyBool(value: string, field: string): void {
  if (value !== "true" && value !== "false") {
    throw new Error(`${field} must be true or false.`);
  }
}

function agyText(value: string): void {
  void value;
}

const AGY_OPTION_CHECKS: Record<string, (value: string) => void> = {
  effort: (value) => oneOf(value, AGY_EFFORTS, "effort"),
  mode: (value) => oneOf(value, AGY_MODES, "mode"),
  agent: agyText,
  sandbox: (value) => agyBool(value, "sandbox"),
  skip_permissions: (value) => agyBool(value, "skip_permissions"),
};

function modelId(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.toLowerCase().startsWith("fetching ")) return null;
  let candidate = trimmed;
  const tab = trimmed.indexOf("\t");
  if (tab !== -1) {
    candidate = trimmed.slice(0, tab).trim();
  } else {
    const spaced = / {2,}/.exec(trimmed);
    if (spaced !== null && spaced.index > 0) candidate = trimmed.slice(0, spaced.index).trim();
    else if (/\s/.test(trimmed)) return null;
  }
  return MODEL_ID.test(candidate) ? candidate : null;
}

function conversationId(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function resultBody(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (payload.event === "result" && isRecord(payload.result)) return payload.result;
  if (payload.event === undefined && typeof payload.status === "string" && "response" in payload) {
    return payload;
  }
  return null;
}

function failureText(result: Record<string, unknown>): string {
  const error = result.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  const response = result.response;
  if (typeof response === "string" && response.trim()) return response.trim();
  const status = result.status;
  return typeof status === "string" && status ? `agy failed: ${status}` : "agy failed.";
}

function toolInfo(step: Record<string, unknown>): Record<string, unknown> {
  return isRecord(step.tool_info) ? step.tool_info : {};
}

function toolName(step: Record<string, unknown>): string {
  if (typeof step.tool_name === "string" && step.tool_name) return step.tool_name;
  const name = toolInfo(step).name;
  if (typeof name === "string" && name) return name;
  return "tool";
}

function parameterString(parameters: unknown, ...keys: string[]): string | null {
  if (!isRecord(parameters)) return null;
  for (const key of keys) {
    const value = parameters[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function toolSummary(step: Record<string, unknown>, action: string): string {
  const parameters = toolInfo(step).parameters;
  const command = parameterString(parameters, "CommandLine", "command", "cmd");
  if (command) return `command ${action}: ${compact(command)}`;
  const target = parameterString(
    parameters,
    "path",
    "file_path",
    "TargetFile",
    "target_file",
    "absolute_path",
    "pattern",
    "url",
    "query",
  );
  const name = toolName(step);
  if (target) return `${name} ${action}: ${compact(target)}`;
  return `${name} ${action}`;
}

function toolDetails(step: Record<string, unknown>): Record<string, unknown> {
  const name = toolName(step);
  return name === "tool" ? {} : { item_type: name };
}

function isToolStep(step: Record<string, unknown>): boolean {
  if (step.step_type === "tool") return true;
  if (typeof step.tool_name === "string" && step.tool_name) return true;
  return isRecord(step.tool_info);
}

function toolFailed(step: Record<string, unknown>): boolean {
  const error = toolInfo(step).error;
  if (error == null || error === false) return false;
  if (typeof error === "string") return error.trim() !== "";
  return true;
}

function stepKey(step: Record<string, unknown>): string | null {
  const index = step.step_index;
  if (typeof index === "number" && Number.isInteger(index)) return String(index);
  return null;
}

export class AgyClient implements CliClient {
  readonly id = "agy";
  readonly command = "agy";

  options(): readonly ProviderOption[] {
    return AGY_OPTIONS;
  }

  validateOptions(options: Readonly<Record<string, string>>): void {
    for (const [key, value] of Object.entries(options)) {
      const check = AGY_OPTION_CHECKS[key];
      if (check === undefined) throw new Error(`${key} is not an agy option.`);
      if (value.trim() === "") throw new Error(`${key} is empty.`);
      check(value);
    }
  }

  runCommand(input: BuildCommandInput): CommandSpec {
    const argv = [
      this.command,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--model",
      input.model,
      "--add-dir",
      input.workspace,
      "--disable-slash-commands",
    ];
    // `agy -p` takes the prompt as a flag value and does not read stdin.
    // One stream-json user message keeps a long prompt off argv.
    if (input.options.skip_permissions !== "false") argv.push("--dangerously-skip-permissions");
    if (input.options.effort) argv.push("--effort", input.options.effort);
    if (input.options.mode) argv.push("--mode", input.options.mode);
    if (input.options.agent) argv.push("--agent", input.options.agent);
    if (input.options.sandbox === "true") argv.push("--sandbox");
    if (input.agentId) argv.push("--conversation", input.agentId);
    const stdin = `${JSON.stringify({ event: "user", message: { content: input.prompt } })}\n`;
    return { argv, stdin };
  }

  modelsCommand(): CommandSpec {
    return { argv: [this.command, "models"] };
  }

  versionCommand(): CommandSpec {
    return { argv: [this.command, "--version"] };
  }

  parseRun(stdout: string, lastMessageFile: string): CliRunOutput {
    void lastMessageFile;
    let sessionId: string | null = null;
    let text: string | null = null;
    let sawEvent = false;
    for (const rawLine of stdout.split(/\r\n|\n|\r/)) {
      const payload = parseJsonObject(rawLine);
      if (payload === null) continue;
      sawEvent = true;
      const topLevelId = conversationId(payload.conversation_id);
      if (topLevelId) sessionId = topLevelId;
      const result = resultBody(payload);
      if (result === null) continue;
      const resultId = conversationId(result.conversation_id);
      if (resultId) sessionId = resultId;
      if (result.status === "SUCCESS") {
        const response = result.response;
        text = typeof response === "string" ? response.trim() : "";
      } else {
        text = failureText(result);
      }
    }
    if (text !== null) return { text, sessionId };
    if (sawEvent) return { text: "", sessionId };
    return { text: stdout.trim(), sessionId: null };
  }

  parseModels(stdout: string): ModelCatalog {
    const ids: string[] = [];
    for (const raw of stdout.split(/\r\n|\n|\r/)) {
      const id = modelId(raw);
      if (id && !ids.includes(id)) ids.push(id);
    }
    if (ids.length === 0) throw new Error("agy model catalog is empty.");
    return new ModelCatalog(
      ids,
      null,
      ids.map((model) => [model, "effort", AGY_EFFORTS] as const),
    );
  }

  parseVersion(stdout: string): string | null {
    const line = (stdout.split(/\r\n|\n|\r/, 1)[0] ?? "").trim();
    return line === "" ? null : line;
  }

  createEventParser(): (line: string) => Record<string, unknown> | null {
    const toolSteps: Record<string, Record<string, unknown>> = {};
    return (line) => {
      const payload = parseJsonObject(line);
      if (payload === null) return null;
      if (payload.event === "step_update" && isRecord(payload.step_update)) {
        const step = payload.step_update;
        if (!isToolStep(step)) return null;
        const state = typeof step.state === "string" ? step.state.toUpperCase() : "";
        const key = stepKey(step);
        if (state === "ACTIVE") {
          if (key) toolSteps[key] = step;
          return {
            event: "provider.item_started",
            summary: toolSummary(step, "started"),
            details: toolDetails(step),
          };
        }
        if (state === "DONE" || state === "FAILED" || state === "ERROR") {
          const remembered = key ? toolSteps[key] : undefined;
          const merged = remembered ? { ...remembered, ...step } : step;
          if (remembered && !isRecord(toolInfo(step).parameters) && isRecord(toolInfo(remembered).parameters)) {
            merged.tool_info = { ...toolInfo(remembered), ...toolInfo(step) };
          }
          const action = toolFailed(merged) || state === "FAILED" || state === "ERROR" ? "failed" : "completed";
          return {
            event: "provider.item_completed",
            summary: toolSummary(merged, action),
            details: toolDetails(merged),
          };
        }
        return null;
      }
      if (payload.event === "result") {
        const result = resultBody(payload);
        if (result === null || result.status === "SUCCESS") return null;
        const failed = classifyProviderError(failureText(result));
        if (failed.event === "provider.warning") return failed;
        return { event: "provider.turn_failed", summary: failed.summary };
      }
      return null;
    };
  }

  extractFailure(stdout: string, exitCode: number): RawFailure | null {
    if (exitCode === 0) return null;
    const text = this.parseRun(stdout, "").text.trim();
    return { message: text || null, exitCode };
  }

  captureUsage(stdout: string): UsageCapture | null {
    let result: Record<string, unknown> | null = null;
    const steps: Record<string, unknown>[] = [];
    for (const rawLine of stdout.split(/\r\n|\n|\r/)) {
      const payload = parseJsonObject(rawLine);
      if (payload === null) continue;
      if (payload.event === "result" && isRecord(payload.result)) result = payload.result;
      if (payload.event !== "step_update" || !isRecord(payload.step_update)) continue;
      const step = payload.step_update;
      const state = step.state;
      if (typeof state === "string" && state.toUpperCase() === "DONE" && isRecord(step.usage)) steps.push(step.usage);
    }
    if (result === null && steps.length === 0) return null;
    const capture: UsageCapture = { steps };
    if (result) capture.result = picked(result, ["usage", "num_turns", "duration_seconds"]);
    return capture;
  }
}
