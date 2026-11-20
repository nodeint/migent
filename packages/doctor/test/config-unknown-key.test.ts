import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadWorkspaceConfig, mergeConfigLayers } from '@nodeint/migent-kernel';
import { afterEach, expect, test } from 'vitest';

import { diagnose, validateConfigDraft, validateConfigLayers } from '../src/index.ts';
import { defaultClients, STAGE_CONFIG, STAGE_WORKFLOW, tempDir, whichFound } from './support.ts';

/**
 * Characterization: a top-level key Migent does not know is silently ignored today. Layer-based
 * validation, `doctor` and runtime loading all behave the same with and without it.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PROJECT = {
  schema_version: 8,
  agents: { x: { client: { type: 'codex' }, model: 'm' } },
  roles: { dev: { agent: 'x' } },
};
const UNKNOWN = {
  schema_version: 8, future_section: { example: { enabled: true } } };

test('an unknown top-level key in the project layer adds no diagnostic', () => {
  const clients = defaultClients();
  expect(validateConfigLayers({ project: { ...PROJECT, ...UNKNOWN } }, clients)).toEqual(
    validateConfigLayers({ project: PROJECT }, clients),
  );
});

test('an unknown top-level key in the local layer adds no diagnostic', () => {
  const clients = defaultClients();
  expect(validateConfigLayers({ project: PROJECT, local: UNKNOWN }, clients)).toEqual(
    validateConfigLayers({ project: PROJECT }, clients),
  );
});

test('an unknown top-level key in both layers adds no diagnostic', () => {
  const clients = defaultClients();
  expect(
    validateConfigLayers({ project: { ...PROJECT, ...UNKNOWN }, local: { future_section: { other: 1 } } }, clients),
  ).toEqual(validateConfigLayers({ project: PROJECT }, clients));
});

test('draft validation of the project scope ignores an unknown key', () => {
  const clients = defaultClients();
  const plain = validateConfigDraft({ scope: 'project', draft: PROJECT, companion: null }, clients);
  expect(validateConfigDraft({ scope: 'project', draft: { ...PROJECT, ...UNKNOWN }, companion: null }, clients)).toEqual(plain);
  expect(validateConfigDraft({ scope: 'project', draft: PROJECT, companion: UNKNOWN }, clients)).toEqual(plain);
});

test('draft validation of the local scope ignores an unknown key', () => {
  const clients = defaultClients();
  const plain = validateConfigDraft({ scope: 'local', draft: { schema_version: 8 }, companion: PROJECT }, clients);
  expect(validateConfigDraft({ scope: 'local', draft: UNKNOWN, companion: PROJECT }, clients)).toEqual(plain);
  expect(validateConfigDraft({ scope: 'local', draft: { schema_version: 8 }, companion: { ...PROJECT, ...UNKNOWN } }, clients)).toEqual(plain);
});

test('mergeConfigLayers keeps an unknown top-level key in the merged config without error', () => {
  const merged = mergeConfigLayers({ ...PROJECT, ...UNKNOWN }, null);
  expect(merged.config.future_section).toEqual(UNKNOWN.future_section);
});

function project(withUnknown: boolean, layer: 'project' | 'local'): string {
  const workspace = tempDir('migent-unknown-key-');
  roots.push(workspace);
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  const unknown = 'future_section:\n  example:\n    enabled: true\n';
  const config = path.join(workspace, '.migent', 'config.yaml');
  writeFileSync(config, STAGE_CONFIG + (withUnknown && layer === 'project' ? unknown : ''), 'utf8');
  if (withUnknown && layer === 'local') writeFileSync(path.join(workspace, '.migent', 'config.local.yaml'), unknown, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'plan-implement.yaml'), STAGE_WORKFLOW, 'utf8');
  return workspace;
}

test.each(['project', 'local'] as const)('doctor reports the same with an unknown key in the %s layer', (layer) => {
  const options = { clients: defaultClients(), which: whichFound(new Set(['codex', 'grok'])) };
  const plain = diagnose(project(false, layer), options);
  const withKey = diagnose(project(true, layer), options);
  expect(withKey).toEqual(plain);
  expect(withKey.every((check) => check.ok)).toBe(true);
});

test.each(['project', 'local'] as const)('loading the workspace config does not fail on an unknown key in the %s layer', (layer) => {
  const config = loadWorkspaceConfig(project(true, layer));
  expect(Object.keys(config.roles as object)).toEqual(['developer', 'reviewer']);
});
