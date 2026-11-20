import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { analyzeConfig } from '@nodeint/migent-doctor';
import { expect, test } from 'vitest';

import { clientRegistry, pluginRegistry } from '../src/client.ts';
import { runDoctor } from '../src/commands/doctor.ts';
import { capture } from './support.ts';

const which = (command: string) => `/fake/${command}`;
const catalog = (): string => 'Available models:\n  - grok-4\n';

const config = (agentExtra: string, plugins: string): string => `schema_version: 8
agents:
  dev:
    client: { type: grok }
    model: grok-4
${agentExtra}roles:
  developer:
    agent: dev
${plugins}`;

const POLICIES = (body: string) => `plugins:\n  prompt_cache_ttl:\n    policies:\n      default:\n        ${body}\n`;

const PLAIN_WORKFLOW = 'schema_version: 8\nstages:\n  - id: work\n    role: developer\n';

type Diagnosis = { code: number; problems: string };

async function diagnose(configText: string, workflowText = PLAIN_WORKFLOW): Promise<Diagnosis> {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-doctor-cache-ttl-'));
  try {
    mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
    writeFileSync(path.join(workspace, '.migent', 'config.yaml'), configText);
    writeFileSync(path.join(workspace, '.migent', 'workflows', 'flow.yaml'), workflowText);
    const result = await capture(() => runDoctor(workspace, {
      asJson: true, which, runCommand: catalog, home: workspace,
    }));
    const checks = JSON.parse(result.stdout).checks as { problems: string[] }[];
    return { code: result.value, problems: checks.flatMap((check) => check.problems).join('\n') };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

test('a valid cache policy passes', async () => {
  const result = await diagnose(config('', POLICIES('cache_ttl: 5m')));
  expect(result.problems).toBe('');
  expect(result.code).toBe(0);
});

test('a policy without cache_ttl is a config error', async () => {
  const result = await diagnose(config('', POLICIES('margin: 30s')));
  expect(result.code).not.toBe(0);
  expect(result.problems).toContain('cache_ttl');
});

test('an agent naming an unknown policy is a config error', async () => {
  const result = await diagnose(config('    prompt_cache_ttl:\n      policy: nope\n', POLICIES('cache_ttl: 5m')));
  expect(result.code).not.toBe(0);
  expect(result.problems).toContain('nope');
});

test('an agent naming a policy is an error when no policies are configured at all', async () => {
  const result = await diagnose(config('    prompt_cache_ttl:\n      policy: typo\n', ''));
  expect(result.code).not.toBe(0);
  expect(result.problems).toContain('typo');
});

test('a workflow inline agent naming an unknown policy is a doctor error', async () => {
  const workflow = 'schema_version: 8\nstages:\n  - id: work\n    role: developer\n    agent:\n      client: { type: grok }\n      model: grok-4\n      prompt_cache_ttl:\n        policy: typo\n';
  const result = await diagnose(config('', POLICIES('cache_ttl: 5m')), workflow);
  expect(result.code).not.toBe(0);
  expect(result.problems).toContain('typo');
});

// The config check reports structured diagnostics: code, document path and config layer, not only text.
const analyze = (config: Record<string, unknown>, layer: 'project' | 'local') => analyzeConfig(config, clientRegistry(), {
  effortChecks: {}, ownerOf: () => layer, plugins: pluginRegistry(),
}).diagnostics.errors;

const BASE_AGENT = { client: { type: 'grok' }, model: 'grok-4' };
const withPlugins = (policies: unknown, agent: Record<string, unknown> = {}) => ({
  schema_version: 8,
  agents: { dev: { ...BASE_AGENT, ...agent } },
  roles: { developer: { agent: 'dev' } },
  plugins: { prompt_cache_ttl: { policies } },
});

test('a policy without cache_ttl is reported with its code, path and layer', () => {
  const [error, ...rest] = analyze(withPlugins({ default: { margin: '30s' } }), 'local');
  expect(rest).toEqual([]);
  expect(error).toMatchObject({
    code: 'resume-policy-invalid',
    path: ['plugins', 'prompt_cache_ttl', 'policies', 'default', 'cache_ttl'],
    source: { layer: 'local' },
  });
});

test('an unknown agent policy is reported at the agent selector with the project layer', () => {
  const agent = { prompt_cache_ttl: { policy: 'nope' } };
  const [error] = analyze(withPlugins({ default: { cache_ttl: '5m' } }, agent), 'project');
  expect(error).toMatchObject({
    code: 'resume-policy-invalid',
    path: ['agents', 'dev', 'prompt_cache_ttl', 'policy'],
    source: { layer: 'project' },
  });
  expect(error?.message).toContain('nope');
});

test('overlapping policies on an inferred-client agent are reported once, at the agent', () => {
  const policies = { a: { match: { client: 'grok' }, cache_ttl: '5m' }, b: { match: { client: 'grok' }, cache_ttl: '1h' } };
  const inferred = { agents: { dev: { model: 'grok-4' } } };
  const clients = { ...clientRegistry(), clientsForModel: () => ({ matches: ['grok'], searched: ['grok'], skipped: [], failed: [] }) };
  const { errors } = analyzeConfig({ ...withPlugins(policies), ...inferred }, clients, {
    effortChecks: {}, ownerOf: () => 'project', plugins: pluginRegistry(),
  }).diagnostics;
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ code: 'resume-policy-invalid', path: ['agents', 'dev'], source: { layer: 'project' } });
  expect(errors[0]?.message).toContain('Several resume policies match grok/grok-4: a, b');
});

test('a workflow inline agent problem names the workflow and the inline agent path', async () => {
  const workflow = 'schema_version: 8\nstages:\n  - id: work\n    role: developer\n    agent:\n      client: { type: grok }\n      model: grok-4\n      prompt_cache_ttl:\n        policy: typo\n';
  const result = await diagnose(config('', POLICIES('cache_ttl: 5m')), workflow);
  expect(result.problems).toMatch(/^flow: stages\.work\.agent: /m);
});
