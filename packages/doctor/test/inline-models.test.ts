import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';
import { stringify } from 'yaml';

import { diagnose } from '../src/index.ts';
import { adaptersClients } from './support.ts';

const clients = adaptersClients();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const model = { client: { type: 'codex', options: { temperature: '0.2' } }, model: 'test-model', effort: 'high' };
const which = () => '/fake/client';

function workspace(config: unknown): string {
  const root = mkdtempSync(path.join(tmpdir(), 'migent-inline-'));
  roots.push(root);
  mkdirSync(path.join(root, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(root, '.migent', 'config.yaml'), stringify(config));
  return root;
}

test('an inline-only role passes the same model validation as an alias', () => {
  const checks = diagnose(workspace({ roles: { dev: { agent: model } } }), { clients, which });
  expect(checks[0].problems).toEqual([]);
  expect(checks[2].ok).toBe(true);
  expect(checks[2].items.join(' ')).toContain('codex');
});

test.each([{}, null, { temperature: '0.2' }])('removed role options are reported: %j', (options) => {
  const checks = diagnose(workspace({ roles: { dev: { agent: model, options } } }), { clients, which });
  expect(checks[0].problems.join(' ')).toContain('roles.dev.options is no longer supported');
});

test.each([
  { model: 'test' },
  { client: { type: 'unknown' }, model: 'test' },
  { client: { type: 'codex' } },
])('inline client is validated: %j', (definition) => {
  const checks = diagnose(workspace({ roles: { dev: { agent: definition } } }), { clients, which });
  expect(checks[0].ok).toBe(false);
  expect(checks[0].problems.join(' ')).toContain('roles.dev.agent');
});

test('an inline client selects the effective CLI', () => {
  const definition = { client: { type: 'codex' }, model: 'test', effort: 'high' };
  expect(diagnose(workspace({ roles: { dev: { agent: definition } } }), { clients, which })[0].ok).toBe(true);
});
