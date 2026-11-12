import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { analyzeNativeOptions, collectNativeOptionFacts, diagnose } from '../src/index.ts';
import { adaptersClients, tempDir, whichFound } from './support.ts';

const sample = (name: string): string =>
  readFileSync(new URL(`../../adapters/src/options/${name}.txt`, import.meta.url), 'utf8');
const HELP: Record<string, string> = { 'claude-code': sample('claude-code'), grok: sample('grok'), agy: sample('agy') };

const runHelp = (calls: string[][] = []) => (argv: string[]): string => {
  calls.push(argv);
  const text = Object.entries(HELP).find(([id]) => adaptersClients().get(id).command === argv[0])?.[1];
  if (text === undefined) throw new Error(`no help for ${argv[0]}`);
  return text;
};

async function analyze(client: string, options: Record<string, string>): Promise<{ code: string; message: string }[]> {
  const clients = adaptersClients();
  const facts = await collectNativeOptionFacts(clients, { which: whichFound(new Set(['claude', 'grok', 'agy'])), runCommand: runHelp() });
  return analyzeNativeOptions(clients.get(client), options, facts);
}

test('a documented option that Migent does not curate passes (the issue config)', async () => {
  expect(await analyze('claude-code', { autocompact: '200000', effort: 'high' })).toEqual([]);
});

test('a key missing from help is option-unknown and names the flag and help command', async () => {
  const [finding] = await analyze('claude-code', { temperature: '1' });
  expect(finding).toMatchObject({ code: 'option-unknown' });
  expect(finding?.message).toContain('--temperature');
  expect(finding?.message).toContain('claude -p --help');
});

test('choices, value mode and literal booleans are checked against help', async () => {
  expect((await analyze('claude-code', { permission_mode: 'yolo' }))[0]?.code).toBe('option-value-invalid');
  expect((await analyze('claude-code', { permission_mode: 'plan' }))).toEqual([]);
  expect((await analyze('claude-code', { brief: 'maybe' }))[0]?.code).toBe('option-value-invalid');
  expect((await analyze('claude-code', { brief: 'true' }))).toEqual([]);
  expect((await analyze('claude-code', { fallback_model: 'true' }))[0]?.code).toBe('option-value-invalid');
});

test('description aliases resolve: grok allowed_tools is --allow, and conflicts are reported', async () => {
  expect(await analyze('grok', { allowed_tools: 'x' })).toEqual([]);
  expect((await analyze('grok', { allow: 'a', allowed_tools: 'b' }))[0]?.code).toBe('option-conflict');
  // `effort` reaches the effort policy key through a help alias: refused offline, before doctor.
  expect(() => adaptersClients().get('grok').validateOptions({ effort: 'high' })).toThrow(/set by reasoning-effort/);
  expect(await analyze('grok', { 'reasoning-effort': 'high' })).toEqual([]);
});

test('agy has no value modes, so only existence is checked', async () => {
  expect(await analyze('agy', { mode: 'plan', json_schema: '{}' })).toEqual([]);
  expect((await analyze('agy', { nope: 'x' }))[0]?.code).toBe('option-unknown');
});

test('help that cannot be read downgrades to option-unverified', async () => {
  const clients = adaptersClients();
  const missing = await collectNativeOptionFacts(clients, { which: () => null, runCommand: runHelp() });
  const failing = await collectNativeOptionFacts(clients, {
    which: whichFound(new Set(['claude'])),
    runCommand: () => { throw new Error('boom'); },
  });
  for (const facts of [missing, failing]) {
    const [finding] = analyzeNativeOptions(clients.get('claude-code'), { anything: 'x' }, facts);
    expect(finding).toMatchObject({ severity: 'warning', code: 'option-unverified' });
  }
});

test('without facts nothing is reported and no process runs', () => {
  const clients = adaptersClients();
  expect(analyzeNativeOptions(clients.get('claude-code'), { temperature: '1' }, undefined)).toEqual([]);
});

test('help is read once per client', async () => {
  const calls: string[][] = [];
  await collectNativeOptionFacts(adaptersClients(), { which: whichFound(new Set(['claude', 'grok', 'agy'])), runCommand: runHelp(calls) });
  expect(calls.filter((argv) => argv[0] === 'claude')).toHaveLength(1);
});

function project(config: string, stageOptions = ''): string {
  const workspace = tempDir('migent-native-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), config, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'w.yaml'), `schema_version: 7
id: w
stages:
  - id: build
    role: dev
    depends_on: []
${stageOptions}    responsibilities: []
`, 'utf8');
  return workspace;
}

const CONFIG = (options: string): string => `schema_version: 7
agents:
  a:
    client:
      type: claude-code
      options:
${options}
    model: opus
roles:
  dev:
    agent: a
`;

test('doctor checks config options against facts and reports a config error once', async () => {
  const clients = adaptersClients();
  const which = whichFound(new Set(['claude']));
  const nativeOptionFacts = await collectNativeOptionFacts(clients, { which, runCommand: runHelp() });
  const workspace = project(CONFIG('        autocompact: 200000\n        temperature: "1"'));
  const [config, workflows] = diagnose(workspace, { clients, which, nativeOptionFacts });
  expect(config.problems.filter((item) => item.includes('--temperature'))).toHaveLength(1);
  expect(workflows.problems.join('\n')).not.toContain('--temperature');
  const ok = diagnose(project(CONFIG('        autocompact: 200000')), { clients, which, nativeOptionFacts });
  expect(ok[0].ok).toBe(true);
});

test('static diagnose without facts adds no help-based findings', () => {
  const workspace = project(CONFIG('        temperature: "1"'));
  const [config] = diagnose(workspace, { clients: adaptersClients(), which: whichFound(new Set(['claude'])) });
  expect(config.ok).toBe(true);
});

test('grok singular compat aliases resolve and conflict like the plural ones', async () => {
  expect(await analyze('grok', { system_prompt: 'hello' })).toEqual([]);
  expect((await analyze('grok', { system_prompt: 'a', system_prompt_override: 'b' }))[0]?.code).toBe('option-conflict');
});
