import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createWorkflowSession } from '@nodeint/migent-session';
import { expect, test } from 'vitest';

import { AgentToolRunner, executeNamedWorkflow } from '../src/index.ts';
import { registryOf, ScriptedClient, tempDir } from './support.ts';

const CONFIG = 'schema_version: 7\nagents:\n  fake: { client: { type: fake }, model: m1 }\nroles:\n  worker: { agent: fake }\n  checker: { agent: fake }\n';
const OK = 'status: complete\n\ndone';
const QUESTION = 'status: question\n\n' + JSON.stringify({
  schema_version: 1,
  questions: [{ question: 'Which?', context: 'Pick one.', selection: 'single', options: [{ label: 'A one' }, { label: 'B two' }] }],
});

function setup(workflow: string): { workspace: string; sessionId: string } {
  const workspace = tempDir('migent-protocol-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), CONFIG);
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), workflow);
  return { workspace, sessionId: createWorkflowSession(workspace, 'wf', { task: 'task' }) };
}

function records(workspace: string, sessionId: string): Record<string, any>[] {
  const directory = path.join(workspace, '.migent', 'sessions', sessionId, 'executions');
  return readdirSync(directory).sort().map((name) => JSON.parse(readFileSync(path.join(directory, name, 'execution.json'), 'utf8')));
}

function protocols(workspace: string, sessionId: string): [string, number][] {
  return records(workspace, sessionId).map((record) => [record.stage_id, record.response_protocol]);
}

/** Prompts of a legacy conversation never mention the handoff file or the protocol 3 contract. */
function noProtocol3(prompt: string | undefined): void {
  expect(prompt).not.toContain('Handoff file');
  expect(prompt).not.toContain('Write one JSON document');
}

test('a question answer, a failure retry and a pending correction stay on protocol 2', async () => {
  const { workspace, sessionId } = setup('id: wf\nstages:\n  - { id: plan, role: worker, ask: human }\ncompletion:\n  stage: plan\n');
  const provider = new ScriptedClient([QUESTION, 'no header', 'still no header', OK]);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  runner.newConversationProtocol = 2;
  const first = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner);
  expect(first.code).toBe(9);
  // The answer continues the protocol 2 conversation; the new reply violates the contract, is
  // corrected once with the protocol 2 correction, and fails after that.
  runner.newConversationProtocol = 3;
  const answered = await executeNamedWorkflow(workspace, { sessionId, reply: '1A' }, runner);
  expect(answered.code).not.toBe(0);
  expect(provider.calls).toHaveLength(3);
  expect(provider.calls[2]?.prompt).toContain('## Invalid response');
  for (const call of provider.calls) noProtocol3(call.prompt);
  expect(records(workspace, sessionId)[1]!.corrections.response_contract).toBeDefined();
  // A retry of the failed execution continues the same conversation.
  const retried = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId, continueFailed: true }, runner);
  expect(
    retried.code,
    JSON.stringify({ stop: retried.stopReason, stages: retried.stages, calls: provider.calls.length }),
  ).toBe(0);
  noProtocol3(provider.calls[3]?.prompt);
  expect(protocols(workspace, sessionId).every(([, protocol]) => protocol === 2)).toBe(true);
}, 60_000);

test("a revision route-back keeps the conversation's protocol after the default moved to 3", async () => {
  const workflow = `\
id: wf
stages:
  - id: make
    role: worker
    max_revisions: 2
  - id: check
    role: checker
    depends_on: [make]
    decision:
      values: [approved, revise]
      routes: { approved: complete, revise: make }
completion:
  stage: check
  decision: approved
`;
  const { workspace, sessionId } = setup(workflow);
  const provider = new ScriptedClient([OK, 'status: complete\ndecision: revise\n\nagain', OK, 'status: complete\ndecision: approved\n\nok']);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  runner.newConversationProtocol = 2;
  const request = { workflowId: 'wf', sessionId, once: true };
  await executeNamedWorkflow(workspace, request, runner); // make
  await executeNamedWorkflow(workspace, request, runner); // check: revise
  // The default moves on before the route-back returns to the existing conversation.
  runner.newConversationProtocol = 3;
  await executeNamedWorkflow(workspace, request, runner); // make again, routed back
  const result = await executeNamedWorkflow(workspace, request, runner); // check: approved
  expect(result.code).toBe(0);
  const byStage = protocols(workspace, sessionId);
  // The route-back continues `make`'s conversation and must not follow the new default.
  expect(byStage.filter(([stage]) => stage === 'make')).toEqual([['make', 2], ['make', 2]]);
  expect(provider.calls[2]?.prompt).not.toContain('Handoff file');
  expect(provider.calls[2]?.prompt).not.toContain('Write one JSON document');
  // `check` started its conversation before the switch, so it keeps protocol 2 on its second visit too.
  expect(byStage.filter(([stage]) => stage === 'check')).toEqual([['check', 2], ['check', 2]]);
}, 60_000);

test('a verify repair in a protocol 2 conversation repairs under protocol 2', async () => {
  const workflow = `\
id: wf
stages:
  - id: make
    role: worker
    verify:
      - ${JSON.stringify(`"${process.execPath}" -e "process.exit(require('fs').existsSync('verified.flag') ? 0 : (require('fs').writeFileSync('verified.flag', '1'), 1))"`)}
completion:
  stage: make
`;
  const { workspace, sessionId } = setup(workflow);
  const provider = new ScriptedClient([OK, OK]);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  runner.newConversationProtocol = 2;
  const result = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner);
  expect(result.code).toBe(0);
  expect(provider.calls).toHaveLength(2);
  const repair = provider.calls[1]?.prompt ?? '';
  expect(repair).toContain('## Verify failed');
  expect(repair).toContain('## Do\n\nFix the verify failure above, then report again.');
  noProtocol3(repair);
  expect(protocols(workspace, sessionId)).toEqual([['make', 2]]);
}, 60_000);

test("a stage that resumes another stage's conversation inherits its protocol, not the current default", async () => {
  const workflow = 'id: wf\nstages:\n  - { id: make, role: worker }\n  - id: again\n    role: worker\n    depends_on: [make]\n    session: { resume_from: make }\ncompletion:\n  stage: again\n';
  const { workspace, sessionId } = setup(workflow);
  const provider = new ScriptedClient([OK, OK]);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  runner.newConversationProtocol = 2;
  await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId, once: true }, runner);
  // The default moves on; `again` continues `make`'s conversation and must not follow it.
  runner.newConversationProtocol = 3;
  const result = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner);
  expect(result.code).toBe(0);
  expect(protocols(workspace, sessionId)).toEqual([['make', 2], ['again', 2]]);
  noProtocol3(provider.calls[1]?.prompt);
}, 60_000);

test('a fresh session runs protocol 3 end to end and a stage that resumes another keeps its protocol', async () => {
  const { workspace, sessionId } = setup('id: wf\nstages:\n  - { id: make, role: worker }\n  - id: again\n    role: worker\n    depends_on: [make]\n    session: { resume_from: make }\ncompletion:\n  stage: again\n');
  const provider = new ScriptedClient([OK, OK]);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  const result = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner);
  expect(result.code).toBe(0);
  expect(protocols(workspace, sessionId)).toEqual([['make', 3], ['again', 3]]);
  expect(provider.calls[0]?.prompt).toContain('Handoff file');
  expect(provider.calls[0]?.prompt).not.toContain('Question file');
}, 60_000);
