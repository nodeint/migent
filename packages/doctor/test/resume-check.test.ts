import { appendFileSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { diagnose } from '../src/index.ts';
import { defaultClients, STAGE_CONFIG, STAGE_WORKFLOW, tempDir, whichFound } from './support.ts';

function project(extraConfig: string): string {
  const workspace = tempDir('migent-doctor-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), STAGE_CONFIG, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'plan-implement.yaml'), STAGE_WORKFLOW, 'utf8');
  appendFileSync(path.join(workspace, '.migent', 'config.yaml'), `\n${extraConfig}`);
  return workspace;
}

const run = (workspace: string) => diagnose(workspace, { clients: defaultClients(), which: whichFound(new Set(['codex', 'grok'])) })[0];

test('a valid resume policy passes', () => {
  expect(run(project('resume_policies:\n  default:\n    cache_ttl: 5m\n')).ok).toBe(true);
});

test('a policy without cache_ttl is a config error', () => {
  const result = run(project('resume_policies:\n  default:\n    margin: 30s\n'));
  expect(result.ok).toBe(false);
  expect(result.problems.join('\n')).toContain('cache_ttl');
});

test('an agent naming an unknown policy is a config error', () => {
  const config = STAGE_CONFIG.replace(/(agents:\n\s+\w+:\n)/, '$1      resume_policy: nope\n');
  const workspace = project('resume_policies:\n  default:\n    cache_ttl: 5m\n');
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), `${config}\nresume_policies:\n  default:\n    cache_ttl: 5m\n`);
  const result = run(workspace);
  expect(result.ok).toBe(false);
  expect(result.problems.join('\n')).toContain('nope');
});

test('an agent naming a policy is an error when no policies are configured at all', () => {
  const config = STAGE_CONFIG.replace(/(agents:\n\s+\w+:\n)/, '$1      resume_policy: typo\n');
  const workspace = project('');
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), config);
  const result = run(workspace);
  expect(result.ok).toBe(false);
  expect(result.problems.join('\n')).toContain('typo');
});
