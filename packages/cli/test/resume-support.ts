import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { AgentToolRunner } from '@nodeint/migent-engine';
import { expect } from 'vitest';

import { executeWorkflow } from '../src/commands/execute.ts';
import { cliHooks } from '../src/hooks.ts';
import { main } from '../src/index.ts';
import { capture, registryOf, ScriptedClient, writeFakeWorkflowWorkspace } from './support.ts';

export const question = 'status: question\n\n' + JSON.stringify({ schema_version: 1, questions: [{
  id: '1', question: 'Include old sessions?', context: 'Migration is required.', selection: 'single',
  options: [{ id: 'A', label: 'New sessions only' }, { id: 'B', label: 'Include old sessions' }],
}] });

const MAX_PARALLEL = 10;
const EXIT_QUESTION = 9;
const EXIT_EXPIRED = 10;

const POLICY = 'resume_policies:\n  fake:\n    match: { client: fake }\n    cache_ttl: 1s\n    on_expired: ask\n';

/** A workflow session whose asking stage was answered and then held by an expired `ask` resume. */
export async function waiting(
  responses: string[],
  stages = '  - { id: plan, role: planner, ask: human }\n',
): Promise<{ root: string; id: string; provider: ScriptedClient; runner: AgentToolRunner }> {
  const root = writeFakeWorkflowWorkspace({ plan: `schema_version: 7\nid: plan\nstages:\n${stages}` });
  appendFileSync(path.join(root, '.migent/config.yaml'), `\n${POLICY}`);
  const provider = new ScriptedClient([question, ...responses]);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), MAX_PARALLEL);
  cliHooks.runner = runner;
  const first = await capture(() => executeWorkflow(root, {
    action: 'start', workflowId: 'plan', task: 'Plan', runner, stageId: null,
  }));
  expect(first.value).toBe(EXIT_QUESTION);
  const id = readdirSync(path.join(root, '.migent/sessions'))[0] ?? '';
  const directory = path.join(root, '.migent/sessions', id, 'executions');
  const file = path.join(directory, readdirSync(directory)[0] ?? '', 'execution.json');
  const metadata = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...metadata, completed_at: '2026-01-01T00:00:00.000+00:00' }));
  const stopped = await capture(() => { cliHooks.runner = runner; return main(['session', 'continue', id, '--reply', 'New only'], root); });
  expect(stopped.value).toBe(EXIT_EXPIRED);
  return { root, id, provider, runner };
}
