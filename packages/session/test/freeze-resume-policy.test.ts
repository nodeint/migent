import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseWorkflowMapping } from '@nodeint/migent-workflow';
import { afterEach, describe, expect, test } from 'vitest';

import { frozenResumePolicy, readWorkflowFreeze, WORKFLOW_FREEZE_FILE, writeWorkflowFreeze } from '../src/session-freeze.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CONFIG = (extra: string) => `roles:
  developer:
    agent: dev
agents:
  dev:
    client: { type: fake }
    model: fake-1
${extra}`;

const POLICIES = `resume_policies:
  fake:
    match: { client: fake }
    cache_ttl: 5m
    on_expired: fresh
  default:
    cache_ttl: 1h
`;

function freeze(config: string): { workspace: string; session: string } {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-freeze-policy-'));
  dirs.push(workspace);
  mkdirSync(path.join(workspace, '.migent'));
  writeFileSync(path.join(workspace, '.migent/config.yaml'), config);
  const workflow = parseWorkflowMapping(
    { schema_version: 7, id: 'flow', stages: [{ id: 'a', role: 'developer', depends_on: [] }] },
    'flow.yaml',
  );
  writeWorkflowFreeze(workspace, { workspace, workflow });
  return { workspace, session: workspace };
}

describe('frozen resume policy', () => {
  test('round-trips the selected policy and the policy map', () => {
    const { session } = freeze(CONFIG(POLICIES));
    const loaded = readWorkflowFreeze(session);
    expect(loaded?.resumePolicyNames).toEqual({ a: 'fake' });
    expect(frozenResumePolicy(loaded!, 'a')).toMatchObject({ name: 'fake', cacheTtlSec: 300, onExpired: 'fresh' });
  });

  test('an agent resume_policy name wins over a match', () => {
    const { session } = freeze(CONFIG(POLICIES).replace('model: fake-1', 'model: fake-1\n    resume_policy: default'));
    expect(frozenResumePolicy(readWorkflowFreeze(session)!, 'a')?.name).toBe('default');
  });

  test('no policies gives no field and no gate', () => {
    const { session } = freeze(CONFIG(''));
    const text = readFileSync(path.join(session, WORKFLOW_FREEZE_FILE), 'utf8');
    expect(text).not.toContain('resume_polic');
    expect(frozenResumePolicy(readWorkflowFreeze(session)!, 'a')).toBeNull();
  });

  test('an old freeze without the field reads as null', () => {
    const { session } = freeze(CONFIG(POLICIES));
    const file = path.join(session, WORKFLOW_FREEZE_FILE);
    const stripped = readFileSync(file, 'utf8').replace(/ {4}resume_policy: .*\n/, '').replace(/resume_policies:[\s\S]*$/, '');
    writeFileSync(file, stripped);
    expect(frozenResumePolicy(readWorkflowFreeze(session)!, 'a')).toBeNull();
  });

  test('an override selects again from the frozen map', () => {
    const { session } = freeze(CONFIG(POLICIES));
    const loaded = readWorkflowFreeze(session)!;
    expect(frozenResumePolicy(loaded, 'a', { client: 'other', model: 'm' })?.name).toBe('default');
    expect(frozenResumePolicy(loaded, 'a', { client: 'fake', model: 'm' })?.name).toBe('fake');
  });

  test('a config edit after creation has no effect', () => {
    const { workspace, session } = freeze(CONFIG(POLICIES));
    writeFileSync(path.join(workspace, '.migent/config.yaml'), CONFIG('resume_policies:\n  fake:\n    match: { client: fake }\n    cache_ttl: 1s\n'));
    expect(frozenResumePolicy(readWorkflowFreeze(session)!, 'a')?.cacheTtlSec).toBe(300);
  });

  test('an invalid policy is refused at creation', () => {
    expect(() => freeze(CONFIG('resume_policies:\n  bad:\n    margin: 5s\n'))).toThrow(/cache_ttl is required/);
  });
});
