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
import { classifyProviderError, providerErrorMessage } from '../types.js';
import { parseHelpOptions } from '../utils/parse-help-options.js';
import { compact, finite, isRecord, labelOf, parseJsonObject, picked } from './json.js';

const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
  'plan',
] as const;
const GROK_FLAGS: Record<string, string> = {};
export const GROK_REASONING_OPTION = 'reasoning-effort';
const GROK_EFFORT_PROBE = 'migent-probe';
const GROK_EFFORTS = /use one of: ([^\n]+)/;

function stripDots(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '.') start += 1;
  while (end > start && value[end - 1] === '.') end -= 1;
  return value.slice(start, end);
}

const GROK_OPTIONS: readonly ClientOption[] = [
  { name: GROK_REASONING_OPTION, prompt: true, allowDefault: true, overridable: true },
  { name: 'max_turns' },
  { name: 'tools' },
  { name: 'disallowed_tools' },
  { name: 'permission_mode' },
  { name: 'rules' },
  { name: 'allow' },
  { name: 'deny' },
  { name: 'sandbox' },
];

function oneOf(value: string, allowed: readonly string[], field: string): void {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}.`);
  }
}

function grokMaxTurns(value: string): void {
  if (!/^[0-9]+$/.test(value) || Number(value) < 1) {
    throw new Error('max_turns must be an integer of at least 1.');
  }
}

function grokText(value: string): void {
  void value;
}

const GROK_OPTION_CHECKS: Record<string, (value: string) => void> = {
  'reasoning-effort': grokText,
  max_turns: grokMaxTurns,
  tools: grokText,
  disallowed_tools: grokText,
  permission_mode: (value) => oneOf(value, PERMISSION_MODES, 'permission_mode'),
  rules: grokText,
  allow: grokText,
  deny: grokText,
  sandbox: grokText,
};

function appendOptions(argv: string[], options: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(options)) {
    const flag = GROK_FLAGS[key] ?? key.replaceAll('_', '-');
    argv.push(`--${flag}`, value);
  }
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
  let lastNonempty = '';
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const text = (segments[index] ?? []).join('').trim();
    if (!text) continue;
    if (!lastNonempty) lastNonempty = text;
    const trimmed = trimToStatusHeader(text);
    if (hasStatusHeader(trimmed)) return trimmed;
  }
  if (lastNonempty) return trimToStatusHeader(lastNonempty);
  return '';
}

function toolNameOf(payload: Record<string, unknown>): string {
  for (const key of ['toolName', 'title', 'kind']) {
    const value = payload[key];
    if (typeof value === 'string' && value) return value;
  }
  return 'tool';
}

function inputString(rawInput: unknown, ...keys: string[]): string | null {
  if (!isRecord(rawInput)) return null;
  for (const key of keys) {
    const value = rawInput[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

function toolSummary(payload: Record<string, unknown>, action: string): string {
  const command = inputString(payload.rawInput, 'command', 'cmd');
  if (command) return `command ${action}: ${compact(command)}`;
  const path = inputString(payload.rawInput, 'path', 'target_file');
  const name = toolNameOf(payload);
  if (path) return `${name} ${action}: ${compact(path)}`;
  return `${name} ${action}`;
}

function toolDetails(payload: Record<string, unknown>): Record<string, unknown> {
  const {toolName} = payload;
  if (typeof toolName === 'string' && toolName) return { item_type: toolName };
  return {};
}

const GROK_EVENT_TYPES: ReadonlySet<string> = new Set([
  'text', 'thought', 'message', 'messages_changed', 'tool_call', 'tool_call_update', 'usage', 'end', 'error',
]);

export class GrokClient implements CliClient {
  public optionsCommand(): CommandSpec {
    return { argv: [this.command, '-p', 'x', '--help'] };
  }

  public parseOptions(help: string): HeadlessOption[] {
    return parseHelpOptions(help, { section: /^Options:\s*$/, inferArgumentType: true });
  }

  public readonly effortOption = GROK_REASONING_OPTION;
  public readonly id = 'grok';
  public readonly command = 'grok';

  public options(): readonly ClientOption[] {
    return GROK_OPTIONS;
  }

  public validateOptions(options: Readonly<Record<string, string>>): void {
    for (const [key, value] of Object.entries(options)) {
      const check = GROK_OPTION_CHECKS[key];
      if (check === undefined) throw new Error(`${key} is not a grok option.`);
      if (value.trim() === '') throw new Error(`${key} is empty.`);
      check(value);
    }
  }

  public runCommand(input: BuildCommandInput): CommandSpec {
    const argv = [
      this.command,
      '--prompt-file',
      input.promptFile,
      '-m',
      input.model,
      '--cwd',
      input.workspace,
      '--output-format',
      'streaming-json',
      '--always-approve',
      '--verbatim',
    ];
    appendOptions(argv, input.options);
    if (input.agentId) argv.push('--resume', input.agentId);
    else if (input.newAgentId) argv.push('--session-id', input.newAgentId);
    return { argv };
  }

  public modelsCommand(): CommandSpec {
    return { argv: [this.command, 'models'] };
  }

  public versionCommand(): CommandSpec {
    return { argv: [this.command, '--version'] };
  }

  public parseRun(stdout: string, lastMessageFile: string): CliRunOutput {
    void lastMessageFile;
    const segments: string[][] = [[]];
    let sessionId: string | null = null;
    let errorMessage: string | null = null;
    let sawEvent = false;
    for (const rawLine of stdout.split(/\r\n|\n|\r/)) {
      const payload = parseJsonObject(rawLine);
      if (payload === null) continue;
      sawEvent = true;
      const eventType = payload.type;
      if (
        eventType === 'tool_call' ||
        (eventType === 'tool_call_update' &&
          (payload.status === 'completed' || payload.status === 'failed'))
      ) {
        if (segments[segments.length - 1]?.length) segments.push([]);
      } else if (eventType === 'text') {
        const {data} = payload;
        if (typeof data === 'string' && data) segments[segments.length - 1]?.push(data);
      } else if (eventType === 'end') {
        const id = payload.sessionId;
        if (typeof id === 'string' && id) sessionId = id;
      } else if (eventType === 'error') {
        const {message} = payload;
        if (typeof message === 'string' && message) errorMessage = message;
      }
    }
    const text = textWithStatusHeader(segments);
    if (text) return { text, sessionId, source: 'model' };
    if (errorMessage) return { text: errorMessage, sessionId, source: 'error' };
    if (sawEvent) return { text: '', sessionId, source: 'none' };
    const raw = stdout.trim();
    return { text: raw, sessionId: null, source: raw === '' ? 'none' : 'error' };
  }

  public parseModels(stdout: string): ModelCatalog {
    const ids: string[] = [];
    let defaultId: string | null = null;
    let inList = false;
    for (const raw of stdout.split(/\r\n|\n|\r/)) {
      const line = raw.trim();
      if (line.toLowerCase().startsWith('default model:')) {
        defaultId = line.split(':').slice(1).join(':').trim();
        continue;
      }
      if (line.toLowerCase().startsWith('available models')) {
        inList = true;
        continue;
      }
      if (!inList || (!line.startsWith('*') && !line.startsWith('-'))) continue;
      const name = line.slice(1).trim().split(/\s+/)[0] ?? '';
      if (name && !ids.includes(name)) ids.push(name);
      if (line.includes('(default)')) defaultId = name;
    }
    if (ids.length === 0) throw new Error('grok model catalog is empty.');
    if (defaultId === null || !ids.includes(defaultId)) defaultId = null;
    return new ModelCatalog(ids, defaultId);
  }

  public parseVersion(stdout: string): string | null {
    const line = (stdout.split(/\r\n|\n|\r/, 1)[0] ?? '').trim();
    return line === '' ? null : line;
  }

  public createEventParser(): (line: string) => Record<string, unknown> | null {
    const toolCalls: Record<string, Record<string, unknown>> = {};
    return (line) => {
      const payload = parseJsonObject(line);
      if (payload === null) return null;
      const eventType = payload.type;
      if (eventType === 'tool_call') {
        const {toolCallId} = payload;
        if (typeof toolCallId === 'string' && toolCallId) toolCalls[toolCallId] = payload;
        return {
          event: 'provider.item_started',
          summary: toolSummary(payload, 'started'),
          details: toolDetails(payload),
        };
      }
      if (eventType === 'tool_call_update') {
        const {status} = payload;
        if (status !== 'completed' && status !== 'failed') return null;
        const {toolCallId} = payload;
        const remembered = typeof toolCallId === 'string' ? (toolCalls[toolCallId] ?? {}) : {};
        const merged = { ...remembered, ...payload };
        const action = status === 'failed' ? 'failed' : 'completed';
        return {
          event: 'provider.item_completed',
          summary: toolSummary(merged, action),
          details: toolDetails(merged),
        };
      }
      if (eventType === 'error') return classifyProviderError(providerErrorMessage(payload));
      return null;
    };
  }

  public eventLabel(line: string): string | null {
    const payload = parseJsonObject(line);
    if (payload === null) return null;
    return labelOf(payload.type, GROK_EVENT_TYPES) ?? 'other';
  }

  public extractFailure(stdout: string, exitCode: number): RawFailure | null {
    let errorMessage: string | null = null;
    for (const rawLine of stdout.split(/\r\n|\n|\r/)) {
      const payload = parseJsonObject(rawLine);
      if (payload?.type !== 'error') continue;
      if (exitCode === 0 && classifyProviderError(providerErrorMessage(payload)).event === 'provider.warning') continue;
      const {message} = payload;
      errorMessage = typeof message === 'string' && message ? message : (errorMessage ?? 'grok reported an error.');
    }
    if (errorMessage !== null) return { origin: 'provider-error', message: errorMessage.trim() || null, exitCode };
    if (exitCode === 0) return null;
    const text = this.parseRun(stdout, '').text.trim();
    return { origin: 'exit-only', message: text || null, exitCode };
  }

  public captureUsage(stdout: string): UsageCapture | null {
    let end: Record<string, unknown> | null = null;
    let usageEvent: Record<string, unknown> | null = null;
    for (const rawLine of stdout.split(/\r\n|\n|\r/)) {
      const payload = parseJsonObject(rawLine);
      if (payload === null) continue;
      if (payload.type === 'end') end = payload;
      else if (payload.type === 'usage' && isRecord(payload.usage)) usageEvent = payload.usage;
    }
    if (end) return { end: picked(end, ['usage', 'total_cost_usd', 'num_turns']) };
    if (usageEvent) return { usage_event: usageEvent };
    return null;
  }

  public readUsage(capture: UsageCapture): CliUsage {
    const end = isRecord(capture.end) ? capture.end : null;
    const usageSource = end !== null ? end.usage : capture.usage_event;
    const usage = isRecord(usageSource) ? usageSource : null;
    return {
      values: {
        input_tokens: finite(usage?.input_tokens),
        output_tokens: finite(usage?.output_tokens),
        reasoning_tokens: finite(usage?.reasoning_tokens),
        cache_read_tokens: finite(usage?.cache_read_input_tokens),
        cache_write_tokens: finite(usage?.cache_creation_input_tokens),
        cost_usd: finite(end?.total_cost_usd),
      },
      cumulative: [],
    };
  }

  /** Grok lists the accepted efforts only in the error it prints for a bad one. */
  public optionValuesCommand(option: string, model: string): CommandSpec | null {
    if (option !== GROK_REASONING_OPTION) return null;
    return {
      argv: [
        this.command,
        '-m',
        model,
        '--reasoning-effort',
        GROK_EFFORT_PROBE,
        '-p',
        'x',
        '--output-format',
        'plain',
      ],
    };
  }

  public parseOptionValues(option: string, stdout: string, model: string): readonly string[] {
    void model;
    if (option !== GROK_REASONING_OPTION) throw new Error(`grok does not list values for ${option}.`);
    const match = GROK_EFFORTS.exec(stdout);
    if (match === null) {
      const detail = stdout.split(/\s+/).filter((part) => part !== '').join(' ');
      throw new Error(detail || 'grok did not list reasoning-effort values.');
    }
    const values: string[] = [];
    for (const part of (match[1] ?? '').split(',')) {
      const value = stripDots(part.trim());
      if (value && !values.includes(value)) values.push(value);
    }
    if (values.length === 0) throw new Error('grok did not list reasoning-effort values.');
    return values;
  }
}
