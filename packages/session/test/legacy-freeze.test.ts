import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { readLegacyFreeze, readLegacyRoleStamp } from '../src/legacy-freeze.ts';
import { readWorkflowFreeze, WORKFLOW_FREEZE_FILE } from '../src/session-freeze.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A freeze exactly as the pre-#167 writer produced it (schema 7 workflow, top-level policies and per-target name). */
const LEGACY_FREEZE = `schema_version: 2
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
      session:
        on_expired: fresh
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
`;

function sessionWith(text: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'migent-legacy-freeze-'));
  dirs.push(directory);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, WORKFLOW_FREEZE_FILE), text);
  return directory;
}

test('a pre-#167 freeze reads as prompt_cache_ttl values and the file is not written', () => {
  const directory = sessionWith(LEGACY_FREEZE);
  const loaded = readWorkflowFreeze(directory);
  expect(loaded?.legacy.options).toEqual({ prompt_cache_ttl: { policies: { fake: { match: { client: 'fake' }, cache_ttl: '5m' } } } });
  expect(loaded?.legacy.targets).toEqual({ a: { prompt_cache_ttl: { prompt_cache_ttl: { policy: 'fake' } } } });
  expect(loaded?.legacy.stages).toEqual({ a: { prompt_cache_ttl: { prompt_cache_ttl: { on_expired: 'fresh' } } } });
  expect(readFileSync(path.join(directory, WORKFLOW_FREEZE_FILE), 'utf8')).toBe(LEGACY_FREEZE);
});

test('a freeze without policies has no legacy data', () => {
  const { legacy } = readLegacyFreeze({ workflow: { stages: [{ id: 'a', role: 'developer', depends_on: [] }] }, targets: { a: { client: 'fake' } } });
  expect(legacy).toEqual({ options: {}, targets: {}, stages: {} });
});

test('the stripped workflow drops only the legacy keys and keeps resume_from', () => {
  const { workflow } = readLegacyFreeze({
    workflow: { stages: [{ id: 'a', session: { resume_from: 'x', on_expired: 'ask' }, agent: { model: 'm', resume_policy: 'p' } }] },
  });
  expect(workflow.stages).toEqual([{ id: 'a', session: { resume_from: 'x' }, agent: { model: 'm' } }]);
});

test('a role stamp reads as the entry options and the role agent value', () => {
  expect(readLegacyRoleStamp({ name: 'fake', policies: { fake: { cache_ttl: '5m' } } })).toEqual({
    options: { policies: { fake: { cache_ttl: '5m' } } },
    agent: { prompt_cache_ttl: { prompt_cache_ttl: { policy: 'fake' } } },
  });
  expect(readLegacyRoleStamp({ name: '', policies: {} })).toBeNull();
  expect(readLegacyRoleStamp(null)).toBeNull();
});
