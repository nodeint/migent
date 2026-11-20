import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseWorkflowMapping } from '@nodeint/migent-workflow';
import { afterEach, expect, test } from 'vitest';

import type { PluginFreezeInput } from '../src/index.ts';
import { WORKFLOW_FREEZE_FILE, writeWorkflowFreeze } from '../src/session-freeze.ts';

/** Characterization: the exact bytes of `workflow.frozen.yaml`, so a config-section seam cannot change them. */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BASE = `roles:
  developer:
    agent: dev
agents:
  dev:
    client: { type: fake }
    model: fake-1
`;

const POLICIES = `plugins:
  prompt_cache_ttl:
    policies:
      fake:
        match: { client: fake }
        cache_ttl: 5m
        on_expired: fresh
`;

/** A host stand-in: every `plugins` entry is frozen, enabled, at version 1.0.0. Session imports no plugin. */
const PLUGIN_STUB: PluginFreezeInput = {
  classify: () => 'frozen',
  snapshot: (config) => Object.keys(config.plugins as Record<string, unknown>)
    .map((id) => ({ id, enabled: true, advisory: false, version: '1.0.0', target: null })),
};

function frozenText(config: string, local = ''): string {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-freeze-bytes-'));
  dirs.push(workspace);
  mkdirSync(path.join(workspace, '.migent'));
  writeFileSync(path.join(workspace, '.migent/config.yaml'), config);
  if (local !== '') writeFileSync(path.join(workspace, '.migent/config.local.yaml'), local);
  const workflow = parseWorkflowMapping(
    { schema_version: 8, id: 'flow', stages: [{ id: 'a', role: 'developer', depends_on: [] }] },
    'flow.yaml',
  );
  writeWorkflowFreeze(workspace, { workspace, workflow, plugins: PLUGIN_STUB });
  return readFileSync(path.join(workspace, WORKFLOW_FREEZE_FILE), 'utf8');
}

test('freeze bytes without plugin policies', () => {
  expect(frozenText(BASE)).toMatchInlineSnapshot(`
    "schema_version: 2
    source_sha256: null
    workflow:
      schema_version: 8
      id: flow
      concurrency: 1
      constraints: []
      stages:
        - id: a
          depends_on: []
          role: developer
    roles:
      developer: []
    targets:
      a:
        client: fake
        model: fake-1
        options: {}
    extensions:
      prompt_cache_ttl:
        version: 1
        keys:
          workflow: []
          stage: []
          agent: []
          role: []
      next:
        version: 1
        keys:
          workflow: []
          stage: []
          agent: []
          role: []
    "
  `);
});

test('freeze bytes with plugin policies', () => {
  expect(frozenText(BASE + POLICIES)).toMatchInlineSnapshot(`
    "schema_version: 2
    source_sha256: null
    workflow:
      schema_version: 8
      id: flow
      concurrency: 1
      constraints: []
      stages:
        - id: a
          depends_on: []
          role: developer
    roles:
      developer: []
    targets:
      a:
        client: fake
        model: fake-1
        options: {}
    config:
      plugins:
        entries:
          prompt_cache_ttl:
            policies:
              fake:
                match:
                  client: fake
                cache_ttl: 5m
                on_expired: fresh
        live_entries: []
    extensions:
      prompt_cache_ttl:
        version: 1
        keys:
          workflow: []
          stage: []
          agent: []
          role: []
      next:
        version: 1
        keys:
          workflow: []
          stage: []
          agent: []
          role: []
    "
  `);
});

test('an unknown top-level config key does not change the freeze bytes', () => {
  const unknown = 'future_section:\n  example:\n    enabled: true\n';
  expect(frozenText(BASE + unknown)).toBe(frozenText(BASE));
  expect(frozenText(BASE + POLICIES + unknown)).toBe(frozenText(BASE + POLICIES));
});

test('an unknown top-level key in the local layer does not change the freeze bytes', () => {
  const unknown = 'future_section:\n  example:\n    enabled: true\n';
  expect(frozenText(BASE, unknown)).toBe(frozenText(BASE));
  expect(frozenText(BASE + POLICIES, unknown)).toBe(frozenText(BASE + POLICIES));
});
