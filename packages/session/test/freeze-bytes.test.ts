import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseWorkflowMapping } from '@nodeint/migent-workflow';
import { afterEach, expect, test } from 'vitest';

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

const POLICIES = `resume_policies:
  fake:
    match: { client: fake }
    cache_ttl: 5m
    on_expired: fresh
`;

function frozenText(config: string, local = ''): string {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-freeze-bytes-'));
  dirs.push(workspace);
  mkdirSync(path.join(workspace, '.migent'));
  writeFileSync(path.join(workspace, '.migent/config.yaml'), config);
  if (local !== '') writeFileSync(path.join(workspace, '.migent/config.local.yaml'), local);
  const workflow = parseWorkflowMapping(
    { schema_version: 7, id: 'flow', stages: [{ id: 'a', role: 'developer', depends_on: [] }] },
    'flow.yaml',
  );
  writeWorkflowFreeze(workspace, { workspace, workflow });
  return readFileSync(path.join(workspace, WORKFLOW_FREEZE_FILE), 'utf8');
}

test('freeze bytes without resume_policies', () => {
  expect(frozenText(BASE)).toMatchInlineSnapshot(`
    "schema_version: 2
    source_sha256: null
    workflow:
      schema_version: 7
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
    "
  `);
});

test('freeze bytes with resume_policies', () => {
  expect(frozenText(BASE + POLICIES)).toMatchInlineSnapshot(`
    "schema_version: 2
    source_sha256: null
    workflow:
      schema_version: 7
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
        resume_policy: fake
    resume_policies:
      fake:
        match:
          client: fake
        cache_ttl: 5m
        on_expired: fresh
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
