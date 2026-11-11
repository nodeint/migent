import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadWorkflowDocument } from '@nodeint/migent-workflow';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

import { type ModelChoice,projectTemplateDirectory, renderProject } from '../src/project-template.js';

const root = new URL('../../../templates/', import.meta.url);
const choice = (client: string, model: string, options: Record<string, string> = {}): ModelChoice => ({ client, model, options });
const models = {
  planner: choice('codex', 'gpt-5', { model_reasoning_effort: 'high' }),
  reviewer: choice('grok', '123'),
  developer: choice('claude-code', 'true'),
};

test('renders config models independently and keeps template content', () => {
  const files = renderProject(models);
  const config = parse(files[0]!.content) as { roles: Record<string, { agent?: unknown; responsibilities: string[]; description?: string }> };
  const local = parse(files[1]!.content) as { roles: Record<string, unknown> };
  const template = parse(readFileSync(new URL('config.yaml', root), 'utf8')) as typeof config;
  expect(config.roles.planner?.agent).toEqual({ model: 'gpt-5', client: { type: 'codex', options: { model_reasoning_effort: 'high' } } });
  expect(config.roles.reviewer?.agent).toEqual({ model: '123', client: { type: 'grok' } });
  expect(config.roles.developer?.agent).toEqual({ model: 'true', client: { type: 'claude-code' } });
  for (const role of ['planner', 'reviewer', 'developer']) {
    expect(config.roles[role]?.responsibilities).toEqual(template.roles[role]?.responsibilities);
    expect(config.roles[role]?.description).toMatch(/\S/);
    expect(local.roles).toEqual({});
  }
  expect(files[0]!.content).not.toContain('{{');
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

test('missing assets and missing role nodes fail naming the asset', () => {
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

test('a template without a role fails with the role path', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'migent-tpl-'));
  try {
    cpSync(new URL('.', root), dir, { recursive: true });
    cpSync(new URL('workflows/plan.yaml', root), path.join(dir, 'config.yaml'));
    expect(() => renderProject(models, dir)).toThrow(/roles\.planner/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a template without agent fails with the full node path', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'migent-tpl-'));
  try {
    cpSync(new URL('.', root), dir, { recursive: true });
    const config = readFileSync(path.join(dir, 'config.yaml'), 'utf8').replace('    agent: "{{planner.agent}}"', '    other: value');
    writeFileSync(path.join(dir, 'config.yaml'), config);
    expect(() => renderProject(models, dir)).toThrow(/roles\.planner\.agent/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a wrong model placeholder fails with the full node path', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'migent-tpl-'));
  try {
    cpSync(new URL('.', root), dir, { recursive: true });
    const config = readFileSync(path.join(dir, 'config.yaml'), 'utf8').replace('{{planner.agent}}', '{{reviewer.agent}}');
    writeFileSync(path.join(dir, 'config.yaml'), config);
    expect(() => renderProject(models, dir)).toThrow(/roles\.planner\.agent/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
