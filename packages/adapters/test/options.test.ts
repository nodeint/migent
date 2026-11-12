import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

import { AgyClient, ClaudeCodeClient, CodexClient, GrokClient, OpencodeClient } from '../src/index.js';
const parseClaudeCodeOptions = (help: string) => ({ options: new ClaudeCodeClient().parseOptions(help) });
const parseCodexOptions = (help: string) => ({ options: new CodexClient().parseOptions(help) });
const parseAgyOptions = (help: string) => ({ options: new AgyClient().parseOptions(help) });
const parseGrokOptions = (help: string) => ({ options: new GrokClient().parseOptions(help) });
const parseOpencodeOptions = (help: string) => ({ options: new OpencodeClient().parseOptions(help) });
const help = (name: string) => readFileSync(new URL(`../src/options/${name}.txt`, import.meta.url), 'utf8');
test.each([
  ['claude-code', parseClaudeCodeOptions], ['codex', parseCodexOptions],
  ['agy', parseAgyOptions], ['grok', parseGrokOptions], ['opencode', parseOpencodeOptions],
] as const)('parses %s headless fixture without commands or positionals', (client, parse) => {
  const result = parse(help(client));
  expect(result.options.length).toBeGreaterThan(10);
  expect(new Set(result.options.map(o => o.name)).size).toBe(result.options.length);
  expect(result.options.every(o => o.flags.length && o.description)).toBe(true);
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  expect(() => parse('invalid output')).toThrow();
});
test('retains aliases and wrapped descriptions', () => {
  const {options} = parseClaudeCodeOptions(help('claude-code'));
  const tools = options.find(o => o.name === 'allowedTools')!;
  expect(tools.flags).toContain('--allowed-tools');
  expect(tools.argument).toBe('<tools...>');
  expect(tools.description).toContain('Comma or space-separated');
});
test('preserves optional arguments and enums', () => {
  const grok = parseGrokOptions(help('grok')).options;
  expect(grok.find(o => o.name === 'resume')?.valueMode).toBe('optional');
  expect(grok.find(o => o.name === 'permission-mode')?.choices).toContain('plan');
});
test('reads wrapped yargs metadata and does not guess Agy arity', () => {
  const {options} = parseOpencodeOptions(help('opencode'));
  expect(options.find(o => o.name === 'port')?.type).toBe('number');
  expect(options.find(o => o.name === 'format')?.choices).toEqual(['default', 'json']);
  expect(options.find(o => o.name === 'interactive')?.defaultValue).toBe('false');
  expect(parseAgyOptions(help('agy')).options.find(o => o.name === 'effort')?.valueMode).toBe('unknown');
});
