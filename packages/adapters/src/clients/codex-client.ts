import { ModelCatalog } from '../catalog.js';
import { readExistingText } from '../read-text.js';
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
import { classifyProviderError, providerErrorMessage } from '../types.js';
import { parseHelpOptions } from '../utils/parse-help-options.js';
import { compact, finite, isRecord, labelOf, parseJsonObject } from './json.js';

const OPTION_KEY = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const TOML_BARE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$|^true$|^false$/;
const CODEX_CONFIG_KEYS: Record<string, string> = {};

function reasoningLevels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const values: string[] = [];
  for (const level of raw) {
    let effort: unknown;
    if (isRecord(level)) effort = level.effort;
    else if (typeof level === 'string') effort = level;
    else continue;
    if (typeof effort === 'string' && effort && !values.includes(effort)) values.push(effort);
  }
  return values;
}

function tomlLiteral(value: string): string {
  if (TOML_BARE.test(value)) return value;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function appendOptions(argv: string[], options: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(options)) {
    const configKey = CODEX_CONFIG_KEYS[key] ?? key;
    argv.push('-c', `${configKey}=${tomlLiteral(value)}`);
  }
}

function itemSummary(item: unknown, itemType: unknown, action: string): string {
  if (isRecord(item) && itemType === 'command_execution') {
    const {command} = item;
    if (typeof command === 'string' && command) return `command ${action}: ${compact(command)}`;
  }
  if (isRecord(item) && itemType === 'agent_message') {
    const {text} = item;
    if (typeof text === 'string' && text) return `agent: ${compact(text)}`;
  }
  const label = typeof itemType === 'string' && itemType ? itemType : 'provider item';
  return `${label} ${action}`;
}

export const CODEX_REASONING_OPTION = 'model_reasoning_effort';

const CODEX_EVENT_TYPES: ReadonlySet<string> = new Set([
  'thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'item.started', 'item.updated', 'item.completed', 'error',
]);
const CODEX_ITEM_TYPES: ReadonlySet<string> = new Set([
  'agent_message', 'reasoning', 'command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list', 'error',
]);

export class CodexClient implements CliClient {
  public optionsCommand(): CommandSpec {
    return { argv: [this.command, 'exec', '--help'] };
  }

  public parseOptions(help: string) {
    return parseHelpOptions(help, { section: /^Options:\s*$/, inferArgumentType: true });
  }

  public readonly effortOption = 'model_reasoning_effort';
  public readonly id = 'codex';
  public readonly command = 'codex';

  public options(): readonly ClientOption[] {
    return [{ name: CODEX_REASONING_OPTION, prompt: true, allowDefault: true, overridable: true }];
  }

  public validateOptions(options: Readonly<Record<string, string>>): void {
    for (const [key, value] of Object.entries(options)) {
      if (!OPTION_KEY.test(key)) throw new Error(`${key} is not a codex option.`);
      if (value.trim() === '') throw new Error(`${key} is empty.`);
    }
  }

  public runCommand(input: BuildCommandInput): CommandSpec {
    const argv = [
      this.command,
      'exec',
      '-C',
      input.workspace,
      '-m',
      input.model,
      '--color',
      'never',
      '--json',
      '--output-last-message',
      input.lastMessageFile,
    ];
    appendOptions(argv, input.options);
    if (input.agentId) {
      argv.push('resume', input.agentId, '-');
    } else {
      // `--approve-for-me` already selects the workspace-write sandbox.
      argv.push('--approve-for-me', '-');
    }
    return { argv, stdin: input.prompt };
  }

  public modelsCommand(): CommandSpec {
    return { argv: [this.command, 'debug', 'models'] };
  }

  public versionCommand(): CommandSpec {
    return { argv: [this.command, '--version'] };
  }

  public parseRun(stdout: string, lastMessageFile: string): CliRunOutput {
    let sessionId: string | null = null;
    let lastText: string | null = null;
    let lastSource: CliRunOutput['source'] = 'none';
    for (const rawLine of stdout.split(/\r\n|\n|\r/)) {
      const event = parseJsonObject(rawLine);
      if (event === null) continue;
      const eventType = event.type;
      if (eventType === 'thread.started') {
        const threadId = event.thread_id;
        if (typeof threadId === 'string' && threadId) sessionId = threadId;
      } else if (eventType === 'item.completed') {
        const {item} = event;
        if (isRecord(item) && item.type === 'agent_message') {
          const {text} = item;
          if (typeof text === 'string' && text) {
            lastText = text;
            lastSource = 'model';
          }
        }
      } else if (eventType === 'turn.failed') {
        const {error} = event;
        const message = isRecord(error) ? error.message : undefined;
        if (typeof message === 'string' && message) {
          lastText = message;
          lastSource = 'error';
        }
      } else if (eventType === 'error') {
        const {message} = event;
        if (typeof message === 'string' && message) {
          lastText = message;
          lastSource = 'error';
        }
      }
    }
    const fileText = readExistingText(lastMessageFile);
    if (fileText !== null) {
      const stripped = fileText.trim();
      if (stripped) {
        lastText = stripped;
        lastSource = 'model';
      }
    }
    if (lastText !== null) return { text: lastText, sessionId, source: lastSource };
    const raw = stdout.trim();
    return { text: raw, sessionId, source: raw === '' ? 'none' : 'error' };
  }

  public parseModels(stdout: string): ModelCatalog {
    let payload: unknown;
    try {
      payload = JSON.parse(stdout);
    } catch {
      throw new Error('codex model catalog is not JSON.');
    }
    const models = isRecord(payload) ? payload.models : null;
    if (!Array.isArray(models)) throw new Error('codex model catalog has no models.');
    const ids: string[] = [];
    const optionValues: (readonly [string, string, readonly string[]])[] = [];
    for (const item of models) {
      if (!isRecord(item)) continue;
      const {visibility} = item;
      if (visibility !== undefined && visibility !== null && visibility !== 'list') continue;
      const {slug} = item;
      if (typeof slug === 'string' && slug && !ids.includes(slug)) {
        ids.push(slug);
        if (Array.isArray(item.supported_reasoning_levels)) {
          optionValues.push([slug, CODEX_REASONING_OPTION, reasoningLevels(item.supported_reasoning_levels)]);
        }
      }
    }
    if (ids.length === 0) throw new Error('codex model catalog is empty.');
    return new ModelCatalog(ids, null, optionValues);
  }

  public parseVersion(stdout: string): string | null {
    const line = (stdout.split(/\r\n|\n|\r/, 1)[0] ?? '').trim();
    return line === '' ? null : line;
  }

  public createEventParser(): (line: string) => Record<string, unknown> | null {
    return (line) => {
      const payload = parseJsonObject(line);
      if (payload === null) return null;
      const eventType = payload.type;
      if (typeof eventType !== 'string') return null;
      if (eventType === 'item.started' || eventType === 'item.completed') {
        const {item} = payload;
        const itemType = isRecord(item) ? item.type : undefined;
        const action = eventType.endsWith('started') ? 'started' : 'completed';
        return {
          event: eventType.endsWith('started') ? 'provider.item_started' : 'provider.item_completed',
          summary: itemSummary(item, itemType, action),
          details: typeof itemType === 'string' ? { item_type: itemType } : {},
        };
      }
      if (eventType === 'turn.failed') {
        const failed = classifyProviderError(providerErrorMessage(payload));
        if (failed.event === 'provider.warning') return failed;
        return { event: 'provider.turn_failed', summary: failed.summary };
      }
      if (eventType === 'error') return classifyProviderError(providerErrorMessage(payload));
      return null;
    };
  }

  public eventLabel(line: string): string | null {
    const payload = parseJsonObject(line);
    if (payload === null) return null;
    const type = labelOf(payload.type, CODEX_EVENT_TYPES);
    if (type === null) return 'other';
    if (type === 'item.started' || type === 'item.completed') {
      const item = labelOf(isRecord(payload.item) ? payload.item.type : undefined, CODEX_ITEM_TYPES);
      return item === null ? type : `${type}:${item}`;
    }
    return type;
  }

  public extractFailure(stdout: string, exitCode: number): RawFailure | null {
    // `turn.failed` and `error` events are the CLI's own error report, even when model text exists too.
    let reported: string | null = null;
    for (const rawLine of stdout.split(/\r\n|\n|\r/)) {
      const event = parseJsonObject(rawLine);
      if (event === null) continue;
      if (event.type === 'turn.failed') {
        const {error} = event;
        const message = isRecord(error) ? error.message : undefined;
        reported = typeof message === 'string' && message ? message : (reported ?? '');
      } else if (event.type === 'error') {
        const {message} = event;
        // A control-plane warning is not a failed run.
        if (exitCode === 0 && classifyProviderError(providerErrorMessage(event)).event === 'provider.warning') continue;
        reported = typeof message === 'string' && message ? message : (reported ?? '');
      }
    }
    if (reported !== null) return { origin: 'provider-error', message: reported.trim() || null, exitCode };
    if (exitCode === 0) return null;
    const text = this.parseRun(stdout, '/migent-no-such-last-message').text.trim();
    return { origin: 'exit-only', message: text || null, exitCode };
  }

  public captureUsage(stdout: string): UsageCapture | null {
    const turnCompleted: Record<string, unknown>[] = [];
    for (const rawLine of stdout.split(/\r\n|\n|\r/)) {
      const event = parseJsonObject(rawLine);
      if (event === null || event.type !== 'turn.completed' || !isRecord(event.usage)) continue;
      turnCompleted.push(event.usage);
    }
    if (turnCompleted.length === 0) return null;
    return { turn_completed: turnCompleted };
  }

  public readUsage(capture: UsageCapture): CliUsage {
    const list = capture.turn_completed;
    const last = Array.isArray(list) && list.length > 0 ? list[list.length - 1] : null;
    const usage = isRecord(last) ? last : null;
    const input = finite(usage?.input_tokens);
    const cached = finite(usage?.cached_input_tokens);
    // Codex counts cached tokens inside `input_tokens`.
    const uncached = input !== null && cached !== null && input >= cached ? input - cached : null;
    return {
      values: {
        input_tokens: uncached,
        output_tokens: finite(usage?.output_tokens),
        reasoning_tokens: finite(usage?.reasoning_output_tokens),
        cache_read_tokens: cached,
        cache_write_tokens: finite(usage?.cache_write_input_tokens),
        cost_usd: null,
      },
      cumulative: ['input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens'],
    };
  }

  public optionValuesCommand(option: string, model: string): CommandSpec | null {
    void model;
    return option === CODEX_REASONING_OPTION ? this.modelsCommand() : null;
  }

  public parseOptionValues(option: string, stdout: string, model: string): readonly string[] {
    if (option !== CODEX_REASONING_OPTION) throw new Error(`codex does not list values for ${option}.`);
    const values = this.parseModels(stdout).valuesFor(model, option);
    if (values === null) throw new Error(`codex did not list ${option} values for ${model}.`);
    return values;
  }
}
