import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  CancellationRequested, type CorrectionFiles, type FailureClassification, type GateFailure, StageOutcome,
  StreamSummarizer, type VerifyRunResult,
} from '@nodeint/migent-kernel';
import { createWorkflowSession, SessionStore } from '@nodeint/migent-session';
import { expect, test } from 'vitest';

import { ProviderEventReporter } from '../src/provider-events.ts';
import { gate, invoke, queueCorrection, queueRepair, verify } from '../src/turn-flow-steps.ts';
import {
  failStage, finalFields, finishWithoutVerify, persistTurn, resolvePendingVerify,   type VerifyState,
verifyVerdict,
} from '../src/turn-persist-steps.ts';
import type { FreshTurn, Iteration, RunTurnArgs, TurnResult } from '../src/turn-types.ts';
import { FakeClient, holdSessionLock, tempDir } from './support.ts';

const WORKFLOW = ['schema_version: 3', 'id: wf', 'stages:', '  - { id: one, role: developer }', ''].join('\n');
const CONFIG = [
  'schema_version: 7', 'agents:', '  main:', '    client:', '      type: fake', '    model: m1',
  'roles:', '  developer:', '    agent: main', '',
].join('\n');

/** A real session store, execution context, and record in a temporary workspace. */
function execution() {
  const workspace = tempDir('migent-steps-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), CONFIG, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), WORKFLOW, 'utf8');
  const sessionId = createWorkflowSession(workspace, 'wf', { task: 'Do it' });
  holdSessionLock(workspace, sessionId);
  const store = new SessionStore(workspace);
  const [record, , context] = store.loadOrCreate({
    client: 'fake', model: 'm1', options: null, workspace, sessionId, stageId: 'one', stageAttempt: 1,
    executionOrder: 1, prompt: 'go',
  });
  const eventReporter = new ProviderEventReporter({ store, context }, { client: 'fake', model: 'm1' });
  const events = (): string => readFileSync(path.join(workspace, '.migent', 'sessions', sessionId, 'events.jsonl'), 'utf8');
  return { workspace, sessionId, store, record, context, eventReporter, events };
}

const complete = new StageOutcome('complete');
const iteration = (patch: Partial<Iteration> = {}): Iteration => ({
  responseText: 'hi', outcome: complete, invokeError: null, gateFailure: null,
  eligible: true, pendingGate: false, needsVerify: false, ...patch,
});
type Fresh = Pick<FreshTurn, 'source' | 'exitOnly' | 'anomalyReason'>;
const freshOf = (patch: Partial<Fresh> = {}): Fresh => ({
  source: 'model', exitOnly: false, anomalyReason: null, ...patch,
});
const verifyState = (patch: Partial<VerifyState> = {}): VerifyState => ({
  verifyCommands: ['t'], turn: 1, lastResult: null, lastReport: null, verifyRuns: 0, red: 0, maxVerify: 2, ...patch,
});
const FILES: CorrectionFiles = { protocol: 1, questionFile: '/q.json', handoffFile: '/h.json' };
const failureOf = (kind: GateFailure['kind']): GateFailure => ({ kind, errorKind: 'bad', detail: 'broken' });
const quota: FailureClassification = {
  kind: 'quota', origin: 'provider-error', message: 'limit', resetAt: 'tomorrow', window: 'day',
};

test('finalFields adds the final turn', () => {
  expect(finalFields(3, { a: 1 })).toEqual({ a: 1, final_turn: 3 });
  expect(finalFields(2, null)).toEqual({ final_turn: 2 });
});

test('persistTurn records the reply and asks for verify on a complete outcome', () => {
  const { store, record, context } = execution();
  const verdict = persistTurn(
    { record, store, context, verifyCommands: ['t'], classification: null, turn: 1 }, iteration(), freshOf(),
  );
  expect(verdict).toEqual({
    needsVerify: true, modelResponded: true, recordedClassification: null, classification: null,
  });
  expect(record.status).toBe('running');
  expect(record.history).toEqual([{ role: 'assistant', content: 'hi' }]);
  expect(readFileSync(path.join(context.directory, 'response.md'), 'utf8')).toContain('hi');
});

test('persistTurn fails the record on an invoke error and keeps the reply out of history', () => {
  const { store, record, context } = execution();
  const verdict = persistTurn(
    { record, store, context, verifyCommands: [], classification: null, turn: 1 },
    iteration({ invokeError: 'boom' }), freshOf({ source: 'error' }),
  );
  expect(verdict).toMatchObject({ needsVerify: false, modelResponded: false });
  expect(record.status).toBe('failed');
  expect(record.history).toEqual([]);
});

test('persistTurn clears the classification of an accepted exit-only turn but keeps an anomalous one', () => {
  const { store, record, context } = execution();
  const loop = { record, store, context, verifyCommands: [], classification: quota, turn: 1 };
  const accepted = persistTurn(loop, iteration(), freshOf({ exitOnly: true }));
  expect(accepted).toMatchObject({ classification: null, recordedClassification: quota, modelResponded: true });
  const anomalous = persistTurn(loop, iteration(), freshOf({ exitOnly: true, anomalyReason: 'x' }));
  expect(anomalous.classification).toBe(quota);
});

test('resolvePendingVerify keeps a pending failure and marks the iteration pending-gate', () => {
  const { store, context } = execution();
  const result = resolvePendingVerify(
    { stage: null, artifactName: null, context, store },
    { responseText: 'r', outcome: null, invokeError: 'err', gateFailure: null },
  );
  expect(result).toMatchObject({ invokeError: 'err', eligible: true, pendingGate: true, needsVerify: false });
});

test('resolvePendingVerify accepts a saved complete reply that passes the output gates', () => {
  const { store, context } = execution();
  const result = resolvePendingVerify(
    { stage: null, artifactName: null, context, store },
    { responseText: 'r', outcome: complete, invokeError: null, gateFailure: null },
  );
  expect(result).toMatchObject({ outcome: complete, invokeError: null, gateFailure: null });
});

test('failStage and finishWithoutVerify save the execution', () => {
  const { store, record, context } = execution();
  const loop = { verify: verifyState(), failure: { failureReason: '', classification: null } };
  expect(finishWithoutVerify({ record, store, context }, loop, iteration())).toEqual({ finished: false, failureReason: '' });
  const nothing = { ...loop, verify: verifyState({ verifyCommands: [] }) };
  const ended = finishWithoutVerify({ record, store, context }, nothing, iteration());
  expect(ended.finished).toBe(true);
  expect(record.status).toBe('completed');
});

test('failStage marks the record failed and saves the execution', () => {
  const { store, record, context } = execution();
  failStage({ record, store, context }, 'bad', { final_turn: 1 });
  expect(record.status).toBe('failed');
});

test('finishWithoutVerify reports the quota failure reason', () => {
  const { store, record, context } = execution();
  const loop = { verify: verifyState({ verifyCommands: [] }), failure: { failureReason: '', classification: quota } };
  const ended = finishWithoutVerify({ record, store, context }, loop, iteration({ invokeError: 'quota' }));
  expect(ended).toEqual({ finished: true, failureReason: 'quota' });
  expect(record.status).toBe('failed');
});

test('verifyVerdict ends on pass and on an infrastructure error', () => {
  const { store, record, context, eventReporter, events } = execution();
  const target = { record, store, context, eventReporter };
  const base = { passed: true, infraError: null, commands: [] } satisfies VerifyRunResult;
  const lastReport = store.saveTurnVerify(context, 1, 'report');
  const passed = verifyVerdict({ target, state: verifyState(), lastReport }, iteration(), base);
  expect(passed).toMatchObject({ verdict: { kind: 'end', outcome: complete }, red: 0, failureReason: null });
  expect(record.status).toBe('completed');
  expect(events()).toContain('verify.passed');
});

test('verifyVerdict ends the execution on an infrastructure error', () => {
  const { store, record, context, eventReporter } = execution();
  const target = { record, store, context, eventReporter };
  const result: VerifyRunResult = { passed: false, infraError: 'no shell', commands: [] };
  const infra = verifyVerdict({ target, state: verifyState(), lastReport: 'r.md' }, iteration(), result);
  expect(infra.verdict.kind).toBe('end');
  expect(record.status).toBe('failed');
});

test('verifyVerdict repairs a red run and exhausts the budget', () => {
  const { store, record, context, eventReporter, events } = execution();
  const target = { record, store, context, eventReporter };
  const red: VerifyRunResult = {
    passed: false, infraError: null,
    commands: [{ command: 't', status: 'fail', exitCode: 1, log: null, tail: [] }],
  };
  const repair = verifyVerdict({ target, state: verifyState(), lastReport: 'r.md' }, iteration(), red);
  expect(repair).toEqual({ verdict: { kind: 'repair', report: 'r.md' }, red: 1, failureReason: null });
  const spent = verifyVerdict({ target, state: verifyState({ red: 1 }), lastReport: 'r.md' }, iteration(), red);
  expect(spent).toMatchObject({ verdict: { kind: 'end', outcome: null }, red: 2, failureReason: 'verify_exhausted' });
  expect(events()).toContain('verify.failed');
});

const inputs = (sessionId: string | null = null) => ({
  sessionId, stage: null, decisionValues: [], artifactName: null, ask: null, protocol: 1, files: FILES,
});

test('queueCorrection spends the budget once, persists it before the message, and resends on the same turn', () => {
  const { store, record, context, eventReporter, events } = execution();
  const loop = { record, store, context, eventReporter, ...inputs(), corrections: {}, turn: 1 };
  const queued = queueCorrection(loop, failureOf('question_file'));
  expect(queued).toMatchObject({ turn: 2, keepFile: true, currentAgentId: null });
  expect(queued?.corrections.question_file?.turn).toBe(1);
  expect(record.history).toHaveLength(1);
  expect(events()).toContain('question.file_invalid');
  const resend = queueCorrection({ ...loop, corrections: queued?.corrections ?? {} }, failureOf('question_file'));
  expect(resend?.turn).toBe(2);
  const exhausted = queueCorrection({ ...loop, corrections: queued?.corrections ?? {}, turn: 2 }, failureOf('question_file'));
  expect(exhausted).toBeNull();
});

test('gate continues with a queued correction, then fails the stage when the budget is used', () => {
  const { store, record, context, eventReporter } = execution();
  const failing = iteration({ gateFailure: failureOf('handoff'), invokeError: 'broken' });
  const base = {
    record, store, context, eventReporter, ...inputs(), corrections: {}, verify: verifyState({ verifyCommands: [] }),
    failure: { failureReason: '', classification: null }, failureDetail: '', fresh: true, turn: 1,
  };
  const first = gate(base, failing);
  expect(first.step).toBe('continue');
  expect(first.queued?.turn).toBe(2);
  const second = gate({ ...base, corrections: first.queued?.corrections ?? {}, turn: 2 }, failing);
  expect(second).toMatchObject({ step: 'stop', queued: null, failureReason: 'handoff_file_invalid' });
  expect(second.failureDetail).toContain('handoff file is unusable');
  expect(record.status).toBe('failed');
});

test('gate stops a fresh turn that has nothing to verify but lets a pending reply proceed', () => {
  const { store, record, context, eventReporter } = execution();
  const base = {
    record, store, context, eventReporter, ...inputs(), corrections: {}, verify: verifyState({ verifyCommands: [] }),
    failure: { failureReason: '', classification: null }, failureDetail: '', fresh: true, turn: 1,
  };
  record.status = 'completed';
  expect(gate(base, iteration()).step).toBe('stop');
  expect(gate(base, iteration({ needsVerify: true })).step).toBe('proceed');
  expect(gate({ ...base, fresh: false }, iteration()).step).toBe('proceed');
});

function turnResult(patch: Partial<TurnResult> = {}): TurnResult {
  return {
    responseText: 'echo', sessionId: null, invokeError: null, argv: [], usage: null, classification: null,
    source: undefined, exitCode: 0, summarizer: new StreamSummarizer(false), ...patch,
  };
}

test('invoke removes the signal file unless kept and returns the classification', async () => {
  const { store, record, context, eventReporter, workspace } = execution();
  const signalFile = path.join(workspace, 'signal.json');
  writeFileSync(signalFile, '{}', 'utf8');
  const turnArgs: RunTurnArgs = {
    client: new FakeClient(), model: 'm1', workspace, prompt: 'go', agentId: null, newSession: null,
    options: {}, eventReporter, store, context, turn: 1,
  };
  const loop = { turnArgs, signalFile, keepFile: false, record, profile: {}, workspacePath: workspace };
  const result = await invoke(loop, () => Promise.resolve(turnResult({ classification: quota })));
  expect(existsSync(signalFile)).toBe(false);
  expect(result.classification).toBe(quota);
  writeFileSync(signalFile, '{}', 'utf8');
  await invoke({ ...loop, keepFile: true }, () => Promise.resolve(turnResult()));
  expect(existsSync(signalFile)).toBe(true);
});

test('invoke marks the execution cancelled and rethrows a cancellation', async () => {
  const { store, record, context, eventReporter, workspace } = execution();
  const turnArgs: RunTurnArgs = {
    client: new FakeClient(), model: 'm1', workspace, prompt: 'go', agentId: null, newSession: null,
    options: {}, eventReporter, store, context, turn: 1,
  };
  const cancel = new CancellationRequested(2);
  const loop = { turnArgs, signalFile: path.join(workspace, 's'), keepFile: true, record, profile: {}, workspacePath: workspace };
  await expect(invoke(loop, () => Promise.reject(cancel))).rejects.toBe(cancel);
  expect(record.status).toBe('cancelled');
});

test('verify runs the commands, saves the report, and returns the counters and verdict', async () => {
  const { store, record, context, eventReporter, workspace, events } = execution();
  const verifyRunner = {
    run: () => Promise.resolve<VerifyRunResult>({ passed: true, infraError: null, commands: [] }),
  };
  const result = await verify(
    {
      record, store, context, eventReporter, stage: null, workspacePath: workspace, verifyRunner,
      verify: verifyState(),
    },
    iteration(),
  );
  expect(result).toMatchObject({ verifyRuns: 1, lastResult: 'pass', outcome: { verdict: { kind: 'end' }, red: 0 } });
  expect(result.lastReport).toMatch(/verify/);
  expect(events()).toContain('verify.started');
});

test('queueRepair queues a repair turn from the saved report', async () => {
  const { store, record, context, eventReporter, workspace } = execution();
  const verifyRunner = {
    run: () => Promise.resolve<VerifyRunResult>({
      passed: false, infraError: null,
      commands: [{ command: 't', status: 'fail', exitCode: 1, log: null, tail: ['x'] }],
    }),
  };
  const ran = await verify(
    {
      record, store, context, eventReporter, stage: null, workspacePath: workspace, verifyRunner,
      verify: verifyState(),
    },
    iteration(),
  );
  expect(ran.outcome.verdict.kind).toBe('repair');
  const queued = queueRepair({ record, store, context, ...inputs(), red: 1, maxVerify: 2, turn: 1 }, ran.lastReport);
  expect(queued.turn).toBe(2);
  expect(queued.currentPrompt.length).toBeGreaterThan(0);
  expect(record.history.at(-1)?.role).toBe('user');
});
