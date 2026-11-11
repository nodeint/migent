import { randomUUID } from 'node:crypto';

import { ModelCatalog } from '../catalog.js';
import type {
  BuildCommandInput,
  CliClient,
  ClientOption,
  CliRunOutput,
  CliUsage,
  CommandSpec,
  RawFailure,
  UsageCapture,
} from '../types.js';
import { classifyProviderError } from '../types.js';
import { parseHelpOptions } from '../utils/parse-help-options.js';
import { compact, finite, isRecord, labelOf, parseJsonObject, picked } from './json.js';

// `claude` has no models subcommand; the stream-json `initialize` control
// request answers with the model list the CLI itself offers.
const MODEL_CATALOG_REQUEST = JSON.stringify({
  type: 'control_request',
  request_id: 'migent-models',
  request: { subtype: 'initialize' },
});

export const CLAUDE_PERMISSION_MODES = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan',
] as const;

const DEFAULT_PERMISSION_MODE = 'bypassPermissions';

const CLAUDE_OPTIONS: readonly ClientOption[] = [
  { name: 'effort', prompt: true, allowDefault: true, overridable: true },
  { name: 'permission_mode' },
  { name: 'tools' },
  { name: 'allowed_tools' },
  { name: 'disallowed_tools' },
  { name: 'max_budget_usd' },
  { name: 'fallback_model' },
  { name: 'append_system_prompt' },
];

function oneOf(value: string, allowed: readonly string[], field: string): void {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}.`);
  }
}

function claudeBudget(value: string): void {
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(value) || Number(value) <= 0) {
    throw new Error('max_budget_usd must be a positive number.');
  }
}

function claudeText(value: string): void {
  void value;
}

const CLAUDE_OPTION_CHECKS: Record<string, (value: string) => void> = {
  effort: claudeText,
  permission_mode: (value) => oneOf(value, CLAUDE_PERMISSION_MODES, 'permission_mode'),
  tools: claudeText,
  allowed_tools: claudeText,
  disallowed_tools: claudeText,
  max_budget_usd: claudeBudget,
  fallback_model: claudeText,
  append_system_prompt: claudeText,
};

function appendOptions(argv: string[], options: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(options)) {
    argv.push(`--${key.replaceAll('_', '-')}`, value);
  }
}

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

  public parseOptions(help: string) {
    return parseHelpOptions(help, { section: /^Options:\s*$/, inferArgumentType: true });
  }

  public readonly effortOption = 'effort';
  public readonly id = 'claude-code';
  public readonly command = 'claude';

  public options(): readonly ClientOption[] {
    return CLAUDE_OPTIONS;
  }

  public validateOptions(options: Readonly<Record<string, string>>): void {
    for (const [key, value] of Object.entries(options)) {
      const check = CLAUDE_OPTION_CHECKS[key];
      if (check === undefined) throw new Error(`${key} is not a claude option.`);
      if (value.trim() === '') throw new Error(`${key} is empty.`);
      check(value);
    }
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
    appendOptions(argv, options);
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
    let resultText: string | null = null;
    let resultIsError = false;
    let sawEvent = false;
    for (const rawLine of stdout.split(/\r\n|\n|\r/)) {
      const payload = parseJsonObject(rawLine);
      if (payload === null) continue;
      sawEvent = true;
      const id = payload.session_id;
      if (typeof id === 'string' && id) sessionId = id;
      const eventType = payload.type;
      if (eventType === 'assistant' && (payload.parent_tool_use_id === null || payload.parent_tool_use_id === undefined)) {
        const text = assistantText(payload).trim();
        if (text) lastText = text;
      } else if (eventType === 'result') {
        if (payload.is_error === true) {
          resultText = claudeResultError(payload);
          resultIsError = true;
        } else {
          const {result} = payload;
          if (typeof result === 'string' && result.trim()) resultText = result.trim();
          resultIsError = false;
        }
      }
    }
    if (resultText !== null) return { text: resultText, sessionId, source: resultIsError ? 'error' : 'model' };
    if (lastText !== null) return { text: lastText, sessionId, source: 'model' };
    if (sawEvent) return { text: '', sessionId, source: 'none' };
    const raw = stdout.trim();
    return { text: raw, sessionId: null, source: raw === '' ? 'none' : 'error' };
  }

  public parseModels(stdout: string): ModelCatalog {
    let models: unknown[] | null = null;
    for (const rawLine of stdout.split(/\r\n|\n|\r/)) {
      const payload = parseJsonObject(rawLine);
      if (payload?.type !== 'control_response' || !isRecord(payload.response)) continue;
      const body = payload.response.response;
      if (isRecord(body) && Array.isArray(body.models)) models = body.models;
    }
    if (models === null) {
      const detail = compact(stdout);
      throw new Error(detail || 'claude did not report its models.');
    }
    const ids: string[] = [];
    const efforts: (readonly [string, string, readonly string[]])[] = [];
    for (const item of models) {
      if (!isRecord(item) || typeof item.value !== 'string' || item.value === 'default') continue;
      const levels = Array.isArray(item.supportedEffortLevels)
        ? item.supportedEffortLevels.filter((level): level is string => typeof level === 'string')
        : [];
      const resolved = typeof item.resolvedModel === 'string' ? item.resolvedModel : null;
      for (const id of new Set([item.value, resolved])) {
        if (id === null || ids.includes(id)) continue;
        ids.push(id);
        if (Array.isArray(item.supportedEffortLevels)) efforts.push([id, 'effort', levels]);
      }
    }
    return new ModelCatalog(ids, null, efforts);
  }

  public parseVersion(stdout: string): string | null {
    const line = (stdout.split(/\r\n|\n|\r/, 1)[0] ?? '').trim();
    return line === '' ? null : line;
  }

  public createEventParser(): (line: string) => Record<string, unknown> | null {
    const toolUses: Record<string, Record<string, unknown>> = {};
    return (line) => {
      const payload = parseJsonObject(line);
      if (payload === null) return null;
      const eventType = payload.type;
      if (eventType === 'assistant') {
        const block = contentBlocks(payload).find((item) => item.type === 'tool_use');
        if (block === undefined) return null;
        if (typeof block.id === 'string' && block.id) toolUses[block.id] = block;
        return {
          event: 'provider.item_started',
          summary: toolSummary(block, 'started'),
          details: toolDetails(block),
        };
      }
      if (eventType === 'user') {
        const block = contentBlocks(payload).find((item) => item.type === 'tool_result');
        if (block === undefined) return null;
        const id = block.tool_use_id;
        const toolUse = (typeof id === 'string' ? toolUses[id] : undefined) ?? {};
        const action = block.is_error === true ? 'failed' : 'completed';
        return {
          event: 'provider.item_completed',
          summary: toolSummary(toolUse, action),
          details: toolDetails(toolUse),
        };
      }
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
      if (payload.type === 'rate_limit_event' && isRecord(payload.rate_limit_info)) {
        const info = payload.rate_limit_info;
        if (info.status === 'rejected') {
          const {resetsAt} = info;
          rateLimit = {
            resetAt:
              typeof resetsAt === 'number' && Number.isFinite(resetsAt)
                ? new Date(resetsAt * 1000).toISOString()
                : null,
            window: typeof info.rateLimitType === 'string' ? info.rateLimitType : null,
          };
        }
      }
      if (payload.type === 'assistant' && (payload.parent_tool_use_id === null || payload.parent_tool_use_id === undefined)) {
        const text = assistantText(payload).trim();
        if (text) human = text;
      }
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
