import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { AgentToolRunner } from '@nodeint/migent-engine';
import { SessionStore } from '@nodeint/migent-session';
import { expect, test } from 'vitest';

import { continueAgent, dispatchAgent } from '../src/commands/agent.ts';
import { executeWorkflow } from '../src/commands/execute.ts';
import { listSessions } from '../src/commands/sessions.ts';
import { followSession } from '../src/commands/watch.ts';
import { capture, registryOf, removeWorkspace, ScriptedClient, writeFakeWorkflowWorkspace } from './support.ts';

const question = 'status: question\n\n' + JSON.stringify({ schema_version: 1, questions: [{
  id: '1', question: 'Include old sessions?', context: 'Migration is required.', selection: 'single',
  options: [{ id: 'A', label: 'New sessions only' }, { id: 'B', label: 'Include old sessions' }],
}] });

test('standalone role questions wait, list and follow with exit 9, then accept a reply', async () => {
  const root = writeFakeWorkflowWorkspace({});
  const provider = new ScriptedClient([
    question,
    'status: complete\n\nUse new sessions only.',
  ]);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  try {
    const first = await capture(() => dispatchAgent(root, { role: 'reviewer', prompt: 'Review scope', runner, asJson: true }));
    expect(first.value).toBe(9);
    const id = readdirSync(path.join(root, '.migent/sessions'))[0]!;
    expect(new SessionStore(root).readSessionStatus(id).status).toBe('question');
    const list = await capture(() => listSessions(root, { status: 'question', asJson: true }));
    expect(list.value).toBe(0);
    expect(JSON.parse(list.stdout)).toHaveLength(1);
    const shown = await capture(() => followSession(root, id, { once: true }));
    expect(shown.value).toBe(0);
    expect(shown.stdout).toContain('Include old sessions?');
    expect(shown.stdout).toContain('A free-text answer is always allowed.');
    const follow = await capture(() => followSession(root, id, { exitWhenDone: true }));
    expect(follow.value).toBe(9);
    const waiting = await capture(() => continueAgent(root, { sessionId: id, reply: null, runner }));
    expect(waiting.value).toBe(9);
    expect(provider.calls).toHaveLength(1);
    const replied = await capture(() => continueAgent(root, { sessionId: id, reply: 'New only', runner }));
    expect(replied.value).toBe(0);
    expect(provider.calls[1]?.agent_id).toBe('native-session-1');
    expect(provider.calls[1]?.prompt).toContain('New only');
  } finally { removeWorkspace(root); }
});

test('workflow run prints the pending question and its response after a newer sibling finishes', async () => {
  const root = writeFakeWorkflowWorkspace({ plan: 'schema_version: 7\nid: plan\nstages:\n  - { id: plan, role: planner, ask: human }\n  - { id: docs, role: planner }\n' });
  const provider = new ScriptedClient([
    question,
    'status: complete\n\nDocs inspected.',
  ]);
  try {
    const result = await capture(() => executeWorkflow(root, {
      action: 'start', workflowId: 'plan', task: 'Plan', runner: new AgentToolRunner(registryOf({ fake: provider }), 10),
    }));
    expect(result.value).toBe(9);
    expect(result.stderr).toContain('1. Include old sessions? (choose one; stage plan)');
    expect(result.stderr).toContain('A. New sessions only');
    expect(result.stderr).toContain('migent session show');
    expect(result.stderr).toContain('--stage plan --reply "<answer>"');
  } finally { removeWorkspace(root); }
});

test('a workflow stage whose question file stays invalid shows the file, the problem and the recovery', async () => {
  const root = writeFakeWorkflowWorkspace({ plan: 'schema_version: 7\nid: plan\nstages:\n  - { id: plan, role: planner, ask: human }\n' });
  const provider = new ScriptedClient([
    'status: question\n\nNo file.',
    'status: question\n\nStill broken.\n<<FILE>>{"schema_version":1,"questions":[]}',
  ]);
  try {
    const result = await capture(() => executeWorkflow(root, {
      action: 'start', workflowId: 'plan', task: 'Plan', runner: new AgentToolRunner(registryOf({ fake: provider }), 10),
    }));
    expect(result.value).not.toBe(9);
    expect(provider.calls).toHaveLength(2);
    expect(result.stderr).toContain('handoff.json');
    expect(result.stderr).toContain('invalid_schema');
    expect(result.stderr).toContain('session continue');
  } finally { removeWorkspace(root); }
});

test('a role session whose question file stays invalid prints the diagnostic', async () => {
  const root = writeFakeWorkflowWorkspace({});
  const provider = new ScriptedClient(['status: question\n\nNo file.', 'status: question\n\nStill none.']);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  try {
    const result = await capture(() => dispatchAgent(root, { role: 'reviewer', prompt: 'Review scope', runner }));
    expect(result.value).toBe(1);
    expect(result.stdout).toContain('handoff.json');
    expect(result.stdout).toContain('missing');
  } finally { removeWorkspace(root); }
});

test('a question-file failure is shown with its stage even when a newer sibling stage succeeds', async () => {
  const root = writeFakeWorkflowWorkspace({ plan: 'schema_version: 7\nid: plan\nstages:\n  - { id: plan, role: planner, ask: human }\n  - { id: docs, role: planner }\n' });
  const provider = new ScriptedClient([
    'status: question\n\nNo file.',
    'status: question\n\nStill no file.',
    'status: complete\n\nDocs inspected.',
  ]);
  try {
    const result = await capture(() => executeWorkflow(root, {
      action: 'start', workflowId: 'plan', task: 'Plan', runner: new AgentToolRunner(registryOf({ fake: provider }), 10),
    }));
    expect(result.value).not.toBe(0);
    expect(result.stderr).toContain('stage plan:');
    expect(result.stderr).toContain('handoff.json');
    expect(result.stderr).toContain('(missing)');
  } finally { removeWorkspace(root); }
});

test('continue with a reply for a named stage keeps running the workflow after that stage', async () => {
  const root = writeFakeWorkflowWorkspace({ plan: 'schema_version: 7\nid: plan\nstages:\n  - { id: plan, role: planner, ask: human }\n  - { id: review_plan, role: planner, depends_on: [plan] }\n' });
  const provider = new ScriptedClient([
    question,
    'status: complete\n\nPlan written.',
    'status: complete\n\nPlan reviewed.',
  ]);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  try {
    const first = await capture(() => executeWorkflow(root, { action: 'start', workflowId: 'plan', task: 'Plan', runner }));
    expect(first.value).toBe(9);
    const id = readdirSync(path.join(root, '.migent/sessions'))[0]!;
    const replied = await capture(() => executeWorkflow(root, {
      action: 'continue', sessionId: id, replyStageId: 'plan', reply: '1A', continueFailed: true, runner,
    }));
    expect(replied.value).toBe(0);
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[1]?.prompt).toContain('New sessions only');
    expect(new SessionStore(root).readSessionStatus(id).status).toBe('completed');
  } finally { removeWorkspace(root); }
});

function inputsOf(root: string, id: string): Record<string, Record<string, unknown>> {
  const directory = path.join(root, '.migent/sessions', id, 'executions');
  const found: Record<string, Record<string, unknown>> = {};
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name, 'input.json');
    if (existsSync(file)) found[name] = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  }
  return found;
}

test('role continue --reply to a question records answers in the new attempt input.json only', async () => {
  const root = writeFakeWorkflowWorkspace({});
  const provider = new ScriptedClient([question, 'status: complete\n\nDone']);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  try {
    await capture(() => dispatchAgent(root, { role: 'reviewer', prompt: 'Review scope', runner, asJson: true }));
    const id = readdirSync(path.join(root, '.migent/sessions'))[0]!;
    expect(inputsOf(root, id)).toEqual({});
    await capture(() => continueAgent(root, { sessionId: id, reply: 'New only', runner }));
    const inputs = inputsOf(root, id);
    expect(Object.keys(inputs)).toHaveLength(1);
    const [[executionId, input]] = Object.entries(inputs) as [string, Record<string, unknown>][];
    expect(executionId).not.toBe(readdirSync(path.join(root, '.migent/sessions', id, 'executions'))[0]);
    expect(input).toMatchObject({ kind: 'answers', input: 'New only', stage_id: 'reviewer' });
    expect(String(input.sent)).toContain('New only');
    expect(input.answers).toHaveLength(1);
    expect(input.responds_to_execution_id).toBe(readdirSync(path.join(root, '.migent/sessions', id, 'executions'))[0]);
    expect(existsSync(path.join(root, '.migent/sessions', id, 'questions.json'))).toBe(false);
  } finally { removeWorkspace(root); }
});

test('role dispatch that answers a pending question records answers in input.json', async () => {
  const root = writeFakeWorkflowWorkspace({});
  const provider = new ScriptedClient([question, 'status: complete\n\nDone']);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  try {
    await capture(() => dispatchAgent(root, { role: 'reviewer', prompt: 'Review scope', runner, asJson: true }));
    const id = readdirSync(path.join(root, '.migent/sessions'))[0]!;
    await capture(() => dispatchAgent(root, { role: 'reviewer', sessionId: id, prompt: 'New only', runner }));
    const inputs = Object.values(inputsOf(root, id));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ kind: 'answers', input: 'New only' });
  } finally { removeWorkspace(root); }
});

test('role: a plain continue and a plain dispatch write no input.json; continue --reply records a reply', async () => {
  const root = writeFakeWorkflowWorkspace({});
  const provider = new ScriptedClient(['status: blocked\nblocker: need a call\n\nstuck', 'status: complete\n\nDone', 'status: complete\n\nAgain', 'status: complete\n\nLast']);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  try {
    await capture(() => dispatchAgent(root, { role: 'reviewer', prompt: 'Review scope', runner, asJson: true }));
    const id = readdirSync(path.join(root, '.migent/sessions'))[0]!;
    expect((await capture(() => continueAgent(root, { sessionId: id, reply: null, runner }))).value).toBe(0);
    expect((await capture(() => dispatchAgent(root, { role: 'reviewer', sessionId: id, prompt: 'One more thing', runner }))).value).toBe(0);
    expect(inputsOf(root, id)).toEqual({});

    expect((await capture(() => continueAgent(root, { sessionId: id, reply: 'Also check docs', runner }))).value).toBe(0);
    const inputs = Object.values(inputsOf(root, id));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ kind: 'reply', input: 'Also check docs', stage_id: 'reviewer' });
  } finally { removeWorkspace(root); }
});

test('role continue --reply to a blocked turn delivers the reply and records it against the blocked execution', async () => {
  const root = writeFakeWorkflowWorkspace({});
  const provider = new ScriptedClient(['status: blocked\nblocker: need a call\n\nstuck', 'status: complete\n\nDone']);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  try {
    await capture(() => dispatchAgent(root, { role: 'reviewer', prompt: 'Review scope', runner, asJson: true }));
    const id = readdirSync(path.join(root, '.migent/sessions'))[0]!;
    expect(new SessionStore(root).readSessionStatus(id).status).toBe('blocked');
    const blockedExecution = readdirSync(path.join(root, '.migent/sessions', id, 'executions'))[0]!;
    expect(inputsOf(root, id)).toEqual({});

    const replied = await capture(() => continueAgent(root, { sessionId: id, reply: 'Use option two', runner }));
    expect(replied.value).toBe(0);
    expect(provider.calls[1]?.prompt).toContain('Use option two');
    const inputs = Object.entries(inputsOf(root, id));
    expect(inputs).toHaveLength(1);
    const [[executionId, input]] = inputs as [string, Record<string, unknown>][];
    expect(executionId).not.toBe(blockedExecution);
    expect(input).toMatchObject({
      kind: 'reply', input: 'Use option two', stage_id: 'reviewer', responds_to_execution_id: blockedExecution,
    });
  } finally { removeWorkspace(root); }
});
