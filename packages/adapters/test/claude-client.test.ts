import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { normalizeUsage, parseStageOutcome } from '@nodeint/migent-kernel';
import { expect, test } from 'vitest';

import { ClaudeCodeClient, createClient } from '../src/index.ts';

function usageFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/usage/${name}`, import.meta.url)), 'utf8');
}

function stream(...events: Record<string, unknown>[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

const toolUse = {
  type: 'assistant',
  message: {
    content: [
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } },
    ],
  },
  parent_tool_use_id: null,
  session_id: 'sess-1',
};

const toolResult = {
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hi' }] },
  parent_tool_use_id: null,
  session_id: 'sess-1',
};

test('reads the final result and session id from stream-json', () => {
  const { text, sessionId } = new ClaudeCodeClient().parseRun(
    stream(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      toolUse,
      toolResult,
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'status: complete\n\n# Plan' }] },
        parent_tool_use_id: null,
        session_id: 'sess-1',
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'status: complete\n\n# Plan',
        session_id: 'sess-1',
      },
    ),
    '/tmp/unused',
  );
  expect(text).toBe('status: complete\n\n# Plan');
  expect(sessionId).toBe('sess-1');
  expect(parseStageOutcome(text, true)?.status).toBe('complete');
});

test('falls back to the last assistant text without a result', () => {
  const { text, sessionId } = new ClaudeCodeClient().parseRun(
    stream(
      { type: 'system', subtype: 'init', session_id: 'sess-2' },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'status: blocked' }] },
        parent_tool_use_id: null,
        session_id: 'sess-2',
      },
    ),
    '/tmp/unused',
  );
  expect(text).toBe('status: blocked');
  expect(sessionId).toBe('sess-2');
});

test('reports a failed result', () => {
  const client = new ClaudeCodeClient();
  const failed = {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['API overloaded'],
    session_id: 'sess-3',
  };
  expect(client.parseRun(stream(failed), '/tmp/unused')).toEqual({
    text: 'API overloaded',
    sessionId: 'sess-3',
    source: 'error',
  });
  expect(client.createEventParser()(JSON.stringify(failed))).toEqual({
    event: 'provider.turn_failed',
    summary: 'API overloaded',
  });
});

test('reports tool progress', () => {
  const client = new ClaudeCodeClient();
  const parseEvent = client.createEventParser();
  expect(parseEvent(JSON.stringify(toolUse))).toEqual({
    event: 'provider.item_started',
    summary: 'command started: echo hi',
    details: { item_type: 'Bash' },
  });
  expect(parseEvent(JSON.stringify(toolResult))).toEqual({
    event: 'provider.item_completed',
    summary: 'command completed: echo hi',
    details: { item_type: 'Bash' },
  });
  expect(parseEvent('not json')).toBeNull();
});

test('lists models and effort levels from the initialize response', () => {
  const client = new ClaudeCodeClient();
  const response = JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'migent-models',
      response: {
        models: [
          { value: 'default', resolvedModel: 'claude-sonnet-5-5' },
          { value: 'opus', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: ['low', 'max'] },
          { value: 'claude-haiku-4-5-20251001', resolvedModel: 'claude-haiku-4-5-20251001' },
        ],
      },
    },
  });
  const catalog = client.parseModels(`${response}\n`);
  expect(catalog.ids).toEqual(['opus', 'claude-opus-5-5', 'claude-haiku-4-5-20251001']);
  expect(catalog.valuesFor('opus', 'effort')).toEqual(['low', 'max']);
  expect(catalog.valuesFor('claude-opus-5-5', 'effort')).toEqual(['low', 'max']);
  expect(catalog.valuesFor('claude-haiku-4-5-20251001', 'effort')).toBeNull();
  expect(client.modelsCommand().argv).toContain('--input-format');
  expect(JSON.parse(client.modelsCommand().stdin ?? '')).toMatchObject({ request: { subtype: 'initialize' } });
  expect(() => client.parseModels('command not found')).toThrow(/command not found/);
});

test('rejects an unknown option', () => {
  const client = new ClaudeCodeClient();
  expect(() => client.validateOptions({ temperature: '0.2' })).toThrow(
    /temperature is not a claude option/,
  );
  expect(() => client.validateOptions({ permission_mode: 'yolo' })).toThrow(
    /permission_mode must be one of/,
  );
  expect(() => client.validateOptions({ max_budget_usd: '-1' })).toThrow(/max_budget_usd/);
  client.validateOptions({ effort: 'high', max_budget_usd: '2.5' });
});

test('maps options onto claude flags', () => {
  const client = new ClaudeCodeClient();
  const newSession = client.newSessionId();
  expect(newSession).toMatch(/^[0-9a-f-]{36}$/);
  const spec = client.runCommand({
    model: 'opus',
    workspace: '/work',
    prompt: 'prompt',
    agentId: null,
    newAgentId: '11111111-2222-3333-4444-555555555555',
    promptFile: '/tmp/prompt.txt',
    lastMessageFile: '/tmp/last.txt',
    options: { effort: 'high', allowed_tools: 'Bash Edit' },
  });
  expect(createClient('claude-code').command).toBe(client.command);
  expect(spec.argv).toEqual([
    'claude',
    '-p',
    '--model',
    'opus',
    '--output-format',
    'stream-json',
    '--verbose',
    '--effort',
    'high',
    '--allowed-tools',
    'Bash Edit',
    '--permission-mode',
    'bypassPermissions',
    '--session-id',
    '11111111-2222-3333-4444-555555555555',
  ]);
  expect(spec.stdin).toBe('prompt');
  const resumed = client.runCommand({
    model: 'opus',
    workspace: '/work',
    prompt: 'again',
    agentId: 'sess-1',
    newAgentId: null,
    promptFile: '/tmp/prompt.txt',
    lastMessageFile: '/tmp/last.txt',
    options: { permission_mode: 'acceptEdits' },
  });
  expect(resumed.argv.slice(-4)).toEqual(['--permission-mode', 'acceptEdits', '--resume', 'sess-1']);
});

test('normalizes claude usage from the resume fixtures', () => {
  const client = new ClaudeCodeClient();
  const captures = [1, 2, 3].map((turn) => client.captureUsage(usageFixture(`claude-resume-${turn}.jsonl`)));
  expect(captures[0]?.result).toMatchObject({
    total_cost_usd: 0.0439477,
    usage: { output_tokens: 3, input_tokens: 2 },
  });
  expect(captures[1]?.result).toMatchObject({ total_cost_usd: 0.07983470000000001 });
  expect(captures[2]?.result).toMatchObject({ total_cost_usd: 0.08419960000000001 });
  const first = normalizeUsage(client, captures[0]!, null);
  const second = normalizeUsage(client, captures[1]!, captures[0]!);
  const third = normalizeUsage(client, captures[2]!, captures[1]!);
  expect([first.output_tokens, second.output_tokens, third.output_tokens]).toEqual([3, 3, 3]);
  expect([first.input_tokens, second.input_tokens, third.input_tokens]).toEqual([2, 2, 2]);
  expect(first.reasoning_tokens).toBe(0);
  expect(first.cost_usd).toBeCloseTo(0.0439, 4);
  expect(second.cost_usd).toBeCloseTo(0.0359, 4);
  expect(third.cost_usd).toBeCloseTo(0.0044, 4);
  expect(client.captureUsage('{"type":"assistant"}\n')).toBeNull();
  const bad = normalizeUsage(client,
    { result: { usage: { input_tokens: '3', output_tokens: -1, cache_read_input_tokens: 2 }, total_cost_usd: -4 } },
    null,
  );
  expect(bad.input_tokens).toBeNull();
  expect(bad.output_tokens).toBeNull();
  expect(bad.cache_read_tokens).toBe(2);
  expect(bad.cost_usd).toBeNull();
  expect(client.versionCommand().argv).toEqual(['claude', '--version']);
  expect(client.parseVersion('codex-cli 0.163.0\n')).toBe('codex-cli 0.163.0');
  expect(client.parseVersion('')).toBeNull();
});
