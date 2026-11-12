import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadWorkflowDocument } from '@nodeint/migent-workflow';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

import { discoverAgentSlots, type ModelChoice, projectTemplateDirectory, renderProject } from '../src/project-template.js';

const root = new URL('../../../templates/', import.meta.url);
const choice = (client: string, model: string, options: Record<string, string> = {}): ModelChoice => ({
  client,
  model,
  options,
});
const models = {
  planning: choice('codex', 'gpt-5', { model_reasoning_effort: 'high' }),
  review: choice('grok', '123'),
  coding: { ...choice('claude-code', 'true'), effort: 'low' },
};

function templateCopy(edit: (config: string) => string = (config) => config): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'migent-tpl-'));
  cpSync(new URL('.', root), dir, { recursive: true });
  writeFileSync(path.join(dir, 'config.yaml'), edit(readFileSync(path.join(dir, 'config.yaml'), 'utf8')));
  return dir;
}

test('discovers ordered agent slots with the roles that use them', () => {
  expect(discoverAgentSlots()).toEqual([
    { name: 'planning', roles: ['architect'] },
    { name: 'review', roles: ['reviewer'] },
    { name: 'coding', roles: ['developer', 'operator'] },
  ]);
});

test('renders each agent slot once and keeps roles pointing at them', () => {
  const files = renderProject(models);
  type TemplateRole = { agent?: unknown; responsibilities: string[]; description?: string };
  const config = parse(files[0]!.content) as { agents: Record<string, unknown>; roles: Record<string, TemplateRole> };
  const local = parse(files[1]!.content) as { roles: Record<string, unknown> };
  const template = parse(readFileSync(new URL('config.yaml', root), 'utf8')) as typeof config;
  expect(config.agents).toEqual({
    planning: { model: 'gpt-5', client: { type: 'codex', options: { model_reasoning_effort: 'high' } } },
    review: { model: '123', client: { type: 'grok' } },
    coding: { model: 'true', effort: 'low', client: { type: 'claude-code' } },
  });
  expect(Object.keys(config.agents)).toEqual(['planning', 'review', 'coding']);
  for (const [role, node] of Object.entries(template.roles)) {
    expect(config.roles[role]?.agent).toBe(node.agent);
    expect(config.roles[role]?.responsibilities).toEqual(node.responsibilities);
    expect(config.roles[role]?.description).toMatch(/\S/);
  }
  expect(Object.keys(config.roles)).toEqual(['architect', 'reviewer', 'developer', 'operator']);
  expect(local.roles).toEqual({});
  expect(files[0]!.content).not.toContain('{{');
});

test('render requires models for exactly the template agents', () => {
  expect(() => renderProject({ planning: models.planning })).toThrow(/exactly the template agents/);
  expect(() => renderProject({ ...models, extra: models.coding })).toThrow(/exactly the template agents/);
});

test('extra role and slot in a template are rendered without code changes', () => {
  const dir = templateCopy((config) => config.replace('agents:\n', 'agents:\n  docs:\n    model: "{{agent}}"\n')
    + '  writer:\n    description: Writes docs.\n    agent: docs\n    responsibilities:\n      - "Write."\n');
  try {
    expect(discoverAgentSlots(dir).map((slot) => slot.name)).toEqual(['docs', 'planning', 'review', 'coding']);
    const config = parse(renderProject({ ...models, docs: choice('codex', 'gpt-5') }, dir)[0]!.content) as {
      agents: Record<string, unknown>;
    };
    expect(config.agents.docs).toEqual({ model: 'gpt-5', client: { type: 'codex' } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('copies workflows byte for byte and they validate', () => {
  const files = renderProject(models);
  expect(files.map((file) => file.path)).toEqual([
    '.migent/config.yaml', '.migent/config.local.yaml', '.migent/workflows/implement.yaml', '.migent/workflows/plan.yaml', '.migent/.gitignore',
  ]);
  for (const name of ['implement', 'plan']) {
    const file = files.find((item) => item.path.endsWith(`${name}.yaml`) && item.path.includes('workflows'))!;
    expect(file.content).toBe(readFileSync(new URL(`workflows/${name}.yaml`, root), 'utf8'));
    const dir = mkdtempSync(path.join(os.tmpdir(), 'migent-tpl-'));
    try {
      cpSync(new URL(`workflows/${name}.yaml`, root), path.join(dir, `${name}.yaml`));
      expect(loadWorkflowDocument(path.join(dir, `${name}.yaml`)).id).toBe(name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('missing assets fail naming the asset', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'migent-tpl-'));
  try {
    expect(() => renderProject(models, dir)).toThrow(/config\.yaml/);
    cpSync(new URL('.', root), dir, { recursive: true });
    cpSync(path.join(dir, 'config.yaml'), path.join(dir, 'orig.yaml'));
    rmSync(path.join(dir, 'workflows', 'plan.yaml'));
    expect(() => renderProject(models, dir)).toThrow(/workflows\/plan\.yaml/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('template integrity failures name the file and node path', () => {
  const cases: [string, (config: string) => string, RegExp][] = [
    ['no agents', (config) => config.replace(/agents:\n( {2}.*\n){6}/, ''), /config\.yaml.*agents/],
    ['filled agent', (config) => config.replace('model: "{{agent}}"', 'model: gpt-5'), /agents\.planning/],
    ['role without agent', (config) => config.replace('    agent: planning\n', ''), /roles\.architect\.agent/],
    ['undefined agent', (config) => config.replace('agent: coding', 'agent: missing'), /roles\.developer\.agent/],
    ['unused slot', (config) => config.replace('agents:\n', 'agents:\n  spare:\n    model: "{{agent}}"\n'), /agents\.spare is used by no role/],
    ['no roles', (config) => config.slice(0, config.indexOf('roles:')), /config\.yaml.*roles/],
  ];
  for (const [name, edit, message] of cases) {
    const dir = templateCopy(edit);
    try {
      expect(() => discoverAgentSlots(dir), name).toThrow(message);
      expect(() => renderProject(models, dir), name).toThrow(message);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a preset naming an undefined role or agent fails validation', () => {
  for (const [from, to, message] of [
    ['role: architect', 'role: ghost', /workflows\/plan\.yaml.*stages\[0\]\.role.*ghost/],
    ['role: architect', 'role: architect\n    agent: ghost', /workflows\/plan\.yaml.*stages\[0\]\.agent.*ghost/],
  ] as const) {
    const dir = templateCopy();
    try {
      const file = path.join(dir, 'workflows', 'plan.yaml');
      writeFileSync(file, readFileSync(file, 'utf8').replace(from, to));
      expect(() => discoverAgentSlots(dir)).toThrow(message);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('source layout reads root templates; compiled layout never falls back', () => {
  expect(projectTemplateDirectory()).toBe(path.resolve(fileURLToPath(root)));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'migent-dist-'));
  try {
    const module = pathToFileURL(path.join(dir, 'project-template.js')).href;
    expect(() => projectTemplateDirectory(module)).toThrow(/Packaged project templates are missing/);
    cpSync(new URL('.', root), path.join(dir, 'templates', 'project'), { recursive: true });
    expect(projectTemplateDirectory(module)).toBe(path.join(dir, 'templates', 'project'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
