import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isValid,SessionResumeOutput } from '@nodeint/migent-contracts';
import { AgentToolRunner } from '@nodeint/migent-engine';
import { SessionStore } from '@nodeint/migent-session';
import { expect, test } from 'vitest';

import { executeWorkflow } from '../src/commands/execute.ts';
import { cliHooks } from '../src/hooks.ts';
import { main } from '../src/index.ts';
import { question, waiting } from './resume-support.ts';
import { capture, registryOf, removeWorkspace, ScriptedClient, writeFakeWorkflowWorkspace } from './support.ts';

/** `main` clears the runner hook when it returns, so every command sets it again. */
const resumeCmd = (run: { root: string; id: string; runner: AgentToolRunner }, ...args: string[]) =>
  capture(() => { cliHooks.runner = run.runner; return main(['session', 'resume', run.id, ...args], run.root); });

test('session resume rejects a bad choice, an unknown stage and a session with nothing pending (exit 2)', async () => {
  const run = await waiting(['status: complete\n\nDone']);
  try {
    expect((await resumeCmd(run, 'maybe')).value).toBe(2);
    expect((await resumeCmd(run, 'resume', '--stage', 'nope')).value).toBe(2);
    expect(new SessionStore(run.root).pendingResumes(run.id)).toHaveLength(1);
    expect(run.provider.calls).toHaveLength(1);
  } finally { cliHooks.runner = null; removeWorkspace(run.root); }
}, 30_000);

test('--no-continue records the decision and re-folds; --json describes it', async () => {
  const run = await waiting(['status: complete\n\nDone']);
  try {
    const result = await resumeCmd(run, 'fresh', '--no-continue', '--json');
    expect(result.value).toBe(0);
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(isValid(SessionResumeOutput, body)).toBe(true);
    expect(body).toMatchObject({ stage_id: 'plan', choice: 'fresh', continued: false, remaining: [] });
    expect(new SessionStore(run.root).pendingResumes(run.id)).toEqual([]);
    expect(run.provider.calls).toHaveLength(1);
  } finally { cliHooks.runner = null; removeWorkspace(run.root); }
}, 30_000);

test('resume continues the stage with its saved reply and finishes the session', async () => {
  const run = await waiting(['status: complete\n\nDone']);
  try {
    const result = await resumeCmd(run, 'resume');
    expect(result.value).toBe(0);
    expect(run.provider.calls).toHaveLength(2);
    expect(run.provider.calls[1]?.agent_id).toBe('native-session-1');
    expect(run.provider.calls[1]?.prompt).toContain('New only');
    expect(new SessionStore(run.root).readSessionStatus(run.id).status).toBe('completed');
  } finally { cliHooks.runner = null; removeWorkspace(run.root); }
}, 30_000);

test('fresh continues the stage in a new conversation that still carries the reply', async () => {
  const run = await waiting(['status: complete\n\nDone']);
  try {
    const result = await resumeCmd(run, 'fresh');
    expect(result.value).toBe(0);
    expect(run.provider.calls[1]?.agent_id).toBeNull();
    expect(run.provider.calls[1]?.prompt).toContain('New only');
  } finally { cliHooks.runner = null; removeWorkspace(run.root); }
}, 30_000);

test('a completed session has no resume decision (exit 2)', async () => {
  const run = await waiting(['status: complete\n\nDone']);
  try {
    expect((await resumeCmd(run, 'resume')).value).toBe(0);
    expect((await resumeCmd(run, 'resume')).value).toBe(2);
  } finally { cliHooks.runner = null; removeWorkspace(run.root); }
}, 30_000);

test('help names the exit code and how resume differs from continue', async () => {
  const help = await capture(() => main(['session', 'resume', '--help']));
  expect(help.stdout).toContain('Exit 10');
  expect(help.stdout).toContain('session continue');
});

test('show lists the pending decision with the command; follow and list agree on the status', async () => {
  const run = await waiting(['status: complete\n\nDone']);
  try {
    const shown = await capture(() => main(['session', 'show', run.id], run.root));
    expect(shown.stdout).toContain(`migent session resume ${run.id} <resume|fresh> --stage plan`);
    // The evidence to choose by (R5): idle time against the threshold, TTL, margin, and the context size.
    expect(shown.stdout).toMatch(/idle \d+s of \d+s allowed \(cache_ttl 1s, margin 0s\), context/);
    const json = await capture(() => main(['session', 'show', run.id, '--json'], run.root));
    expect(JSON.parse(json.stdout)).toMatchObject({ status: 'expired', resume_decisions: [{ stage_id: 'plan', policy: 'fake', estimate: { cache_ttl_seconds: 1, margin_seconds: 0, threshold_seconds: 1 } }] });
    const listed = await capture(() => main(['session', 'list', '--status', 'expired'], run.root));
    expect(listed.stdout).toContain(run.id.slice(0, 8));
    const followed = await capture(() => main(['session', 'follow', run.id, '--exit-when-done'], run.root));
    expect(followed.value).toBe(10);
  } finally { cliHooks.runner = null; removeWorkspace(run.root); }
}, 30_000);

test('default --json prints the decision and the continued run result (R4)', async () => {
  const run = await waiting(['status: complete\n\nDone']);
  try {
    const result = await resumeCmd(run, 'resume', '--json');
    expect(result.value).toBe(0);
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(isValid(SessionResumeOutput, body)).toBe(true);
    expect(body).toMatchObject({ stage_id: 'plan', choice: 'resume', continued: true, status: 'completed', exit_code: 0, remaining: [] });
  } finally { cliHooks.runner = null; removeWorkspace(run.root); }
}, 30_000);

test('a live follow replays the expiry with its evidence and the decision command (R5)', async () => {
  const run = await waiting(['status: complete\n\nDone']);
  try {
    const followed = await capture(() => main(['session', 'follow', run.id, '--cursor', '0', '--exit-when-done'], run.root));
    expect(followed.value).toBe(10);
    expect(followed.stdout).toMatch(/resume\.expired · plan waits for a decision /);
    expect(followed.stdout).toMatch(/idle \d+s of \d+s allowed \(cache_ttl 1s, margin 0s\), context/);
    expect(followed.stdout).toContain(`migent session resume ${run.id} <resume|fresh> --stage plan`);
  } finally { cliHooks.runner = null; removeWorkspace(run.root); }
}, 30_000);

test('a sibling question survives an expired stage: the decision runs only the decided stage (T13)', async () => {
  const stages = '  - { id: plan, role: planner, ask: human }\n  - { id: other, role: planner, ask: human }\n';
  const root = writeFakeWorkflowWorkspace({ plan: `schema_version: 7\nid: plan\nstages:\n${stages}` });
  appendFileSync(path.join(root, '.migent/config.yaml'), '\nresume_policies:\n  fake:\n    match: { client: fake }\n    cache_ttl: 1s\n    on_expired: ask\n');
  const provider = new ScriptedClient([question, question, 'status: complete\n\nDone']);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  const run = { root, runner, id: '' };
  try {
    cliHooks.runner = runner;
    const first = await capture(() => executeWorkflow(root, { action: 'start', workflowId: 'plan', task: 'Plan', runner, stageId: null }));
    expect(first.value).toBe(9);
    run.id = readdirSync(path.join(root, '.migent/sessions'))[0] ?? '';
    const dir = path.join(root, '.migent/sessions', run.id, 'executions');
    const planDir = readdirSync(dir).find((name) => name.includes('-plan--')) ?? '';
    const file = path.join(dir, planDir, 'execution.json');
    const metadata = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...metadata, completed_at: '2026-01-01T00:00:00.000+00:00' }));
    const stopped = await capture(() => { cliHooks.runner = runner; return main(['session', 'continue', run.id, '--stage', 'plan', '--reply', 'New only'], root); });
    // A question outranks an expiry in the session status, but the expiry still waits for its decision.
    expect(stopped.value).toBe(9);
    expect(new SessionStore(root).pendingResumes(run.id).map((stop) => stop.stageId)).toEqual(['plan']);
    const calls = provider.calls.length;
    const decided = await resumeCmd(run, 'resume', '--stage', 'plan');
    // The sibling still waits on its own question: exit 9, and only the decided stage ran.
    expect(decided.value).toBe(9);
    expect(provider.calls.length).toBe(calls + 1);
    const store = new SessionStore(root);
    expect(store.questionStages(run.id).map((row) => row.stageId)).toEqual(['other']);
    expect(store.pendingResumes(run.id)).toEqual([]);
  } finally { cliHooks.runner = null; removeWorkspace(root); }
}, 30_000);

test('a sibling blocker survives an expired stage: the decision runs only the decided stage (T13)', async () => {
  const stages = '  - { id: plan, role: planner, ask: human }\n  - { id: other, role: planner }\n';
  const root = writeFakeWorkflowWorkspace({ plan: `schema_version: 7\nid: plan\nstages:\n${stages}` });
  appendFileSync(path.join(root, '.migent/config.yaml'), '\nresume_policies:\n  fake:\n    match: { client: fake }\n    cache_ttl: 1s\n    on_expired: ask\n');
  const blocker = 'status: blocked\nblocker: missing design\n\nnope';
  const provider = new ScriptedClient([question, blocker, 'status: complete\n\nDone']);
  const runner = new AgentToolRunner(registryOf({ fake: provider }), 10);
  const run = { root, runner, id: '' };
  try {
    cliHooks.runner = runner;
    await capture(() => executeWorkflow(root, { action: 'start', workflowId: 'plan', task: 'Plan', runner, stageId: null }));
    run.id = readdirSync(path.join(root, '.migent/sessions'))[0] ?? '';
    const store = new SessionStore(root);
    expect(store.blockedStages(run.id).map((row) => row.stageId)).toEqual(['other']);
    const dir = path.join(root, '.migent/sessions', run.id, 'executions');
    const planDir = readdirSync(dir).find((name) => name.includes('-plan--')) ?? '';
    const file = path.join(dir, planDir, 'execution.json');
    const metadata = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...metadata, completed_at: '2026-01-01T00:00:00.000+00:00' }));
    const blockedBefore = JSON.parse(readFileSync(path.join(dir, readdirSync(dir).find((name) => name.includes('-other--')) ?? '', 'execution.json'), 'utf8')) as Record<string, unknown>;
    await capture(() => { cliHooks.runner = runner; return main(['session', 'continue', run.id, '--stage', 'plan', '--reply', 'New only'], root); });
    expect(new SessionStore(root).pendingResumes(run.id).map((stop) => stop.stageId)).toEqual(['plan']);
    const calls = provider.calls.length;
    const decided = await resumeCmd(run, 'resume', '--stage', 'plan');
    // Only the decided stage ran; the sibling is still blocked by the same execution, unresolved.
    expect(provider.calls.length).toBe(calls + 1);
    expect(decided.value).toBe(1);
    const after = new SessionStore(root);
    expect(after.blockedStages(run.id).map((row) => row.stageId)).toEqual(['other']);
    expect(after.pendingResumes(run.id)).toEqual([]);
    const blockedAfter = JSON.parse(readFileSync(path.join(dir, readdirSync(dir).find((name) => name.includes('-other--')) ?? '', 'execution.json'), 'utf8')) as Record<string, unknown>;
    expect(blockedAfter).toEqual(blockedBefore);
  } finally { cliHooks.runner = null; removeWorkspace(root); }
}, 30_000);
