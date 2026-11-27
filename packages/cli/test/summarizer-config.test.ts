import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { runDoctor } from '../src/commands/doctor.ts';
import { cliHooks } from '../src/hooks.ts';
import { main } from '../src/index.ts';
import { capture } from './support.ts';

const roots: string[] = [];
afterEach(() => {
  cliHooks.which = null;
  cliHooks.runCommand = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const which = (command: string): string => `/fake/${command}`;
const catalog = (): string => 'Available models:\n  - grok-4.7\n';

function workspaceWith(entry: string): string {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-summarizer-config-'));
  roots.push(workspace);
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), `schema_version: 8
agents:
  dev:
    client: { type: grok }
    model: grok-4.7
roles:
  developer:
    agent: dev
plugins:
  summarizer:
${entry}`);
  writeFileSync(
    path.join(workspace, '.migent', 'workflows', 'flow.yaml'),
    'schema_version: 8\nid: flow\nstages:\n  - id: work\n    role: developer\n',
  );
  return workspace;
}

const FAULTS: [string, string, string][] = [
  ['a missing agent', '    enabled: true\n', 'plugins.summarizer.agent'],
  ['an unknown trigger', '    enabled: true\n    agent: dev\n    triggers: [weekly]\n', 'plugins.summarizer.triggers[0]'],
  [
    'a duplicate trigger',
    '    enabled: true\n    agent: dev\n    triggers: [completed, completed]\n',
    'plugins.summarizer.triggers[1]',
  ],
];
const RUN = ['session', 'run', '--workflow', 'flow', '--task', 'task', '--once'];

async function doctorOf(workspace: string): Promise<{ code: number; problems: string[] }> {
  const result = await capture(() => runDoctor(workspace, {
    asJson: true, which, runCommand: catalog, home: workspace,
  }));
  const report = JSON.parse(result.stdout) as { checks: { problems: string[] }[] };
  return { code: result.value, problems: report.checks.flatMap((check) => check.problems) };
}

test('a valid enabled entry passes doctor', async () => {
  const report = await doctorOf(workspaceWith('    enabled: true\n    agent: dev\n'));
  expect(report).toEqual({ code: 0, problems: [] });
});

test.each(FAULTS)('doctor fails and names the field for %s', async (_name, entry, field) => {
  const { code, problems } = await doctorOf(workspaceWith(entry));
  // `migent doctor` documents exit 1 for a failed check; exit 2 is reserved for a bad session id or old schema.
  expect(code).toBe(1);
  expect(problems.some((problem) => problem.includes(field))).toBe(true);
});

test.each(FAULTS)('session run exits 2 and names the field for %s', async (_name, entry, field) => {
  const workspace = workspaceWith(entry);
  cliHooks.which = which;
  cliHooks.runCommand = catalog;
  const result = await capture(() => main(RUN, workspace));
  expect(result.value).toBe(2);
  expect(result.stderr).toContain(field);
});

test.each(FAULTS)('session run exits 2 and names the field for %s even with preflight skipped', async (_name, entry, field) => {
  const workspace = workspaceWith(entry);
  cliHooks.which = which;
  cliHooks.runCommand = catalog;
  const result = await capture(() => main([...RUN, '--skip-preflight'], workspace));
  expect(result.value).toBe(2);
  expect(result.stderr).toContain(field);
});
