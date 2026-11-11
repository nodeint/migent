import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { normalizeUsage, parseStageOutcome, sessionOptions } from '@nodeint/migent-kernel';
import { expect, test } from 'vitest';

import { AgyClient, createClient } from '../src/index.ts';

function usageFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/usage/${name}`, import.meta.url)), 'utf8');
}

function stream(...events: Record<string, unknown>[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

const toolActive = {
  event: 'step_update',
  conversation_id: 'conv-1',
  step_update: {
    conversation_id: 'conv-1',
    step_index: 4,
    state: 'ACTIVE',
    step_type: 'tool',
    tool_name: 'run_command',
    tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' } },
  },
};

const toolDone = {
  event: 'step_update',
  conversation_id: 'conv-1',
  step_update: {
    conversation_id: 'conv-1',
    step_index: 4,
    state: 'DONE',
    step_type: 'tool',
    tool_name: 'run_command',
    tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' }, output: 'hi\n' },
  },
};

test('reads the final result and conversation id from stream-json', () => {
  const { text, sessionId } = new AgyClient().parseRun(
    stream(
      { event: 'init', conversation_id: 'conv-1', init: { cwd: '/work' } },
      toolActive,
      toolDone,
      {
        event: 'step_update',
        step_update: { step_index: 5, state: 'DONE', step_type: 'agent_response', text_delta: 'draft' },
      },
      {
        event: 'result',
        result: {
          conversation_id: 'conv-1',
          status: 'SUCCESS',
          response: 'status: complete\n\n# Plan\n',
        },
      },
    ),
    '/tmp/unused',
  );
  expect(text).toBe('status: complete\n\n# Plan');
  expect(sessionId).toBe('conv-1');
  expect(parseStageOutcome(text, true)?.status).toBe('complete');
});

test('reports a failed result', () => {
  const client = new AgyClient();
  const failed = {
    event: 'result',
    result: {
      conversation_id: '',
      status: 'ERROR',
      response: '',
      error: 'invalid model selection',
    },
  };
  expect(client.parseRun(stream(failed), '/tmp/unused')).toEqual({
    text: 'invalid model selection',
    sessionId: null,
    source: 'error',
  });
  expect(client.createEventParser()(JSON.stringify(failed))).toEqual({
    event: 'provider.turn_failed',
    summary: 'invalid model selection',
  });
});

test('reads a single json envelope', () => {
  const { text, sessionId } = new AgyClient().parseRun(
    JSON.stringify({
      conversation_id: 'conv-2',
      status: 'SUCCESS',
      response: 'status: blocked\n',
    }),
    '/tmp/unused',
  );
  expect(text).toBe('status: blocked');
  expect(sessionId).toBe('conv-2');
});

test('reports tool progress', () => {
  const client = new AgyClient();
  const parseEvent = client.createEventParser();
  expect(parseEvent(JSON.stringify(toolActive))).toEqual({
    event: 'provider.item_started',
    summary: 'command started: echo hi',
    details: { item_type: 'run_command' },
  });
  expect(parseEvent(JSON.stringify(toolDone))).toEqual({
    event: 'provider.item_completed',
    summary: 'command completed: echo hi',
    details: { item_type: 'run_command' },
  });
  expect(parseEvent('not json')).toBeNull();
  expect(parseEvent(JSON.stringify({ event: 'init', conversation_id: 'conv-1' }))).toBeNull();
});

test('marks a finished tool failed when tool_info has an error', () => {
  const client = new AgyClient();
  const parseEvent = client.createEventParser();
  const failed = {
    event: 'step_update',
    step_update: {
      step_index: 2,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: {
        name: 'run_command',
        parameters: { CommandLine: 'false' },
        error: { type: 'exit', message: 'exit 1' },
      },
    },
  };
  expect(parseEvent(JSON.stringify(failed))).toEqual({
    event: 'provider.item_completed',
    summary: 'command failed: false',
    details: { item_type: 'run_command' },
  });
});

test('lists model slugs and effort levels', () => {
  const client = new AgyClient();
  const catalog = client.parseModels(
    'Fetching available models...\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\ngemini-3.8-flash-high  Gemini 3.8 Flash (High)\n',
  );
  expect(catalog.ids).toEqual(['gemini-3.8-flash-low', 'gemini-3.8-flash-high']);
  expect(catalog.defaultId).toBeNull();
  expect(catalog.valuesFor('gemini-3.8-flash-low', 'effort')).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  expect(client.modelsCommand().argv).toEqual(['agy', 'models']);
  expect(client.optionValuesCommand('effort', 'gemini-3.8-flash-low')?.argv).toEqual(['agy', 'models']);
  expect(client.optionValuesCommand('mode', 'gemini-3.8-flash-low')).toBeNull();
  expect(() => client.parseModels('Fetching available models...\n')).toThrow(/empty/);
});

test('rejects an unknown option', () => {
  const client = new AgyClient();
  expect(() => client.validateOptions({ temperature: '0.2' })).toThrow(/temperature is not an agy option/);
  expect(() => client.validateOptions({ mode: 'yolo' })).toThrow(/mode must be one of/);
  expect(() => client.validateOptions({ effort: 'turbo' })).toThrow(/effort must be one of/);
  expect(() => client.validateOptions({ sandbox: 'yes' })).toThrow(/sandbox must be true or false/);
  client.validateOptions({ effort: 'high', mode: 'plan', sandbox: 'true', skip_permissions: 'false' });
});

test('maps a prompt onto a stream-json agy command', () => {
  const client = new AgyClient();
  expect(client.newSessionId?.() ?? null).toBeNull();
  expect(sessionOptions(client, { effort: 'high', mode: 'plan' })).toEqual({ effort: 'high' });
  const spec = client.runCommand({
    model: 'gemini-3.8-flash-low',
    workspace: '/work',
    prompt: 'status: complete\n\n# Plan',
    agentId: null,
    newAgentId: null,
    promptFile: '/tmp/prompt.txt',
    lastMessageFile: '/tmp/last.txt',
    options: { effort: 'high', mode: 'accept-edits', agent: 'reviewer' },
  });
  expect(createClient('agy').command).toBe(client.command);
  expect(spec.argv).toEqual([
    'agy',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--model',
    'gemini-3.8-flash-low',
    '--add-dir',
    '/work',
    '--disable-slash-commands',
    '--dangerously-skip-permissions',
    '--effort',
    'high',
    '--mode',
    'accept-edits',
    '--agent',
    'reviewer',
  ]);
  expect(JSON.parse(spec.stdin ?? '')).toEqual({
    event: 'user',
    message: { content: 'status: complete\n\n# Plan' },
  });
  const resumed = client.runCommand({
    model: 'gemini-3.8-flash-low',
    workspace: '/work',
    prompt: 'again',
    agentId: 'conv-1',
    newAgentId: null,
    promptFile: '/tmp/prompt.txt',
    lastMessageFile: '/tmp/last.txt',
    options: { skip_permissions: 'false', sandbox: 'true' },
  });
  expect(resumed.argv).not.toContain('--dangerously-skip-permissions');
  expect(resumed.argv.slice(-3)).toEqual(['--sandbox', '--conversation', 'conv-1']);
});

test('normalizes agy usage from the resume fixtures', () => {
  const client = new AgyClient();
  const captures = [1, 2, 3].map((turn) => client.captureUsage(usageFixture(`agy-resume-${turn}.jsonl`)));
  const first = normalizeUsage(client, captures[0]!, null);
  const second = normalizeUsage(client, captures[1]!, captures[0]!);
  const third = normalizeUsage(client, captures[2]!, captures[1]!);
  expect([first.input_tokens, second.input_tokens, third.input_tokens]).toEqual([6673, 6881, 7089]);
  expect(first.cost_usd).toBeNull();
  expect(first.cache_write_tokens).toBeNull();
  const steps = captures[0]?.steps;
  expect(Array.isArray(steps)).toBe(true);
  expect((steps as unknown[]).length).toBe(1);
  expect(client.captureUsage('{"event":"status"}\n')).toBeNull();
  const preferred = normalizeUsage(client, {
    result: { usage: { input_tokens: 999, output_tokens: 9, thinking_tokens: 0, cache_read_tokens: 0 } },
    steps: [{ input_tokens: 10, output_tokens: 1, thinking_tokens: 2, cache_read_tokens: 3 }],
  }, null);
  expect(preferred.input_tokens).toBe(10);
  expect(preferred.reasoning_tokens).toBe(2);
  const delta = normalizeUsage(client,
    { result: { usage: { input_tokens: 30, output_tokens: 4, thinking_tokens: 1, cache_read_tokens: 0 } }, steps: [] },
    { result: { usage: { input_tokens: 10, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0 } }, steps: [] },
  );
  expect(delta.input_tokens).toBe(20);
  expect(delta.output_tokens).toBe(3);
  const broken = normalizeUsage(client,
    { steps: [{ input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0 }, { input_tokens: 'x' }] },
    null,
  );
  expect(broken.input_tokens).toBeNull();
  expect(broken.output_tokens).toBeNull();
  expect(client.versionCommand().argv).toEqual(['agy', '--version']);
  expect(client.parseVersion('codex-cli 0.163.0\n')).toBe('codex-cli 0.163.0');
  expect(client.parseVersion('')).toBeNull();
});
