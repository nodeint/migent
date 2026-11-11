import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { classifyProviderError } from '@nodeint/migent-engine';
import { classifyFailure, loadAgentTarget, normalizeUsage, sessionOptions } from '@nodeint/migent-kernel';
import { expect, test } from 'vitest';

import { clientIds, createClient,OpencodeClient } from '../src/index.ts';

const registry = { ids: () => clientIds(), get: (id: string) => createClient(id) };

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/opencode/${name}`, import.meta.url)), 'utf8');
}

function stream(...events: Record<string, unknown>[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    model: 'anthropic/claude-sonnet-4',
    workspace: '/work/space',
    prompt: 'do the thing',
    agentId: null,
    newAgentId: null,
    promptFile: '/tmp/prompt.md',
    lastMessageFile: '/tmp/last.md',
    options: {},
    ...overrides,
  };
}

function toolUse(status: unknown): string {
  return JSON.stringify({
    type: 'tool_use',
    sessionID: 'ses_x',
    part: { tool: 'bash', state: { status, input: { command: 'ls  -la' } } },
  });
}

test('runCommand sends the prompt on stdin and relies on the process cwd', () => {
  const spec = new OpencodeClient().runCommand(input());
  expect(spec.argv).toEqual(['opencode', 'run', '--format', 'json', '--auto', '-m', 'anthropic/claude-sonnet-4']);
  expect(spec.stdin).toBe('do the thing');
  expect(spec.argv).not.toContain('--cwd');
  expect(spec.argv.join(' ')).not.toContain('/work/space');
  expect(spec.argv.join(' ')).not.toContain('do the thing');
});

test('runCommand resumes, and maps agent and thinking', () => {
  const client = new OpencodeClient();
  expect(client.runCommand(input({ agentId: 'ses_x' })).argv.slice(-2)).toEqual(['-s', 'ses_x']);
  const {argv} = client.runCommand(input({ options: { agent: 'build', thinking: 'true' } }));
  expect(argv).toContain('--thinking');
  expect(argv.slice(argv.indexOf('--agent'), argv.indexOf('--agent') + 2)).toEqual(['--agent', 'build']);
  expect(client.runCommand(input({ options: { thinking: 'false' } })).argv).not.toContain('--thinking');
});

test('validateOptions rejects invalid options before a run', () => {
  const client = new OpencodeClient();
  expect(() => client.validateOptions({ thinking: 'maybe' })).toThrow(
    'thinking must be true or false.',
  );
  expect(() => client.validateOptions({ nope: 'x' })).toThrow('nope is not an opencode option.');
  expect(() => client.validateOptions({ agent: '  ' })).toThrow('agent is empty.');
});

test('session, profile options, and option values', () => {
  const client = new OpencodeClient();
  expect(typeof client.newSessionId()).toBe('string');
  expect(sessionOptions(client, { agent: 'build' })).toEqual({});
  expect(client.optionValuesCommand('agent', 'm')).toBeNull();
  expect(client.optionValuesCommand('thinking', 'm')).toBeNull();
  expect(() => client.parseOptionValues('agent', '', 'm')).toThrow('opencode does not list values for agent.');
});

test('parseModels keeps order, skips blanks, and has no default', () => {
  const client = new OpencodeClient();
  expect(client.modelsCommand().argv).toEqual(['opencode', 'models']);
  const catalog = client.parseModels(fixture('models.txt'));
  expect(catalog.ids).toEqual(['anthropic/claude-sonnet-4', 'openai/gpt-5', 'opencode/big-pickle']);
  expect(catalog.defaultId).toBeNull();
  expect(() => client.parseModels('\n  \n')).toThrow('opencode model catalog is empty.');
});

test('parseVersion strips the product prefix', () => {
  const client = new OpencodeClient();
  expect(client.versionCommand().argv).toEqual(['opencode', '--version']);
  expect(client.parseVersion('opencode v2.1.2\n')).toBe('2.1.2');
  expect(client.parseVersion('\n')).toBeNull();
});

test('parseRun reads text after a tool and the session id', () => {
  const { text, sessionId } = new OpencodeClient().parseRun(fixture('success.jsonl'), '/tmp/unused');
  expect(text).toBe('status: complete\n\n# Done');
  expect(sessionId).toBe('ses_abc');
});

test('parseRun trims to the status header', () => {
  const { text } = new OpencodeClient().parseRun(fixture('status-header.jsonl'), '');
  expect(text).toBe('status: complete\n\n# Plan');
});

test('a later thought segment does not displace a status header segment', () => {
  const { text } = new OpencodeClient().parseRun(
    stream(
      { type: 'text', part: { text: 'status: complete\n\n# Plan\n' } },
      { type: 'tool_use', part: { tool: 'bash' } },
      { type: 'text', part: { text: 'thinking afterwards' } },
    ),
    '',
  );
  expect(text).toBe('status: complete\n\n# Plan');
});

test('parseRun falls back to the error string, then to raw stdout', () => {
  const client = new OpencodeClient();
  expect(client.parseRun(fixture('error-exit0.jsonl'), '')).toEqual({
    text: 'Invalid API key',
    sessionId: 'ses_er',
    source: 'error',
  });
  const typeOnly = stream({ type: 'error', sessionID: 's', error: { type: 'provider.auth' } });
  expect(client.parseRun(typeOnly, '')).toEqual({ text: 'provider.auth', sessionId: 's', source: 'error' });
  expect(client.parseRun(stream({ type: 'error' }), '')).toEqual({
    text: 'opencode reported an error.',
    sessionId: null,
    source: 'error',
  });
  expect(client.parseRun(stream({ type: 'step_start', sessionID: 's' }), '')).toEqual({
    text: '',
    sessionId: 's',
    source: 'none',
  });
  expect(client.parseRun('  plain output \n', '')).toEqual({
    text: 'plain output',
    sessionId: null,
    source: 'error',
  });
});

test('classifyFailure treats any error event as a provider failure', () => {
  const client = new OpencodeClient();
  expect(classifyFailure(client, fixture('error-exit0.jsonl'), 0)).toEqual({
    kind: 'provider',
    origin: 'provider-error',
    message: 'Invalid API key',
  });
  expect(classifyFailure(client, fixture('error-exit0.jsonl'), 1)?.kind).toBe('provider');
  expect(classifyFailure(client, '', 1)).toEqual({
    kind: 'provider',
    origin: 'exit-only',
    message: 'CLI exited with code 1.',
  });
  expect(classifyFailure(client, fixture('success.jsonl'), 0)).toBeNull();
  const twice = stream({ type: 'error', message: 'first' }, { type: 'error', message: 'second' });
  expect(classifyFailure(client, twice, 0)).toEqual({
    kind: 'provider',
    origin: 'provider-error',
    message: 'second',
  });
});

test('createEventParser maps tool statuses', () => {
  const client = new OpencodeClient();
  const parseEvent = client.createEventParser();
  for (const status of ['running', 'pending']) {
    expect(parseEvent(toolUse(status))).toEqual({
      event: 'provider.item_started',
      summary: 'command started: ls -la',
      details: { item_type: 'bash' },
    });
  }
  expect(parseEvent(toolUse('completed'))).toMatchObject({
    event: 'provider.item_completed',
    summary: 'command completed: ls -la',
  });
  expect(parseEvent(toolUse('error'))).toMatchObject({
    event: 'provider.item_completed',
    summary: 'command failed: ls -la',
  });
  expect(parseEvent(toolUse('weird'))).toBeNull();
  expect(parseEvent(toolUse(undefined))).toBeNull();
});

test('createEventParser falls back to the tool name and handles other events', () => {
  const client = new OpencodeClient();
  const parseEvent = client.createEventParser();
  const noCommand = JSON.stringify({ type: 'tool_use', part: { tool: 'read', state: { status: 'completed' } } });
  expect(parseEvent(noCommand)).toEqual({
    event: 'provider.item_completed',
    summary: 'read completed',
    details: { item_type: 'read' },
  });
  const noTool = JSON.stringify({ type: 'tool_use', part: { state: { status: 'running' } } });
  expect(parseEvent(noTool)).toEqual({
    event: 'provider.item_started',
    summary: 'tool started',
    details: {},
  });
  expect(parseEvent(JSON.stringify({ type: 'error', message: 'boom' }))).toEqual(
    classifyProviderError('boom'),
  );
  for (const type of ['text', 'step_start', 'step_finish']) {
    expect(parseEvent(JSON.stringify({ type, part: {} }))).toBeNull();
  }
  expect(parseEvent('not json')).toBeNull();
});

test('usage sums every step without reducing input by cache reads', () => {
  const client = new OpencodeClient();
  const capture = client.captureUsage(fixture('success.jsonl'));
  expect(capture).not.toBeNull();
  const usage = normalizeUsage(client, capture!, null);
  expect(usage).toMatchObject({
    input_tokens: 300,
    output_tokens: 50,
    reasoning_tokens: 5,
    cache_read_tokens: 200,
    cache_write_tokens: 10,
  });
  expect(usage.cost_usd).toBeCloseTo(0.03);
});

test('usage with a bad step nulls only that metric', () => {
  const client = new OpencodeClient();
  const good = { tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }, cost: 0.5 };
  for (const bad of [-1, Number.NaN, 'x', undefined]) {
    const usage = normalizeUsage(client,
      { steps: [good, { ...good, tokens: { ...good.tokens, output: bad } }] },
      null,
    );
    expect(usage.output_tokens).toBeNull();
    expect(usage.input_tokens).toBe(2);
    expect(usage.cost_usd).toBe(1);
  }
});

test('usage covers only the steps present and is null with none', () => {
  const client = new OpencodeClient();
  const capture = client.captureUsage(fixture('no-final-step.jsonl'));
  expect(normalizeUsage(client, capture!, null)).toMatchObject({ input_tokens: 10, cost_usd: 0.01 });
  expect(client.captureUsage(stream({ type: 'text', part: { text: 'x' } }))).toBeNull();
});

test('the client is registered', () => {
  expect(clientIds()).toContain('opencode');
  expect(createClient('opencode')).toBeInstanceOf(OpencodeClient);
});


test('model effort becomes an OpenCode V2 model variant on new and resumed runs', () => {
  const client = new OpencodeClient();
  const target = loadAgentTarget(
    { agents: { fast: {
    client: { type: 'opencode', options: { agent: 'build', thinking: 'true' } },
    model: 'openai/test', effort: 'high',
  } } },
    'fast',
    { registry },
  );
  expect(target.options).toEqual({ variant: 'high', agent: 'build', thinking: 'true' });
  for (const agentId of [null, 'ses_x']) {
    const command = client.runCommand(input({ model: target.model, options: target.options, agentId }));
    expect(command.argv[command.argv.indexOf('-m') + 1]).toBe('openai/test#high');
    expect(command.argv).toContain('--thinking');
    expect(command.argv).not.toContain('--variant');
  }
  expect(sessionOptions(client, target.options)).toEqual({ variant: 'high' });
});

test('native variants and existing model suffixes work independently', () => {
  const client = new OpencodeClient();
  expect(client.runCommand(input({ model: 'openai/test#max' })).argv).toContain('openai/test#max');
  expect(client.runCommand(input({ options: { variant: 'custom-level' } })).argv)
    .toContain('anthropic/claude-sonnet-4#custom-level');
  expect(() => client.runCommand(input({ model: 'openai/test#low', options: { variant: 'high' } })))
    .toThrow(/already selects a #variant/);
});

test.each(['', ' ', 'high#low', 'high low', 'high\nlow'])('rejects malformed variant %s', (variant) => {
  expect(() => new OpencodeClient().validateOptions({ variant })).toThrow(/variant/);
});


test('lists OpenCode V2 variants for the exact provider and model', () => {
  const client = new OpencodeClient();
  expect(client.optionValuesCommand('variant', 'custom/test')?.argv).toEqual(['opencode', 'api', 'model.list']);
  const catalog = JSON.stringify({ data: [
    { providerID: 'other', id: 'test', variants: [{ id: 'wrong' }] },
    { providerID: 'custom', id: 'test', variants: [{ id: 'low' }, { id: 'high' }, { id: 'high' }] },
    { providerID: 'custom', id: 'plain', variants: [] },
  ] });
  expect(client.parseOptionValues('variant', catalog, 'custom/test')).toEqual(['low', 'high']);
  expect(client.parseOptionValues('variant', catalog, 'custom/plain')).toEqual([]);
  expect(() => client.parseOptionValues('variant', catalog, 'custom/missing')).toThrow(/does not list variants/);
  expect(() => client.parseOptionValues('variant', '{}', 'custom/test')).toThrow(/did not report/);
  expect(() => client.parseOptionValues('variant', JSON.stringify({ data: [
    { providerID: 'custom', id: 'test', variants: [{}] },
  ] }), 'custom/test')).toThrow(/invalid variant/);
});

test('a new session gets a unique server-shaped id that the first command passes with -s', () => {
  const client = new OpencodeClient();
  const first = client.newSessionId();
  const second = client.newSessionId();
  expect(first).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  expect(second).not.toBe(first);
  const {argv} = client.runCommand(input({ newAgentId: first }));
  expect(argv.slice(-2)).toEqual(['-s', first]);
});

test('a resumed turn passes the stored id, not the preallocated one', () => {
  const {argv} = new OpencodeClient().runCommand(input({ agentId: 'ses_stored', newAgentId: 'ses_fresh' }));
  expect(argv.slice(-2)).toEqual(['-s', 'ses_stored']);
  expect(argv).not.toContain('ses_fresh');
});

test('the interrupt command targets the session through opencode api without naming a server', () => {
  const client = new OpencodeClient();
  const id = client.newSessionId();
  expect(client.interruptCommand(id)?.argv).toEqual([
    'opencode', 'api', 'session.interrupt', '--param', `sessionID=${id}`,
  ]);
  expect(client.interruptCommand('ses_x; rm -rf /')).toBeNull();
});

test('interrupt results are classified', () => {
  const client = new OpencodeClient();
  expect(client.classifyInterrupt('{"interrupted":true}', 0)).toBe('interrupted');
  expect(client.classifyInterrupt('{"interrupted":false}', 0)).toBe('idle');
  expect(client.classifyInterrupt('not json', 0)).toBe('failed');
  expect(client.classifyInterrupt('SessionNotFound: ses_x', 1)).toBe('not-found');
  expect(client.classifyInterrupt('HTTP 404', 1)).toBe('not-found');
  expect(client.classifyInterrupt('connection refused', 1)).toBe('failed');
});

test('the session id is read from any output line', () => {
  const client = new OpencodeClient();
  expect(client.sessionIdFromLine(JSON.stringify({ type: 'step_start', sessionID: 'ses_a' }))).toBe('ses_a');
  expect(client.sessionIdFromLine(JSON.stringify({ type: 'text' }))).toBeNull();
  expect(client.sessionIdFromLine('plain text')).toBeNull();
});

test('interrupt classification matches the responses OpenCode 2.2.5 returned', () => {
  const client = new OpencodeClient();
  const notFound = JSON.stringify({ _tag: 'SessionNotFoundError', sessionID: 'ses_x', message: 'Session not found: ses_x' }) + '\nHTTP 404 Not Found';
  const invalid = JSON.stringify({ _tag: 'InvalidRequestError', message: 'Expected a string starting with "ses"', kind: 'Params' }) + '\nHTTP 400 Bad Request';
  expect(client.classifyInterrupt(notFound, 1)).toBe('not-found');
  expect(client.classifyInterrupt(invalid, 1)).toBe('failed');
  expect(client.newSessionId().startsWith('ses')).toBe(true);
});
