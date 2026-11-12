import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { BuildCommandInput } from '@nodeint/migent-kernel';
import type { CommandSpec } from '@nodeint/migent-kernel';
import { raiseCancellation } from '@nodeint/migent-kernel';
import { createWorkflowSession } from '@nodeint/migent-session';
import { expect, test } from 'vitest';

import { AgentToolRunner, executeNamedWorkflow } from '../src/index.ts';
import { registryOf,ScriptedClient, tempDir } from './support.ts';

const valid = JSON.stringify({ schema_version: 1, questions: [{
  question: 'Include old sessions?', context: 'Migration costs more.', selection: 'single',
  options: [{ label: 'New only' }, { label: 'Include old' }],
}] });

class HangFirstProvider extends ScriptedClient {
  private hung = false;
  constructor(private readonly pidFile: string, responses: string[]) { super(responses); }

  override buildCommand(input: BuildCommandInput): CommandSpec {
    if (this.hung) return super.buildCommand(input);
    this.hung = true;
    this.calls.push({
      model: input.model, workspace: input.workspace, prompt: input.prompt, agentId: input.agentId,
      newAgentId: input.newAgentId, promptFile: input.promptFile, options: { ...input.options },
    });
    const code = `require("fs").writeFileSync(${JSON.stringify(this.pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    return { argv: [process.execPath, '-e', code] };
  }
}

/** Run a stage that asks, cancel its first provider turn, and return the reopened execution. */
async function cancelledAsk(responses: string[]) {
  const root = tempDir('migent-question-resume-');
  const pidFile = path.join(root, 'pid');
  const workspace = tempDir('migent-question-ws-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), [
    'schema_version: 7', 'roles:', '  planner:', '    agent: { client: { type: fake }, model: fake }', '',
  ].join('\n'));
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), [
    'schema_version: 3', 'id: wf', 'stages:', '  - { id: plan, role: planner, ask: human }', '',
  ].join('\n'));
  const sessionId = createWorkflowSession(workspace, 'wf', { task: 'Finish the notes' });
  const provider = new HangFirstProvider(pidFile, responses);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  // An authentic protocol-2 conversation: its first prompt names the question file, not a handoff file.
  runner.newConversationProtocol = 2;
  const timer = setInterval(() => {
    if (!existsSync(pidFile) || readFileSync(pidFile, 'utf8').trim() === '') return;
    clearInterval(timer);
    try { raiseCancellation(15); } catch { /* waiters were woken */ }
  }, 50);
  const first = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner);
  clearInterval(timer);
  expect(first.status).toBe('cancelled');
  const directory = path.join(workspace, '.migent', 'sessions', sessionId, 'executions');
  const executionDirectory = path.join(directory, readdirSync(directory)[0]!);
  const resume = () => executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId, resetRevisions: true }, runner);
  const execution = () => JSON.parse(readFileSync(path.join(executionDirectory, 'execution.json'), 'utf8')) as Record<string, unknown>;
  const patchExecution = (fields: Record<string, unknown>) => writeFileSync(
    path.join(executionDirectory, 'execution.json'), JSON.stringify({ ...execution(), ...fields }),
  );
  /** Pretend the agent answered before the stop: record its response in the history. */
  const saveAssistant = (text: string, requestFile: string | null) => {
    const file = path.join(executionDirectory, 'conversation.json');
    const conversation = JSON.parse(readFileSync(file, 'utf8')) as { history: unknown[] };
    conversation.history.push({ role: 'assistant', content: text });
    writeFileSync(file, JSON.stringify(conversation));
    writeFileSync(path.join(executionDirectory, 'response.md'), text);
    if (requestFile !== null) writeFileSync(path.join(executionDirectory, 'question-request.json'), requestFile);
  };
  return { provider, resume, execution, patchExecution, saveAssistant, executionDirectory };
}

test('a saved question response with a valid file is registered on resume', async () => {
  const run = await cancelledAsk([]);
  run.saveAssistant('status: question\n\nNeed an answer.', valid);
  const result = await run.resume();
  expect(result.code).toBe(9);
  expect(run.provider.calls).toHaveLength(1);
  expect(run.execution().outcome).toMatchObject({ status: 'question', questions: [{ id: '1', question: 'Include old sessions?' }] });
}, 30_000);

test('resuming a saved question response with no file sends the one correction', async () => {
  const run = await cancelledAsk(['status: question\n\nFixed.\n<<FILE>>' + valid]);
  run.saveAssistant('status: question\n\nNeed an answer.', null);
  const result = await run.resume();
  expect(result.code).toBe(9);
  expect(run.provider.calls).toHaveLength(2);
  expect(run.provider.calls[1]?.prompt).toContain('(missing)');
  expect((run.execution().corrections as Record<string, unknown>).question_file).toMatchObject({ turn: 1, error_kind: 'missing' });
}, 30_000);

test('a recorded correction that was never sent is sent on resume without a second budget', async () => {
  const run = await cancelledAsk(['status: question\n\nStill nothing.']);
  run.saveAssistant('status: question\n\nNeed an answer.', null);
  run.patchExecution({ question_correction: { turn: 1, error_kind: 'missing', error_detail: 'the file was not written' } });
  await run.resume();
  expect(run.provider.calls).toHaveLength(2);
  expect(run.provider.calls[1]?.prompt).toContain('question file is not valid');
  expect(run.execution()).toMatchObject({ status: 'failed', failure_reason: 'question_file_invalid' });
}, 30_000);

test('an answer to the correction that is still invalid fails without another correction', async () => {
  const run = await cancelledAsk([]);
  run.saveAssistant('status: question\n\nNeed an answer.', null);
  run.patchExecution({ question_correction: { turn: 1, error_kind: 'missing', error_detail: 'the file was not written' } });
  run.saveAssistant('status: question\n\nAgain.', null);
  await run.resume();
  expect(run.provider.calls).toHaveLength(1);
  expect(run.execution()).toMatchObject({ status: 'failed', failure_reason: 'question_file_invalid' });
}, 30_000);

test('a first prompt saved under an older protocol gets the protocol update on resume', async () => {
  const run = await cancelledAsk([OK_COMPLETE]);
  run.patchExecution({ response_protocol: undefined });
  await run.resume();
  expect(run.provider.calls).toHaveLength(2);
  expect(run.provider.calls[1]?.prompt).toContain('Response protocol update');
  expect(run.provider.calls[1]?.prompt).toContain('- Question file: ');
}, 30_000);

test('a legacy execution resumed in place persists the protocol 2 stamp and the update in its prompt', async () => {
  const run = await cancelledAsk(['status: complete\n\ndone']);
  run.patchExecution({ response_protocol: undefined });
  await run.resume();
  expect(run.execution().response_protocol).toBe(2);
  expect(readFileSync(path.join(run.executionDirectory, 'prompt.md'), 'utf8')).toContain('Response protocol update');
}, 30_000);

const OK_COMPLETE = 'status: complete\n\ndone';
