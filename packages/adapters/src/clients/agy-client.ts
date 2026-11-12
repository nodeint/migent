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
  TurnUsage,
  UsageCapture,
} from '../types.js';
import { classifyProviderError } from '../types.js';
import { parseHelpOptions } from '../utils/parse-help-options.js';
import { compact, emptyUsage, finite, isRecord, labelOf, parseJsonObject, picked } from './json.js';

// `agy models` lists slugs, not effort levels. `--help` fixes the enum.
export const AGY_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const AGY_MODES = ['accept-edits', 'auto', 'plan'] as const;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const AGY_OPTIONS: readonly ClientOption[] = [
  { name: 'effort', prompt: true, allowDefault: true, overridable: true },
  { name: 'mode' },
  { name: 'agent' },
  { name: 'sandbox' },
  { name: 'skip_permissions' },
];

function oneOf(value: string, allowed: readonly string[], field: string): void {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}.`);
  }
}

function agyBool(value: string, field: string): void {
  if (value !== 'true' && value !== 'false') {
    throw new Error(`${field} must be true or false.`);
  }
}

function agyText(value: string): void {
  void value;
}

const AGY_OPTION_CHECKS: Record<string, (value: string) => void> = {
  effort: (value) => oneOf(value, AGY_EFFORTS, 'effort'),
  mode: (value) => oneOf(value, AGY_MODES, 'mode'),
  agent: agyText,
  sandbox: (value) => agyBool(value, 'sandbox'),
  skip_permissions: (value) => agyBool(value, 'skip_permissions'),
};

function modelId(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.toLowerCase().startsWith('fetching ')) return null;
  let candidate = trimmed;
  const tab = trimmed.indexOf('\t');
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
  return typeof value === 'string' && value ? value : null;
}

function resultBody(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (payload.event === 'result' && isRecord(payload.result)) return payload.result;
  if (payload.event === undefined && typeof payload.status === 'string' && 'response' in payload) {
    return payload;
  }
  return null;
}

function failureText(result: Record<string, unknown>): string {
  const {error} = result;
  if (typeof error === 'string' && error.trim()) return error.trim();
  const {response} = result;
  if (typeof response === 'string' && response.trim()) return response.trim();
  const {status} = result;
  return typeof status === 'string' && status ? `agy failed: ${status}` : 'agy failed.';
}

function toolInfo(step: Record<string, unknown>): Record<string, unknown> {
  return isRecord(step.tool_info) ? step.tool_info : {};
}

function toolName(step: Record<string, unknown>): string {
  if (typeof step.tool_name === 'string' && step.tool_name) return step.tool_name;
  const {name} = toolInfo(step);
  if (typeof name === 'string' && name) return name;
  return 'tool';
}

function parameterString(parameters: unknown, ...keys: string[]): string | null {
  if (!isRecord(parameters)) return null;
  for (const key of keys) {
    const value = parameters[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

function toolSummary(step: Record<string, unknown>, action: string): string {
  const {parameters} = toolInfo(step);
  const command = parameterString(parameters, 'CommandLine', 'command', 'cmd');
  if (command) return `command ${action}: ${compact(command)}`;
  const target = parameterString(
    parameters,
    'path',
    'file_path',
    'TargetFile',
    'target_file',
    'absolute_path',
    'pattern',
    'url',
    'query',
  );
  const name = toolName(step);
  if (target) return `${name} ${action}: ${compact(target)}`;
  return `${name} ${action}`;
}

function toolDetails(step: Record<string, unknown>): Record<string, unknown> {
  const name = toolName(step);
  return name === 'tool' ? {} : { item_type: name };
}

function isToolStep(step: Record<string, unknown>): boolean {
  if (step.step_type === 'tool') return true;
  if (typeof step.tool_name === 'string' && step.tool_name) return true;
  return isRecord(step.tool_info);
}

function toolFailed(step: Record<string, unknown>): boolean {
  const {error} = toolInfo(step);
  if ((error === null || error === undefined) || error === false) return false;
  if (typeof error === 'string') return error.trim() !== '';
  return true;
}

function stepKey(step: Record<string, unknown>): string | null {
  const index = step.step_index;
  if (typeof index === 'number' && Number.isInteger(index)) return String(index);
  return null;
}

function sumSteps(steps: unknown[]): TurnUsage {
  const sum = (field: string): number | null => {
    let total = 0;
    for (const step of steps) {
      const value = finite(isRecord(step) ? step[field] : undefined);
      if (value === null) return null;
      total += value;
    }
    return total;
  };
  return {
    ...emptyUsage(),
    input_tokens: sum('input_tokens'),
    output_tokens: sum('output_tokens'),
    reasoning_tokens: sum('thinking_tokens'),
    cache_read_tokens: sum('cache_read_tokens'),
  };
}

const AGY_EVENTS: ReadonlySet<string> = new Set(['init', 'status', 'step_update', 'result']);
const AGY_STEP_TYPES: ReadonlySet<string> = new Set(['agent_response', 'system_message', 'user_input', 'tool']);

export class AgyClient implements CliClient {
  public optionsCommand(): CommandSpec {
    return { argv: [this.command, '-p', '--help'] };
  }

  public parseOptions(help: string): HeadlessOption[] {
    return parseHelpOptions(help, { section: /^Usage of agy:/, inferArgumentType: false });
  }

  public readonly effortOption = 'effort';
  public readonly id = 'agy';
  public readonly command = 'agy';

  public options(): readonly ClientOption[] {
    return AGY_OPTIONS;
  }

  public validateOptions(options: Readonly<Record<string, string>>): void {
    for (const [key, value] of Object.entries(options)) {
      const check = AGY_OPTION_CHECKS[key];
      if (check === undefined) throw new Error(`${key} is not an agy option.`);
      if (value.trim() === '') throw new Error(`${key} is empty.`);
      check(value);
    }
  }

  public runCommand(input: BuildCommandInput): CommandSpec {
    const argv = [
      this.command,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--model',
      input.model,
      '--add-dir',
      input.workspace,
      '--disable-slash-commands',
    ];
    // `agy -p` takes the prompt as a flag value and does not read stdin.
    // One stream-json user message keeps a long prompt off argv.
    if (input.options.skip_permissions !== 'false') argv.push('--dangerously-skip-permissions');
    if (input.options.effort) argv.push('--effort', input.options.effort);
    if (input.options.mode) argv.push('--mode', input.options.mode);
    if (input.options.agent) argv.push('--agent', input.options.agent);
    if (input.options.sandbox === 'true') argv.push('--sandbox');
    if (input.agentId) argv.push('--conversation', input.agentId);
    const stdin = `${JSON.stringify({ event: 'user', message: { content: input.prompt } })}\n`;
    return { argv, stdin };
  }

  public modelsCommand(): CommandSpec {
    return { argv: [this.command, 'models'] };
  }

  public versionCommand(): CommandSpec {
    return { argv: [this.command, '--version'] };
  }

  public parseRun(stdout: string, lastMessageFile: string): CliRunOutput {
    void lastMessageFile;
    let sessionId: string | null = null;
    let output: { text: string; source: CliRunOutput['source'] } | null = null;
    let sawEvent = false;
    for (const rawLine of stdout.split(/\r\n|\n|\r/)) {
      const payload = parseJsonObject(rawLine);
      if (payload === null) continue;
      sawEvent = true;
      sessionId = conversationId(payload.conversation_id) || sessionId;
      const result = resultBody(payload);
      if (result === null) continue;
      sessionId = conversationId(result.conversation_id) || sessionId;
      output = resultOutput(result);
    }
    if (output !== null) return { ...output, sessionId };
    if (sawEvent) return { text: '', sessionId, source: 'none' };
    const raw = stdout.trim();
    return { text: raw, sessionId: null, source: raw === '' ? 'none' : 'error' };
  }

  public parseModels(stdout: string): ModelCatalog {
    const ids: string[] = [];
    for (const raw of stdout.split(/\r\n|\n|\r/)) {
      const id = modelId(raw);
      if (id && !ids.includes(id)) ids.push(id);
    }
    if (ids.length === 0) throw new Error('agy model catalog is empty.');
    return new ModelCatalog(
      ids,
      null,
      ids.map((model) => [model, 'effort', AGY_EFFORTS] as const),
    );
  }

  public parseVersion(stdout: string): string | null {
    const line = (stdout.split(/\r\n|\n|\r/, 1)[0] ?? '').trim();
    return line === '' ? null : line;
  }

  public createEventParser(): (line: string) => Record<string, unknown> | null {
    const toolSteps = new Map<string, Record<string, unknown>>();
    return (line) => {
      const payload = parseJsonObject(line);
      if (payload === null) return null;
      if (payload.event === 'step_update' && isRecord(payload.step_update)) {
        return stepEvent(payload.step_update, toolSteps);
      }
      if (payload.event === 'result') {
        const result = resultBody(payload);
        if (result === null || result.status === 'SUCCESS') return null;
        const failed = classifyProviderError(failureText(result));
        if (failed.event === 'provider.warning') return failed;
        return { event: 'provider.turn_failed', summary: failed.summary };
      }
      return null;
    };
  }

  public eventLabel(line: string): string | null {
    const payload = parseJsonObject(line);
    if (payload === null) return null;
    const event = labelOf(payload.event, AGY_EVENTS);
    if (event === null) return 'other';
    if (event === 'result') {
      const result = resultBody(payload);
      return result !== null && result.status !== 'SUCCESS' ? 'result:error' : 'result';
    }
    if (event === 'step_update' && isRecord(payload.step_update)) {
      const kind = labelOf(payload.step_update.step_type, AGY_STEP_TYPES);
      return kind === null ? event : `${event}:${kind}`;
    }
    return event;
  }

  public extractFailure(stdout: string, exitCode: number): RawFailure | null {
    const text = this.parseRun(stdout, '').text.trim();
    // A non-SUCCESS result is the CLI's own error report; anything else is a bare exit.
    let reported = false;
    for (const rawLine of stdout.split(/\r\n|\n|\r/)) {
      const payload = parseJsonObject(rawLine);
      const result = payload === null ? null : resultBody(payload);
      if (result !== null && result.status !== 'SUCCESS') reported = true;
    }
    if (exitCode === 0 && !reported) return null;
    return { origin: reported ? 'provider-error' : 'exit-only', message: text || null, exitCode };
  }

  public captureUsage(stdout: string): UsageCapture | null {
    let result: Record<string, unknown> | null = null;
    const steps: Record<string, unknown>[] = [];
    for (const rawLine of stdout.split(/\r\n|\n|\r/)) {
      const payload = parseJsonObject(rawLine);
      if (payload === null) continue;
      if (payload.event === 'result' && isRecord(payload.result)) result = payload.result;
      if (payload.event !== 'step_update' || !isRecord(payload.step_update)) continue;
      const step = payload.step_update;
      const {state} = step;
      if (typeof state === 'string' && state.toUpperCase() === 'DONE' && isRecord(step.usage)) steps.push(step.usage);
    }
    if (result === null && steps.length === 0) return null;
    const capture: UsageCapture = { steps };
    if (result) capture.result = picked(result, ['usage', 'num_turns', 'duration_seconds']);
    return capture;
  }

  public readUsage(capture: UsageCapture): CliUsage {
    const steps = Array.isArray(capture.steps) ? capture.steps : [];
    if (steps.length > 0) return { values: sumSteps(steps), cumulative: [] };
    const result = isRecord(capture.result) ? capture.result : null;
    const usage = result !== null && isRecord(result.usage) ? result.usage : null;
    return {
      values: {
        ...emptyUsage(),
        input_tokens: finite(usage?.input_tokens),
        output_tokens: finite(usage?.output_tokens),
        reasoning_tokens: finite(usage?.thinking_tokens),
        cache_read_tokens: finite(usage?.cache_read_tokens),
      },
      cumulative: ['input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens'],
    };
  }

  public optionValuesCommand(option: string, model: string): CommandSpec | null {
    void model;
    return option === 'effort' ? this.modelsCommand() : null;
  }

  public parseOptionValues(option: string, stdout: string, model: string): readonly string[] {
    if (option !== 'effort') throw new Error(`agy does not list values for ${option}.`);
    return this.parseModels(stdout).valuesFor(model, option) ?? AGY_EFFORTS;
  }
}

/** The run output one result body yields: the model's response, or the failure text. */
function resultOutput(result: Record<string, unknown>): { text: string; source: CliRunOutput['source'] } {
  if (result.status !== 'SUCCESS') return { text: failureText(result), source: 'error' };
  const {response} = result;
  const text = typeof response === 'string' ? response.trim() : '';
  return { text, source: text === '' ? 'none' : 'model' };
}

const FINISHED_STEP_STATES: ReadonlySet<string> = new Set(['DONE', 'FAILED', 'ERROR']);

/** Maps one tool step update to a provider event, remembering active steps to merge their parameters later. */
function stepEvent(
  step: Record<string, unknown>,
  toolSteps: Map<string, Record<string, unknown>>,
): Record<string, unknown> | null {
  if (!isToolStep(step)) return null;
  const state = typeof step.state === 'string' ? step.state.toUpperCase() : '';
  const key = stepKey(step);
  if (state === 'ACTIVE') {
    if (key) toolSteps.set(key, step);
    return {
      event: 'provider.item_started',
      summary: toolSummary(step, 'started'),
      details: toolDetails(step),
    };
  }
  if (!FINISHED_STEP_STATES.has(state)) return null;
  const merged = mergeRememberedStep(step, key ? toolSteps.get(key) : undefined);
  const action = toolFailed(merged) || state === 'FAILED' || state === 'ERROR' ? 'failed' : 'completed';
  return {
    event: 'provider.item_completed',
    summary: toolSummary(merged, action),
    details: toolDetails(merged),
  };
}

/** Completes a finished step with the parameters its active update carried. */
function mergeRememberedStep(
  step: Record<string, unknown>,
  remembered: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!remembered) return step;
  const merged = { ...remembered, ...step };
  if (!isRecord(toolInfo(step).parameters) && isRecord(toolInfo(remembered).parameters)) {
    merged.tool_info = { ...toolInfo(remembered), ...toolInfo(step) };
  }
  return merged;
}
