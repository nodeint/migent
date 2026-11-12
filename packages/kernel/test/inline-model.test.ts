import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { clientIds, createClient } from '@nodeint/migent-adapters';
import { parseWorkflowMapping } from '@nodeint/migent-workflow';
import { parseYamlDocument } from '@nodeint/migent-workflow';
import { afterEach, expect, test } from 'vitest';
import { stringify } from 'yaml';

import {
type ClientRegistry,
  describeChange, inspectConfig, loadWorkspaceConfig, patchConfigText,
  resolveRoleCascade, resolveRoleTarget, resolveStageSpec, } from '../src/index.ts';

const resolver: ClientRegistry = { ids: () => clientIds(), get: (id: string) => createClient(id) };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const model = { client: { type: 'codex', options: { temperature: '0.2' } }, model: 'test-model', effort: 'high' };
function workspace(config: unknown, local?: unknown): string {
  const root = mkdtempSync(path.join(tmpdir(), 'migent-inline-'));
  roots.push(root);
  mkdirSync(path.join(root, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(root, '.migent', 'config.yaml'), stringify(config));
  if (local !== undefined) writeFileSync(path.join(root, '.migent', 'config.local.yaml'), stringify(local));
  return root;
}

test('inline-only role resolution validates models like aliases', () => {
  const root = workspace({ roles: { dev: { agent: model } } });
  expect(resolveRoleTarget(root, 'dev', { registry: resolver })).toEqual({
    client: 'codex', model: 'test-model', options: { model_reasoning_effort: 'high', temperature: '0.2' },
  });
  const config = loadWorkspaceConfig(root);
  const snapshot = structuredClone(config);
  const view = inspectConfig(config, [], resolver);
  expect(config).toEqual(snapshot);
  expect(describeChange(config, structuredClone(config), { registry: resolver }).roles).toEqual([]);
  expect(view.agents).toEqual([]);
  expect(view.roles[0]).toMatchObject({ agentName: null, sharedWith: [], options: { model_reasoning_effort: 'high' } });
});

test.each(['shared', model])('local inline selection replaces the whole shared default: %j', (shared) => {
  const local = { client: { type: 'grok' }, model: 'local-model' };
  const root = workspace({ agents: { shared: model }, roles: { dev: { agent: shared, responsibilities: ['keep'] } } },
    { roles: { dev: { agent: local } } });
  expect(resolveRoleTarget(root, 'dev', { registry: resolver })).toEqual({ client: 'grok', model: 'local-model', options: {} });
  expect(loadWorkspaceConfig(root).roles).toEqual({ dev: { agent: local, responsibilities: ['keep'] } });
});

test('local alias replaces an inline default', () => {
  const root = workspace({ agents: { shared: model }, roles: { dev: { agent: model } } },
    { roles: { dev: { agent: 'shared' } } });
  expect(resolveRoleTarget(root, 'dev', { registry: resolver }).options.model_reasoning_effort).toBe('high');
});

test.each([
  [null, 'roles.dev.agent'],
  [[], 'roles.dev.agent'],
  [{ model: 'test' }, 'roles.dev.agent.client.type'],
  [{ client: { type: 'codex' } }, 'roles.dev.agent.model'],
  [{ ...model, effort: 3 }, 'roles.dev.agent.effort'],
  [{ ...model, client: { type: 'codex', options: { model_reasoning_effort: 'low' } } }, 'conflicts'],
  [{ ...model, client: { options: { temperature: {} } } }, 'roles.dev.agent.client.options.temperature'],
  ['test-model', 'roles.dev.agent: unknown agent "test-model"'],
])('invalid inline or alias selection points to the field: %j', (selection, error) => {
  expect(() => resolveRoleCascade({ roles: { dev: { agent: selection } } }, 'dev', { registry: resolver })).toThrow(error);
});

test.each([{}, null, { temperature: '0.2' }])('removed role options are rejected: %j', (options) => {
  const config = { roles: { dev: { agent: model, options } } };
  expect(() => resolveRoleCascade(config, 'dev', { registry: resolver })).toThrow('roles.dev.options is no longer supported');
});

test('stage model selection, stage options and CLI options override inline defaults', () => {
  const config = { agents: { other: { client: { type: 'grok' }, model: 'other' } }, roles: { dev: { agent: model } } };
  const workflow = parseWorkflowMapping({ schema_version: 2, stages: [
    { id: 'inline', role: 'dev', options: { model_reasoning_effort: 'low' } },
    { id: 'named', role: 'dev', model: 'other' },
  ] }, 'test');
  const inline = workflow.stages.inline!;
  const named = workflow.stages.named!;
  if (inline.kind !== 'role' || named.kind !== 'role') throw new Error('expected roles');
  expect(resolveStageSpec(config, inline, { registry: resolver }).options.model_reasoning_effort).toBe('low');
  expect(resolveStageSpec(config, inline, { options: { model_reasoning_effort: 'medium' }, registry: resolver }).options.model_reasoning_effort).toBe('medium');
  expect(resolveStageSpec(config, named, { registry: resolver })).toEqual({ client: 'grok', model: 'other', options: {} });
});

test('text patching supports alias and inline transitions and keeps role instructions', () => {
  let text = '# keep\nroles:\n  dev:\n    agent: shared\n    instructions:\n      - Keep instructions.\n';
  for (const selection of [model, { client: { type: 'grok' }, model: 'local' }, 'shared']) {
    const updated = { roles: { dev: { agent: selection, responsibilities: ['Keep instructions.'] } } };
    text = patchConfigText(text, updated);
    expect(parseYamlDocument(text)).toEqual(updated);
    expect(text).toContain('# keep');
  }
});
