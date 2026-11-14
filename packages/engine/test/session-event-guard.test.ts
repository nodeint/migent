import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ExecutionQuestions, isValid, SessionDiagnostics, SessionExecution, validationIssues } from '@nodeint/migent-contracts';
import { createWorkflowSession } from '@nodeint/migent-session';
import { expect, test } from 'vitest';

import { AgentToolRunner, executeNamedWorkflow } from '../src/index.ts';
import { assertEventsValid } from './event-validation.ts';
import { PLAN_REVIEW_WORKFLOW, registryOf, ScriptedClient, tempDir } from './support.ts';

const CONFIG = ['schema_version: 7', 'roles:', '  dev:', '    agent: { client: { type: fake }, model: fake }', ''].join('\n');
const WORKFLOW = ['schema_version: 3', 'id: wf', 'stages:', '  - { id: one, role: dev }', ''].join('\n');
const DONE = 'status: complete\n\ndone';

/** Event names this guard has seen across every scenario in this file. */
export const seen = new Set<string>();

const filesSeen = new Set<string>();

function guardFiles(sessionDirectory: string): void {
  const executions = path.join(sessionDirectory, 'executions');
  for (const id of existsSync(executions) ? readdirSync(executions) : []) {
    const check = (file: string, schema: Parameters<typeof isValid>[0], key: string) => {
      const filePath = path.join(executions, id, file);
      if (!existsSync(filePath)) return;
      const value = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
      expect(validationIssues(schema, value), `${key} ${id}`).toEqual([]);
      filesSeen.add(key);
    };
    check('execution.json', SessionExecution, 'execution');
    check('questions.json', ExecutionQuestions, 'execution-questions');
    check('diagnostics.json', SessionDiagnostics, 'diagnostics');
  }
}

interface ScenarioOptions {
  workflow?: string;
  artifacts?: (string | null)[];
  replies?: string[];
  git?: boolean;
}

async function scenario(responses: string[], options: ScenarioOptions = {}): Promise<Record<string, unknown>[]> {
  const workspace = tempDir('migent-event-guard-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), CONFIG);
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), options.workflow ?? WORKFLOW);
  if (options.git === true) {
    writeFileSync(path.join(workspace, '.gitignore'), '.migent/\n');
    writeFileSync(path.join(workspace, 'a.txt'), 'a\n');
    for (const args of [['init', '-b', 'main'], ['add', '-A'], ['commit', '-m', 'initial']]) {
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...args], { cwd: workspace, stdio: 'ignore' });
    }
  }
  const sessionId = createWorkflowSession(workspace, 'wf', { task: 'Do it' });
  const runner = new AgentToolRunner(registryOf({ fake: new ScriptedClient(responses, options.artifacts) }), 10);
  await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner);
  for (const reply of options.replies ?? []) await executeNamedWorkflow(workspace, { sessionId, reply }, runner);
  const sessionDirectory = path.join(workspace, '.migent', 'sessions', sessionId);
  guardFiles(sessionDirectory);
  const text = readFileSync(path.join(sessionDirectory, 'events.jsonl'), 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function guard(events: Record<string, unknown>[]): void {
  for (const name of assertEventsValid(events)) seen.add(name);
}

test('a completed run writes only registered, valid events', async () => {
  const events = await scenario([DONE]);
  guard(events);
  const names = events.map((event) => event.event);
  for (const name of ['session.created', 'session.completed', 'execution.started', 'execution.running', 'execution.completed', 'stage.complete', 'task.frozen', 'provider.stage_started', 'provider.turn_completed']) {
    expect(names, name).toContain(name);
  }
});

test('a blocked run writes only registered, valid events', async () => {
  const events = await scenario(['status: blocked\nblocker: stuck\n\nno']);
  guard(events);
  expect(events.map((event) => event.event)).toEqual(expect.arrayContaining(['session.blocked', 'stage.blocked']));
});

test('a correction after a malformed reply writes only registered, valid events', async () => {
  const events = await scenario(['no status header at all', DONE]);
  guard(events);
  expect(events.map((event) => String(event.event)).some((name) => name === 'handoff.file_invalid' || name === 'response.contract_invalid')).toBe(true);
});

test('a failing provider turn writes only registered, valid events', async () => {
  const events = await scenario([]);
  guard(events);
});

test('a question run writes a valid execution questions file', async () => {
  const workspace = tempDir('migent-event-guard-q-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), CONFIG);
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), ['schema_version: 3', 'id: wf', 'stages:', '  - { id: one, role: dev, ask: human }', ''].join('\n'));
  const sessionId = createWorkflowSession(workspace, 'wf', { task: 'Do it' });
  const reply = 'status: question\n\n' + JSON.stringify({ schema_version: 1, questions: [{ question: 'Which?', context: 'c', selection: 'single', options: [{ label: 'a' }, { label: 'b' }] }] });
  const runner = new AgentToolRunner(registryOf({ fake: new ScriptedClient([reply]) }), 10);
  await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner);
  guardFiles(path.join(workspace, '.migent', 'sessions', sessionId));
  expect(filesSeen.has('execution-questions')).toBe(true);
});

test('execution and diagnostics files were validated by the scenarios above', () => {
  expect(filesSeen.has('execution')).toBe(true);
});

const verifyScript = (workspace: string): string => {
  const script = path.join(workspace, 'verify.cjs');
  const counter = path.join(workspace, 'verify.count');
  writeFileSync(script, `const fs=require('fs');const f=${JSON.stringify(counter)};const n=(fs.existsSync(f)?Number(fs.readFileSync(f,'utf8')):0)+1;fs.writeFileSync(f,String(n));process.exit(n===1?1:0);`);
  return `"${process.execPath}" "${script}"`;
};

test('a red then green verify writes only registered, valid events', async () => {
  const scratch = tempDir('migent-event-guard-v-');
  const workflow = ['schema_version: 3', 'id: wf', 'stages:', '  - id: one', '    role: dev', '    verify:', `      - ${JSON.stringify(verifyScript(scratch))}`, ''].join('\n');
  const events = await scenario([DONE, DONE], { workflow });
  guard(events);
  const names = events.map((event) => String(event.event));
  for (const name of ['verify.started', 'verify.failed', 'verify.passed']) expect(names, name).toContain(name);
  expect(names).toContain('verify.passed');
});

test('a skipped stage writes only registered, valid events', async () => {
  const workflow = ['schema_version: 3', 'id: wf', 'stages:', '  - { id: one, role: dev }', '  - id: two', '    role: dev', '    depends_on: [one]', '    run_when: { changed_paths: ["never/**"] }', ''].join('\n');
  const events = await scenario([DONE], { workflow, git: true });
  guard(events);
  expect(events.map((event) => String(event.event))).toEqual(expect.arrayContaining(['execution.skipped', 'baseline.captured']));
});

test('a question answered by a reply writes only registered, valid events', async () => {
  const ask = ['schema_version: 3', 'id: wf', 'stages:', '  - { id: one, role: dev, ask: human }', ''].join('\n');
  const question = 'status: question\n\n' + JSON.stringify({ schema_version: 1, questions: [{ question: 'Which?', context: 'c', selection: 'single', options: [{ label: 'a' }, { label: 'b' }] }] });
  const events = await scenario([question, DONE], { workflow: ask, replies: ['a'] });
  guard(events);
  expect(events.map((event) => String(event.event))).toEqual(expect.arrayContaining(['session.question', 'stage.question', 'session.active']));
});


test('a completed workflow with published outputs writes a valid outputs.published event', async () => {
  const workflow = PLAN_REVIEW_WORKFLOW.replace('id: plan', 'id: wf').replace(/role: (planner|reviewer)/g, 'role: dev');
  const events = await scenario([DONE, 'status: complete\ndecision: approved\n\nok'], { workflow, artifacts: ['# plan\n', null] });
  guard(events);
  expect(events.map((event) => String(event.event))).toContain('outputs.published');
});
