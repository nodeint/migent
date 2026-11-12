import { randomUUID } from 'node:crypto';

import { ModelCatalog } from '../catalog.js';
import type {
  BuildCommandInput,
  CliClient,
  ClientOption,
  CliRunOutput,
  CliUsage,
  CommandSpec,
  HeadlessOption,
  RawFailure,
  UsageCapture,
} from '../types.js';
import type { NativeOptionSupport } from '../types.js';
import { classifyProviderError } from '../types.js';
import { NativeOptions } from '../utils/native-options.js';
import { parseHelpOptions } from '../utils/parse-help-options.js';
import { compact, finite, isRecord, labelOf, parseJsonObject, picked } from './json.js';

// `claude` has no models subcommand; the stream-json `initialize` control
// request answers with the model list the CLI itself offers.
/** Milliseconds per second. Adapters stay independent of the kernel, so the unit is named here. */
const MS_PER_SECOND = 1000;

const MODEL_CATALOG_REQUEST = JSON.stringify({
  type: 'control_request',
  request_id: 'migent-models',
  request: { subtype: 'initialize' },
});

const DEFAULT_PERMISSION_MODE = 'bypassPermissions';

const NATIVE = new NativeOptions({
  label: 'claude',
  reserved: [
    '--print', '--model', '--output-format', '--input-format', '--verbose', '--resume', '--session-id',
    '--continue', '--fork-session', '--help', '--version', '--worktree', '--tmux', '--teleport',
    '--from-pr', '--cloud', '--desktop', '--ide', '--remote-control', '--bg', '--background',
  ],
  policy: [{ name: 'effort', prompt: true, allowDefault: true, overridable: true }],
});

function contentBlocks(payload: Record<string, unknown>): Record<string, unknown>[] {
  const {message} = payload;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

function assistantText(payload: Record<string, unknown>): string {
  return contentBlocks(payload)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');
}

function inputString(input: unknown, ...keys: string[]): string | null {
  if (!isRecord(input)) return null;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

function toolSummary(block: Record<string, unknown>, action: string): string {
  const name = typeof block.name === 'string' && block.name ? block.name : 'tool';
  const command = inputString(block.input, 'command');
  if (command) return `command ${action}: ${compact(command)}`;
  const target = inputString(block.input, 'file_path', 'notebook_path', 'path', 'pattern', 'url');
  if (target) return `${name} ${action}: ${compact(target)}`;
  return `${name} ${action}`;
}

function toolDetails(block: Record<string, unknown>): Record<string, unknown> {
  const {name} = block;
  if (typeof name === 'string' && name) return { item_type: name };
  return {};
}

/** The message a failed `result` event carries. */
export function claudeResultError(payload: Record<string, unknown>): string | null {
  const {result} = payload;
  if (typeof result === 'string' && result.trim()) return result.trim();
  const {errors} = payload;
  if (Array.isArray(errors)) {
    const messages = errors.filter((item): item is string => typeof item === 'string' && item !== '');
    if (messages.length > 0) return messages.join('; ');
  }
  const {subtype} = payload;
  if (typeof subtype === 'string' && subtype) return `claude failed: ${subtype}`;
  return null;
}

const CLAUDE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'system', 'assistant', 'user', 'result', 'rate_limit_event', 'stream_event', 'control_request', 'control_response',
]);

export class ClaudeCodeClient implements CliClient {
  public optionsCommand(): CommandSpec {
    return { argv: [this.command, '-p', '--help'] };
  }

  public parseOptions(help: string): HeadlessOption[] {
    return parseHelpOptions(help, { section: /^Options:\s*$/, inferArgumentType: true });
  }

  public readonly effortOption = 'effort';
  public readonly id = 'claude-code';
  public readonly command = 'claude';

  public readonly nativeOptions: NativeOptionSupport = NATIVE;

  public options(): readonly ClientOption[] {
    return NATIVE.rows();
  }

  public validateOptions(options: Readonly<Record<string, string>>): void {
    NATIVE.validate(options);
  }

  public runCommand(input: BuildCommandInput): CommandSpec {
    const options = { ...input.options };
    // Execution default only: never persisted, and an explicit option wins.
    if (options.permission_mode === undefined) options.permission_mode = DEFAULT_PERMISSION_MODE;
    const argv = [
      this.command,
      '-p',
      '--model',
      input.model,
      '--output-format',
      'stream-json',
      '--verbose',
    ];
    NATIVE.append(argv, options);
    if (input.agentId) argv.push('--resume', input.agentId);
    else if (input.newAgentId) argv.push('--session-id', input.newAgentId);
    // The prompt goes on stdin; the workspace is the process cwd.
    return { argv, stdin: input.prompt };
  }

  public newSessionId(): string {
    return randomUUID();
  }

  public modelsCommand(): CommandSpec {
    return {
      argv: [
        this.command,
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
      ],
      stdin: `${MODEL_CATALOG_REQUEST}\n`,
    };
  }

  public versionCommand(): CommandSpec {
    return { argv: [this.command, '--version'] };
  }

  public parseRun(stdout: string, lastMessageFile: string): CliRunOutput {
    void lastMessageFile;
    let sessionId: string | null = null;
    let lastText: string | null = null;
    let result: { text: string | null; isError: boolean } = { text: null, isError: false };
    let sawEvent = false;
    for (const rawLine of stdout.split(/\r\n|\n|\r/)) {
      const payload = parseJsonObject(rawLine);
      if (payload === null) continue;
      sawEvent = true;
      const id = payload.session_id;
      if (typeof id === 'string' && id) sessionId = id;
      if (payload.type === 'result') {
        const outcome = resultOutcome(payload);
        result = { text: outcome.text ?? result.text, isError: outcome.isError };
      } else {
        lastText = topLevelAssistantText(payload) ?? lastText;
      }
    }
    if (result.text !== null) return { text: result.text, sessionId, source: result.isError ? 'error' : 'model' };
    if (lastText !== null) return { text: lastText, sessionId, source: 'model' };
    if (sawEvent) return { text: '', sessionId, source: 'none' };
    const raw = stdout.trim();
    return { text: raw, sessionId: null, source: raw === '' ? 'none' : 'error' };
  }

  public parseModels(stdout: string): ModelCatalog {
    const models = reportedModels(stdout);
    if (models === null) {
      const detail = compact(stdout);
      throw new Error(detail || 'claude did not report its models.');
    }
    const ids: string[] = [];
    const efforts: (readonly [string, string, readonly string[]])[] = [];
    for (const item of models) {
      if (!isRecord(item) || typeof item.value !== 'string' || item.value === 'default') continue;
      const levels = effortLevels(item.supportedEffortLevels);
      const resolved = typeof item.resolvedModel === 'string' ? item.resolvedModel : null;
      for (const id of new Set([item.value, resolved])) {
        if (id === null || ids.includes(id)) continue;
        ids.push(id);
        if (levels !== null) efforts.push([id, 'effort', levels]);
      }
    }
    return new ModelCatalog(ids, null, efforts);
  }

  public parseVersion(stdout: string): string | null {
    const line = (stdout.split(/\r\n|\n|\r/, 1)[0] ?? '').trim();
    return line === '' ? null : line;
  }

  public createEventParser(): (line: string) => Record<string, unknown> | null {
    const toolUses = new Map<string, Record<string, unknown>>();
    return (line) => {
      const payload = parseJsonObject(line);
      if (payload === null) return null;
      const eventType = payload.type;
      if (eventType === 'assistant') return toolStartedEvent(payload, toolUses);
      if (eventType === 'user') return toolCompletedEvent(payload, toolUses);
      if (eventType === 'result' && payload.is_error === true) {
        const failed = classifyProviderError(claudeResultError(payload));
        if (failed.event === 'provider.warning') return failed;
        return { event: 'provider.turn_failed', summary: failed.summary };
      }
      return null;
    };
  }

  public eventLabel(line: string): string | null {
    const payload = parseJsonObject(line);
    if (payload === null) return null;
    const type = labelOf(payload.type, CLAUDE_EVENT_TYPES);
    if (type === null) return 'other';
    if (type === 'result') return payload.is_error === true ? 'result:error' : 'result';
    if (type === 'assistant' || type === 'user') {
      const kinds = new Set(contentBlocks(payload).map((block) => block.type));
      const kind = ['tool_use', 'tool_result', 'text', 'thinking'].find((name) => kinds.has(name));
      return kind === undefined ? type : `${type}:${kind}`;
    }
    return type;
  }

  public extractFailure(stdout: string, exitCode: number): RawFailure | null {
    let rateLimit: { resetAt: string | null; window: string | null } | null = null;
    let human: string | null = null;
    let providerMessage: string | null = null;
    let sawError = false;
    for (const rawLine of stdout.split(/\r\n|\n|\r/)) {
      const payload = parseJsonObject(rawLine);
      if (payload === null) continue;
      rateLimit = rejectedRateLimit(payload) ?? rateLimit;
      human = topLevelAssistantText(payload) ?? human;
      if (payload.type === 'result' && payload.is_error === true) {
        sawError = true;
        providerMessage = claudeResultError(payload);
      }
    }
    if (rateLimit !== null) {
      return { origin: 'provider-error', message: human || providerMessage, exitCode, rateLimit };
    }
    if (sawError) return { origin: 'provider-error', message: providerMessage, exitCode };
    if (exitCode !== 0) return { origin: 'exit-only', message: providerMessage, exitCode };
    return null;
  }

  public captureUsage(stdout: string): UsageCapture | null {
    let result: Record<string, unknown> | null = null;
    for (const rawLine of stdout.split(/\r\n|\n|\r/)) {
      const payload = parseJsonObject(rawLine);
      if (payload?.type === 'result') result = payload;
    }
    if (result === null) return null;
    return {
      result: picked(result, [
        'usage',
        'total_cost_usd',
        'num_turns',
        'duration_ms',
        'duration_api_ms',
        'modelUsage',
      ]),
    };
  }

  public readUsage(capture: UsageCapture): CliUsage {
    const result = isRecord(capture.result) ? capture.result : null;
    const usage = result !== null && isRecord(result.usage) ? result.usage : null;
    const details = usage !== null && isRecord(usage.output_tokens_details) ? usage.output_tokens_details : null;
    return {
      values: {
        input_tokens: finite(usage?.input_tokens),
        output_tokens: finite(usage?.output_tokens),
        reasoning_tokens: finite(details?.thinking_tokens),
        cache_read_tokens: finite(usage?.cache_read_input_tokens),
        cache_write_tokens: finite(usage?.cache_creation_input_tokens),
        cost_usd: finite(result?.total_cost_usd),
      },
      cumulative: ['cost_usd'],
    };
  }

  public optionValuesCommand(option: string, model: string): CommandSpec | null {
    void option;
    void model;
    return null;
  }

  public parseOptionValues(option: string, stdout: string, model: string): readonly string[] {
    const values = this.parseModels(stdout).valuesFor(model, option);
    if (values === null) throw new Error(`claude does not list ${option} values for ${model}.`);
    return values;
  }
}

/** The non-empty text of an assistant event that is not a subagent's; null otherwise. */
function topLevelAssistantText(payload: Record<string, unknown>): string | null {
  if (payload.type !== 'assistant') return null;
  if (payload.parent_tool_use_id !== null && payload.parent_tool_use_id !== undefined) return null;
  const text = assistantText(payload).trim();
  return text || null;
}

/** A result event's text (null when a success carries none) and whether it reports an error. */
function resultOutcome(payload: Record<string, unknown>): { text: string | null; isError: boolean } {
  if (payload.is_error === true) return { text: claudeResultError(payload), isError: true };
  const {result} = payload;
  return { text: typeof result === 'string' && result.trim() ? result.trim() : null, isError: false };
}

/** The models list of the last control response that carries one. */
function reportedModels(stdout: string): unknown[] | null {
  let models: unknown[] | null = null;
  for (const rawLine of stdout.split(/\r\n|\n|\r/)) {
    const payload = parseJsonObject(rawLine);
    if (payload?.type !== 'control_response' || !isRecord(payload.response)) continue;
    const body = payload.response.response;
    if (isRecord(body) && Array.isArray(body.models)) models = body.models;
  }
  return models;
}

/** The string effort levels a model lists; null when it declares no list. */
function effortLevels(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((level): level is string => typeof level === 'string');
}

/** The rate limit a rejected rate-limit event reports; null for any other event. */
function rejectedRateLimit(payload: Record<string, unknown>): { resetAt: string | null; window: string | null } | null {
  if (payload.type !== 'rate_limit_event' || !isRecord(payload.rate_limit_info)) return null;
  const info = payload.rate_limit_info;
  if (info.status !== 'rejected') return null;
  const {resetsAt} = info;
  return {
    resetAt:
      typeof resetsAt === 'number' && Number.isFinite(resetsAt)
        ? new Date(resetsAt * MS_PER_SECOND).toISOString()
        : null,
    window: typeof info.rateLimitType === 'string' ? info.rateLimitType : null,
  };
}

function toolStartedEvent(
  payload: Record<string, unknown>,
  toolUses: Map<string, Record<string, unknown>>,
): Record<string, unknown> | null {
  const block = contentBlocks(payload).find((item) => item.type === 'tool_use');
  if (block === undefined) return null;
  if (typeof block.id === 'string' && block.id) toolUses.set(block.id, block);
  return {
    event: 'provider.item_started',
    summary: toolSummary(block, 'started'),
    details: toolDetails(block),
  };
}

function toolCompletedEvent(
  payload: Record<string, unknown>,
  toolUses: Map<string, Record<string, unknown>>,
): Record<string, unknown> | null {
  const block = contentBlocks(payload).find((item) => item.type === 'tool_result');
  if (block === undefined) return null;
  const id = block.tool_use_id;
  const toolUse = (typeof id === 'string' ? toolUses.get(id) : undefined) ?? {};
  const action = block.is_error === true ? 'failed' : 'completed';
  return {
    event: 'provider.item_completed',
    summary: toolSummary(toolUse, action),
    details: toolDetails(toolUse),
  };
}
