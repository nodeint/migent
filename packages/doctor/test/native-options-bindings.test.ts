import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createWorkflowSession, selectSessionWorkflow, WORKFLOW_FREEZE_FILE } from '@nodeint/migent-session';
import { expect, test } from 'vitest';
import { parse, stringify } from 'yaml';

import { diagnoseSelection, diagnoseWorkspace } from '../src/index.ts';
import { adaptersClients, tempDir, whichFound, writeStageWorkspace } from './support.ts';

const grokHelp = readFileSync(new URL('../../adapters/src/options/grok.txt', import.meta.url), 'utf8');
const claudeHelp = readFileSync(new URL('../../adapters/src/options/claude-code.txt', import.meta.url), 'utf8');
const which = whichFound(new Set(['grok', 'codex', 'claude']));

const sessionDirectory = (workspace: string, sessionId: string): string =>
  path.join(workspace, '.migent', 'sessions', sessionId);

/** A frozen session whose grok target carries `options`, with the live config removed. */
function frozenWithOptions(options: Record<string, string>): { workspace: string; sessionId: string } {
  const workspace = writeStageWorkspace();
  const sessionId = createWorkflowSession(workspace, 'plan-implement', { task: 'do it' });
  const file = path.join(sessionDirectory(workspace, sessionId), WORKFLOW_FREEZE_FILE);
  const frozen = parse(readFileSync(file, 'utf8')) as { targets: Record<string, { options?: Record<string, string> }> };
  frozen.targets.implement!.options = { ...frozen.targets.implement!.options, ...options };
  writeFileSync(file, stringify(frozen), 'utf8');
  rmSync(path.join(workspace, '.migent', 'config.yaml'));
  return { workspace, sessionId };
}

test('a frozen target is validated against its client help even when live config no longer names the client', async () => {
  const { workspace, sessionId } = frozenWithOptions({ nonexistent_thing: '1' });
  const calls: string[][] = [];
  const diagnosis = await diagnoseSelection(workspace, selectSessionWorkflow(workspace, sessionId), {
    clients: adaptersClients(),
    which,
    runCommand: () => '',
    helpCommand: (argv) => { calls.push(argv); return grokHelp; },
  });
  expect(calls.some((argv) => argv[0] === 'grok')).toBe(true);
  const bindings = diagnosis.checks.find((item) => item.name === 'bindings')!;
  expect(bindings.problems.join('\n')).toMatch(/implement: nonexistent_thing is not an option of grok/);
});

test('a frozen target with unreadable help warns instead of passing silently', async () => {
  const { workspace, sessionId } = frozenWithOptions({ nonexistent_thing: '1' });
  const diagnosis = await diagnoseSelection(workspace, selectSessionWorkflow(workspace, sessionId), {
    clients: adaptersClients(),
    which,
    runCommand: () => '',
    helpCommand: () => { throw new Error('help exploded'); },
  });
  const bindings = diagnosis.checks.find((item) => item.name === 'bindings')!;
  expect(bindings.ok).toBe(true);
  expect(bindings.warnings.join('\n')).toMatch(/Could not verify grok options.*help exploded/);
});

const INLINE = {
  config: `schema_version: 7
agents:
  grok:
    client:
      type: grok
    model: grok-4.6
roles:
  dev:
    agent: grok
`,
  workflow: `schema_version: 7
id: w
stages:
  - id: build
    role: dev
    depends_on: []
    agent:
      client:
        type: claude-code
        options:
          autocompact: 200000
      model: opus
`,
};

function inlineWorkspace(): string {
  const workspace = tempDir('migent-inline-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), INLINE.config, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'w.yaml'), INLINE.workflow, 'utf8');
  return workspace;
}

test('options that belong only to an inline stage agent keep their option-unverified warning', async () => {
  const workspace = inlineWorkspace();
  const checks = await diagnoseWorkspace(workspace, {
    clients: adaptersClients(),
    which,
    runCommand: () => { throw new Error('catalog unavailable'); },
    helpCommand: (argv) => {
      if (argv[0] === 'claude') throw new Error('claude help unavailable');
      return grokHelp;
    },
  });
  const workflows = checks.find((item) => item.name === 'workflows')!;
  expect(workflows.warnings.filter((item) => item.includes('Could not verify claude-code options'))).toHaveLength(1);
});

test('inline stage options are checked against help when it is readable', async () => {
  const workspace = inlineWorkspace();
  const checks = await diagnoseWorkspace(workspace, {
    clients: adaptersClients(),
    which,
    runCommand: () => { throw new Error('catalog unavailable'); },
    helpCommand: (argv) => (argv[0] === 'claude' ? claudeHelp : grokHelp),
  });
  const workflows = checks.find((item) => item.name === 'workflows')!;
  expect(workflows.problems.join('\n')).not.toContain('autocompact');
});
