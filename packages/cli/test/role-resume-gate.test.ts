import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { AgentToolRunner } from '@nodeint/migent-engine';
import { type BuildCommandInput, raiseCancellation, resetCancellation } from '@nodeint/migent-kernel';
import { SessionLock, SessionStore } from '@nodeint/migent-session';
import { expect, test } from 'vitest';

import { continueAgent, dispatchAgent } from '../src/commands/agent.ts';
import { cliHooks } from '../src/hooks.ts';
import { main } from '../src/index.ts';
import { capture, registryOf, removeWorkspace, ScriptedClient, writeFakeWorkflowWorkspace } from './support.ts';

const question = 'status: question\n\n' + JSON.stringify({ schema_version: 1, questions: [{
  id: '1', question: 'Include old sessions?', context: 'Migration is required.', selection: 'single',
  options: [{ id: 'A', label: 'New sessions only' }, { id: 'B', label: 'Include old sessions' }],
}] });

const policy = (onExpired: string) => `resume_policies:\n  fake:\n    match: { client: fake }\n    cache_ttl: 1s\n    on_expired: ${onExpired}\n`;

/** A role session stopped on a question, with its source execution aged past the TTL. */
async function asked(onExpired: string | null, responses: string[]) {
  const root = writeFakeWorkflowWorkspace({});
  if (onExpired !== null) appendFileSync(path.join(root, '.migent/config.yaml'), `\n${policy(onExpired)}`);
  const provider = new ScriptedClient([question, ...responses]);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  const first = await capture(() => dispatchAgent(root, { role: 'reviewer', prompt: 'Review scope', runner, asJson: true }));
  expect(first.value).toBe(9);
  const id = readdirSync(path.join(root, '.migent/sessions'))[0]!;
  const file = path.join(root, '.migent/sessions', id, 'executions', readdirSync(path.join(root, '.migent/sessions', id, 'executions'))[0]!, 'execution.json');
  const metadata = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...metadata, completed_at: '2026-01-01T00:00:00.000+00:00' }));
  return { root, provider, runner, id };
}

test('no policy: a role continue resumes the conversation as before', async () => {
  const run = await asked(null, ['status: complete\n\nDone']);
  try {
    const replied = await capture(() => continueAgent(run.root, { sessionId: run.id, reply: 'New only', runner: run.runner }));
    expect(replied.value).toBe(0);
    expect(run.provider.calls[1]?.agent_id).toBe('native-session-1');
  } finally { removeWorkspace(run.root); }
}, 30_000);

test('ask: a role continue stops with exit 10, runs nothing, and keeps the reply for after the decision', async () => {
  const run = await asked('ask', ['status: complete\n\nDone']);
  try {
    const stopped = await capture(() => continueAgent(run.root, { sessionId: run.id, reply: 'New only', runner: run.runner }));
    expect(stopped.value).toBe(10);
    expect(run.provider.calls).toHaveLength(1);
    expect(readdirSync(path.join(run.root, '.migent/sessions', run.id, 'executions'))).toHaveLength(1);
    expect(new SessionStore(run.root).readSessionStatus(run.id).status).toBe('expired');
    expect(new SessionStore(run.root).pendingResumes(run.id)).toMatchObject([{ stageId: 'reviewer' }]);
  } finally { removeWorkspace(run.root); }
}, 30_000);

test('fresh: a role continue starts a new conversation and carries the reply', async () => {
  const run = await asked('fresh', ['status: complete\n\nDone']);
  try {
    const replied = await capture(() => continueAgent(run.root, { sessionId: run.id, reply: 'New only', runner: run.runner }));
    expect(replied.value).toBe(0);
    expect(run.provider.calls[1]?.agent_id).toBeNull();
    expect(run.provider.calls[1]?.prompt).toContain('New only');
    // The new conversation knows nothing of the old one, so it gets the original task as well (AC5).
    expect(run.provider.calls[1]?.prompt).toContain('Review scope');
  } finally { removeWorkspace(run.root); }
}, 30_000);

test('resume: a role continue behaves as without a policy', async () => {
  const run = await asked('resume', ['status: complete\n\nDone']);
  try {
    const replied = await capture(() => continueAgent(run.root, { sessionId: run.id, reply: 'New only', runner: run.runner }));
    expect(replied.value).toBe(0);
    expect(run.provider.calls[1]?.agent_id).toBe('native-session-1');
  } finally { removeWorkspace(run.root); }
}, 30_000);

class HangFirst extends ScriptedClient {
  private hung = false;

  override buildCommand(input: BuildCommandInput) {
    if (this.hung) return super.buildCommand(input);
    this.hung = true;
    super.buildCommand(input);
    return { argv: [process.execPath, '-e', 'setTimeout(() => {}, 30000)'] };
  }
}

/** A role session cancelled mid-turn, with the cancel time pushed past the TTL. */
async function cancelledRole(onExpired: string, responses: string[]) {
  const root = writeFakeWorkflowWorkspace({});
  appendFileSync(path.join(root, '.migent/config.yaml'), `\n${policy(onExpired)}`);
  const provider = new HangFirst(responses);
  const timer = setTimeout(() => {
    try { raiseCancellation(15); } catch { /* the flag stays set for the command */ }
  }, 300);
  const code = await dispatchAgent(root, {
    role: 'reviewer', prompt: 'Review the saved turn', runner: new AgentToolRunner(registryOf({ fake: provider }), 10),
  });
  clearTimeout(timer);
  resetCancellation();
  expect(code).toBe(130);
  const id = readdirSync(path.join(root, '.migent/sessions'))[0]!;
  const directory = path.join(root, '.migent/sessions', id, 'executions');
  const file = path.join(directory, readdirSync(directory)[0]!, 'execution.json');
  const metadata = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...metadata, completed_at: '2026-01-01T00:00:00.000+00:00' }));
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  return { root, id, provider, runner, file };
}

test('ask: a cancelled role continue leaves the execution cancelled and untouched, with exit 10', async () => {
  const run = await cancelledRole('ask', ['status: complete\n\nDone']);
  try {
    const args = { sessionId: run.id, reply: null, runner: run.runner };
    const stopped = await capture(() => continueAgent(run.root, args));
    expect(stopped.value).toBe(10);
    const metadata = JSON.parse(readFileSync(run.file, 'utf8')) as Record<string, unknown>;
    expect(metadata.status).toBe('cancelled');
    expect(metadata.completed_at).toBe('2026-01-01T00:00:00.000+00:00');
    expect(run.provider.calls).toHaveLength(1);
  } finally { removeWorkspace(run.root); }
}, 30_000);

test('fresh: a cancelled role continue keeps the source cancelled and runs a new conversation', async () => {
  const run = await cancelledRole('fresh', ['status: complete\n\nDone']);
  try {
    const done = await capture(() => continueAgent(run.root, { sessionId: run.id, reply: null, runner: run.runner }));
    expect(done.value).toBe(0);
    const metadata = JSON.parse(readFileSync(run.file, 'utf8')) as Record<string, unknown>;
    expect(metadata.status).toBe('cancelled');
    expect(run.provider.calls[1]?.agent_id).toBeNull();
    // The new conversation carries the original task and the cut-off turn, not a bare instruction.
    expect(run.provider.calls[1]?.prompt).toContain('Review the saved turn');
    expect(readdirSync(path.join(run.root, '.migent/sessions', run.id, 'executions'))).toHaveLength(2);
  } finally { removeWorkspace(run.root); }
}, 30_000);

test('a used human decision does not exempt the same source from a later expiry (R3)', async () => {
  const run = await cancelledRole('ask', [question]);
  try {
    const args = { sessionId: run.id, reply: null, runner: run.runner };
    expect((await capture(() => continueAgent(run.root, args))).value).toBe(10);
    const lock = SessionLock.acquire(path.join(run.root, '.migent/sessions', run.id));
    try {
      const store = new SessionStore(run.root);
      const [stop] = store.pendingResumes(run.id);
      store.recordResumeDecision(run.id, { stageId: stop!.stageId, sourceExecutionId: stop!.sourceExecutionId, choice: 'resume', origin: 'human' });
    } finally { lock.release(); }
    // The decision is applied once: the cancelled turn reopens in place and ends on a question.
    expect((await capture(() => continueAgent(run.root, args))).value).toBe(9);
    const metadata = JSON.parse(readFileSync(run.file, 'utf8')) as Record<string, unknown>;
    writeFileSync(run.file, JSON.stringify({ ...metadata, completed_at: '2026-01-01T00:00:00.000+00:00' }));
    const again = await capture(() => continueAgent(run.root, { sessionId: run.id, reply: 'New only', runner: run.runner }));
    expect(again.value).toBe(10);
    expect(new SessionStore(run.root).pendingResumes(run.id)).toHaveLength(1);
  } finally { removeWorkspace(run.root); }
}, 30_000);

const handoffFiles = (prompt: string | undefined) => [...(prompt ?? '').matchAll(/Handoff file: `([^`]+)`/g)].map((m) => m[1]);

test('fresh via continue: one active handoff file, task and reply carried (R7)', async () => {
  const run = await asked('fresh', ['status: complete\n\nDone']);
  try {
    await capture(() => continueAgent(run.root, { sessionId: run.id, reply: 'New only', runner: run.runner }));
    const prompt = run.provider.calls[1]?.prompt;
    expect(prompt).toContain('Review scope');
    expect(prompt).toContain('New only');
    expect(handoffFiles(prompt)).toHaveLength(1);
    expect(handoffFiles(prompt)[0]).toContain('0002-');
  } finally { removeWorkspace(run.root); }
}, 30_000);

test('fresh after a cancelled turn: one active handoff file even though the carried prompt was rendered (R7)', async () => {
  const run = await cancelledRole('fresh', ['status: complete\n\nDone']);
  try {
    await capture(() => continueAgent(run.root, { sessionId: run.id, reply: null, runner: run.runner }));
    const prompt = run.provider.calls[1]?.prompt;
    expect(prompt).toContain('Review the saved turn');
    expect(handoffFiles(prompt)).toHaveLength(1);
    expect(handoffFiles(prompt)[0]).toContain('0002-');
  } finally { removeWorkspace(run.root); }
}, 30_000);

test('run --session fresh: the new conversation carries the original task and the new input once (R2)', async () => {
  const run = await asked('fresh', ['status: complete\n\nDone']);
  try {
    const done = await capture(() => dispatchAgent(run.root, { role: 'reviewer', sessionId: run.id, prompt: 'New only', runner: run.runner }));
    expect(done.value).toBe(0);
    const prompt = run.provider.calls[1]?.prompt ?? '';
    expect(run.provider.calls[1]?.agent_id).toBeNull();
    expect(prompt).toContain('Review scope');
    expect(prompt.split('New only').length - 1).toBe(1);
    expect(handoffFiles(prompt)).toHaveLength(1);
  } finally { removeWorkspace(run.root); }
}, 30_000);

test('run --session ask: the answer is saved before the stop and printed with the estimate, then carried once after the decision (R2, R5)', async () => {
  const run = await asked('ask', ['status: complete\n\nDone']);
  try {
    const args = { role: 'reviewer', sessionId: run.id, prompt: 'New only', runner: run.runner };
    const stopped = await capture(() => dispatchAgent(run.root, args));
    expect(stopped.value).toBe(10);
    expect(run.provider.calls).toHaveLength(1);
    expect(new SessionStore(run.root).questionAnswer(run.id, 'reviewer')).toBeDefined();
    expect(stopped.stderr + stopped.stdout).toMatch(/idle \d+s of \d+s allowed/);
    expect(stopped.stderr + stopped.stdout).toContain('context unknown (no usage reported)');
    const lock = SessionLock.acquire(path.join(run.root, '.migent/sessions', run.id));
    try {
      const store = new SessionStore(run.root);
      const [stop] = store.pendingResumes(run.id);
      store.recordResumeDecision(run.id, { stageId: stop!.stageId, sourceExecutionId: stop!.sourceExecutionId, choice: 'fresh', origin: 'human' });
    } finally { lock.release(); }
    const done = await capture(() => continueAgent(run.root, { sessionId: run.id, reply: null, runner: run.runner }));
    expect(done.value).toBe(0);
    const prompt = run.provider.calls[1]?.prompt ?? '';
    expect(prompt).toContain('Review scope');
    expect(prompt).toContain('Include old sessions');
    // The answer saved before the stop is still the human's input once the decision lets it through.
    const files = inputFiles(run.root, run.id);
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(run.root, '.migent/sessions', run.id, 'executions', files[0]!, 'input.json'), 'utf8'))).toMatchObject({ kind: 'answers', input: 'New only' });
  } finally { removeWorkspace(run.root); }
}, 30_000);

test('session resume --json on a role session reports the continued run and its exit code', async () => {
  const run = await asked('ask', ['status: complete\n\nDone']);
  try {
    const stopped = await capture(() => continueAgent(run.root, { sessionId: run.id, reply: 'New only', runner: run.runner }));
    expect(stopped.value).toBe(10);
    cliHooks.runner = run.runner;
    const result = await capture(() => main(['session', 'resume', run.id, 'fresh', '--json'], run.root));
    expect(result.value).toBe(0);
    const body = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({ choice: 'fresh', continued: true, exit_code: 0 });
    expect(run.provider.calls[1]?.agent_id).toBeNull();
    expect(run.provider.calls[1]?.prompt).toContain('Review scope');
  } finally { cliHooks.runner = null; removeWorkspace(run.root); }
}, 30_000);

/** Hangs on its second command, so the turn that carries a reply is the one that gets cancelled. */
class HangSecond extends ScriptedClient {
  private built = 0;

  override buildCommand(input: BuildCommandInput) {
    this.built += 1;
    const spec = super.buildCommand(input);
    return this.built === 2 ? { argv: [process.execPath, '-e', 'setTimeout(() => {}, 30000)'] } : spec;
  }
}

/** task -> question -> reply (cancelled mid-turn) with the cancelled execution aged past the TTL. */
async function cancelledLaterTurn(onExpired: string, responses: string[]) {
  const root = writeFakeWorkflowWorkspace({});
  appendFileSync(path.join(root, '.migent/config.yaml'), `\n${policy(onExpired)}`);
  const provider = new HangSecond([question, 'status: complete\n\nLost', ...responses]);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  const first = await capture(() => dispatchAgent(root, { role: 'reviewer', prompt: 'ORIGINAL_TASK', runner }));
  expect(first.value).toBe(9);
  const id = readdirSync(path.join(root, '.migent/sessions'))[0]!;
  const timer = setTimeout(() => {
    try { raiseCancellation(15); } catch { /* the flag stays set for the command */ }
  }, 300);
  const cancelled = await capture(() => continueAgent(root, { sessionId: id, reply: 'NEW_SCOPE_TOKEN', runner }));
  clearTimeout(timer);
  resetCancellation();
  expect(cancelled.value).toBe(130);
  const directory = path.join(root, '.migent/sessions', id, 'executions');
  const name = readdirSync(directory).sort().at(-1)!;
  const file = path.join(directory, name, 'execution.json');
  const metadata = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  expect(metadata.status).toBe('cancelled');
  writeFileSync(file, JSON.stringify({ ...metadata, completed_at: '2026-01-01T00:00:00.000+00:00' }));
  return { root, id, provider, runner, file };
}

const sourceStillCancelled = (file: string) =>
  (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>).status === 'cancelled';

test('fresh policy after a later cancelled turn carries the task and the cancelled turn\'s reply (R9)', async () => {
  const run = await cancelledLaterTurn('fresh', ['status: complete\n\nDone']);
  try {
    const done = await capture(() => continueAgent(run.root, { sessionId: run.id, reply: null, runner: run.runner }));
    expect(done.value).toBe(0);
    const prompt = run.provider.calls.at(-1)?.prompt ?? '';
    expect(run.provider.calls.at(-1)?.agent_id).toBeNull();
    expect(prompt).toContain('ORIGINAL_TASK');
    expect(prompt).toContain('NEW_SCOPE_TOKEN');
    expect(handoffFiles(prompt)).toHaveLength(1);
    expect(handoffFiles(prompt)[0]).toContain('0003-');
    expect(sourceStillCancelled(run.file)).toBe(true);
  } finally { removeWorkspace(run.root); }
}, 30_000);

test('human-selected fresh after a later cancelled turn carries the task and the reply (R9)', async () => {
  const run = await cancelledLaterTurn('ask', ['status: complete\n\nDone']);
  try {
    const args = { sessionId: run.id, reply: null, runner: run.runner };
    expect((await capture(() => continueAgent(run.root, args))).value).toBe(10);
    cliHooks.runner = run.runner;
    const decided = await capture(() => main(['session', 'resume', run.id, 'fresh'], run.root));
    expect(decided.value).toBe(0);
    const prompt = run.provider.calls.at(-1)?.prompt ?? '';
    expect(prompt).toContain('ORIGINAL_TASK');
    expect(prompt).toContain('NEW_SCOPE_TOKEN');
    expect(handoffFiles(prompt)).toHaveLength(1);
    expect(sourceStillCancelled(run.file)).toBe(true);
  } finally { cliHooks.runner = null; removeWorkspace(run.root); }
}, 30_000);

function inputFiles(root: string, id: string): string[] {
  const directory = path.join(root, '.migent/sessions', id, 'executions');
  return readdirSync(directory).filter((name) => existsSync(path.join(directory, name, 'input.json')));
}

test('a reply to a cancelled role turn is recorded in input.json of the new turn', async () => {
  const run = await cancelledRole('resume', ['status: complete\n\nDone']);
  try {
    const done = await capture(() => continueAgent(run.root, { sessionId: run.id, reply: 'Take another approach', runner: run.runner }));
    expect(done.value).toBe(0);
    const files = inputFiles(run.root, run.id);
    expect(files).toHaveLength(1);
    const input = JSON.parse(readFileSync(path.join(run.root, '.migent/sessions', run.id, 'executions', files[0]!, 'input.json'), 'utf8')) as Record<string, unknown>;
    expect(input).toMatchObject({ kind: 'reply', input: 'Take another approach', stage_id: 'reviewer' });
    expect(String(input.sent)).toContain('Take another approach');
  } finally { removeWorkspace(run.root); }
}, 30_000);

test('a cut-off fresh attempt and a plain continue write no input.json', async () => {
  const run = await cancelledRole('fresh', ['status: complete\n\nDone']);
  try {
    const done = await capture(() => continueAgent(run.root, { sessionId: run.id, reply: null, runner: run.runner }));
    expect(done.value).toBe(0);
    expect(inputFiles(run.root, run.id)).toEqual([]);
  } finally { removeWorkspace(run.root); }
}, 30_000);

/** Persist a cancelled-turn reply (the durable origin event), then recover it with a plain continue. */
async function recoverRoleReply(origin: 'human' | 'cut_off' | null) {
  const run = await cancelledRole('resume', ['status: complete\n\nDone']);
  const directory = path.join(run.root, '.migent/sessions', run.id);
  const lock = SessionLock.acquire(directory);
  try {
    new SessionStore(run.root).supersedeCancelled(run.id, 'reviewer', { text: 'saved steer', origin: origin ?? 'human' });
    if (origin === null) {
      const file = path.join(directory, 'events.jsonl');
      writeFileSync(file, readFileSync(file, 'utf8').replace(',"origin":"human"', '').replace('"origin":"human",', ''));
    }
  } finally { lock.release(); }
  expect(inputFiles(run.root, run.id)).toEqual([]);
  const done = await capture(() => continueAgent(run.root, { sessionId: run.id, reply: null, runner: run.runner }));
  expect(done.value).toBe(0);
  expect(run.provider.calls[1]?.prompt).toContain('saved steer');
  return { run, directory };
}

test('role session: a recovered human cancelled reply is delivered and recorded in input.json', async () => {
  const { run, directory } = await recoverRoleReply('human');
  try {
    const files = inputFiles(run.root, run.id);
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(directory, 'executions', files[0]!, 'input.json'), 'utf8'))).toMatchObject({
      kind: 'reply', input: 'saved steer', stage_id: 'reviewer',
    });
  } finally { removeWorkspace(run.root); }
}, 30_000);

test('role session: a recovered cut-off cancelled reply is re-sent without input.json', async () => {
  const { run } = await recoverRoleReply('cut_off');
  try {
    expect(inputFiles(run.root, run.id)).toEqual([]);
  } finally { removeWorkspace(run.root); }
}, 30_000);

test('role session: a legacy cancelled reply without origin is re-sent without input.json', async () => {
  const { run, directory } = await recoverRoleReply(null);
  try {
    expect(readFileSync(path.join(directory, 'events.jsonl'), 'utf8')).not.toContain('"origin":"human"');
    expect(inputFiles(run.root, run.id)).toEqual([]);
  } finally { removeWorkspace(run.root); }
}, 30_000);
