import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  CancellationRequested, type CorrectionFiles, type FailureClassification, StageOutcome, StreamSummarizer,
  type VerifyRunResult,
} from '@nodeint/migent-kernel';
import { createWorkflowSession, SessionStore } from '@nodeint/migent-session';
import { expect, test } from 'vitest';

import { ExecutionApplier } from '../src/execution/applier.ts';
import type { Change } from '../src/execution/changes.ts';
import {
  createAgentTurnOperation, createReplyGateOperation, createVerifyRunOperation,
} from '../src/execution/handlers.ts';
import { toOutcomeData } from '../src/execution/outcome-data.ts';
import { roleDefinition } from '../src/execution/role-definition.ts';
import { savedGateRequest, turnRequest, verifyRequest } from '../src/execution/role-requests.ts';
import type { ReplyState, RoleFacts, RoleState } from '../src/execution/role-state.ts';
import { persistTurn, turnDiagnostics } from '../src/execution/role-turn.ts';
import {
  type ClassificationData, type GateInput, type GateOutput, type TurnOutput, VERIFY_RUN, type VerifyOutput,
} from '../src/execution/types.ts';
import { ProviderEventReporter } from '../src/provider-events.ts';
import { finalFields } from '../src/turn-steps.ts';
import type { RunTurnArgs, TurnResult } from '../src/turn-types.ts';
import { FakeClient, holdSessionLock, tempDir } from './support.ts';

const WORKFLOW = ['schema_version: 3', 'id: wf', 'stages:', '  - { id: one, role: developer }', ''].join('\n');
const CONFIG = [
  'schema_version: 8', 'agents:', '  main:', '    client:', '      type: fake', '    model: m1',
  'roles:', '  developer:', '    agent: main', '',
].join('\n');
const FILES: CorrectionFiles = { protocol: 1, questionFile: '/q.json', handoffFile: '/h.json' };

/** A real session store, execution context, record, and applier in a temporary workspace. */
function execution() {
  const workspace = tempDir('migent-exec-');
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
  const applier = new ExecutionApplier({ record, store, context, eventReporter });
  const events = (): string => readFileSync(path.join(workspace, '.migent', 'sessions', sessionId, 'events.jsonl'), 'utf8');
  return { workspace, sessionId, store, record, context, eventReporter, applier, events };
}
type Execution = ReturnType<typeof execution>;

function stateOf(run: Execution, patch: Partial<RoleState> = {}, facts: Partial<RoleFacts> = {}): RoleState {
  return {
    facts: {
      context: run.context, clientId: 'fake', model: 'm1', profile: {}, workspacePath: run.workspace,
      sessionId: null, stage: null, decisionValues: [], artifactName: null, ask: null, protocol: 1, files: FILES,
      verifyCommands: ['t'], maxVerify: 2, verifyTimeoutSec: null, ...facts,
    },
    turn: 1, red: 0, verifyRuns: 0, lastReport: null, lastResult: null, corrections: {}, classification: null,
    failureReason: '', failureDetail: '', currentAgentId: null, recordAgentId: null, history: [], status: 'running',
    reply: null, ...patch,
  };
}

const complete = new StageOutcome('complete');
const quota: ClassificationData = {
  kind: 'quota', origin: 'provider-error', message: 'limit', resetAt: 'tomorrow', window: 'day',
};

function turnOutput(patch: Partial<TurnOutput> = {}): TurnOutput {
  return {
    responseText: 'hi', sessionId: null, invokeError: null, exitCode: 0, parsedSource: null, source: 'model',
    classification: null, agentId: null, turnDetails: { turn: 1 }, recordsTurn: false, exitOnly: false,
    candidate: false, eligible: true, anomalyReason: null, exitMessage: null, turnError: null, failure: null,
    facts: null, stream: null, gate: gateOutput(), ...patch,
  };
}

function gateOutput(patch: Partial<GateOutput> = {}): GateOutput {
  return {
    responseText: 'hi', outcome: toOutcomeData(complete), invokeError: null, gateFailure: null, eligible: true,
    pendingGate: false, anomalyReason: null, turnError: null,
    gates: { outcome: { state: 'passed' }, artifact: { state: 'not-applicable' }, completion_outputs: { state: 'passed' } },
    ...patch,
  };
}

function replyState(gate: GateOutput, needsVerify: boolean): ReplyState {
  return { ...gate, needsVerify };
}

/** Runs the definition over a fresh turn whose gates ran inside the provider turn, and commits what it proposes. */
function decideGate(run: Execution, state: RoleState, turn: TurnOutput, gate: GateOutput) {
  const request = turnRequest(state, { prompt: 'p', keepFile: false, newAgentId: null });
  const transition = roleDefinition.decide({ ...state, classification: turn.classification }, request, {
    kind: 'succeeded', output: { ...turn, gate }, changes: [],
  });
  run.applier.apply(transition.changes);
  return transition;
}

/** Runs the definition over the gates of a saved reply a resumed execution starts from. */
function decideSaved(run: Execution, state: RoleState, input: GateInput, gate: GateOutput) {
  const transition = roleDefinition.decide(state, savedGateRequest(state, input), {
    kind: 'succeeded', output: gate, changes: [],
  });
  run.applier.apply(transition.changes);
  return transition;
}

function decideVerify(run: Execution, state: RoleState, result: VerifyRunResult, report = 'report text') {
  const output: VerifyOutput = { result: JSON.parse(JSON.stringify(result)) as VerifyOutput['result'], report, reportPath: 'turns/01/verify.md' };
  const changes: Change[] = [{ kind: 'saveTurnVerify', turn: state.turn, report }];
  const transition = roleDefinition.decide(state, verifyRequest(state), { kind: 'succeeded', output, changes });
  run.applier.apply(transition.changes);
  return transition;
}

const red: VerifyRunResult = {
  passed: false, infraError: null, commands: [{ command: 't', status: 'fail', exitCode: 1, log: null, tail: [] }],
};

test('finalFields adds the final turn', () => {
  expect(finalFields(3, { a: 1 })).toEqual({ a: 1, final_turn: 3 });
  expect(finalFields(2, null)).toEqual({ final_turn: 2 });
});

test('persistTurn records the reply and asks for verify on a complete outcome', () => {
  const run = execution();
  const persisted = persistTurn(stateOf(run), turnOutput(), gateOutput());
  run.applier.apply(persisted.changes);
  expect(persisted).toMatchObject({ needsVerify: true, modelResponded: true });
  expect(persisted.state).toMatchObject({ status: 'running', classification: null });
  expect(run.record.status).toBe('running');
  expect(run.record.history).toEqual([{ role: 'assistant', content: 'hi' }]);
  expect(readFileSync(path.join(run.context.directory, 'response.md'), 'utf8')).toContain('hi');
});

test('persistTurn fails the record on an invoke error and keeps the reply out of history', () => {
  const run = execution();
  const persisted = persistTurn(
    stateOf(run, {}, { verifyCommands: [] }), turnOutput({ source: 'error' }), gateOutput({ invokeError: 'boom' }),
  );
  run.applier.apply(persisted.changes);
  expect(persisted).toMatchObject({ needsVerify: false, modelResponded: false });
  expect(run.record.status).toBe('failed');
  expect(run.record.history).toEqual([]);
});

test('persistTurn clears the classification of an accepted exit-only turn but keeps an anomalous one', () => {
  const run = execution();
  const state = stateOf(run, { classification: quota }, { verifyCommands: [] });
  const accepted = persistTurn(state, turnOutput({ exitOnly: true }), gateOutput());
  expect(accepted.state.classification).toBeNull();
  expect(accepted.modelResponded).toBe(true);
  const anomalous = persistTurn(state, turnOutput({ exitOnly: true }), gateOutput({ anomalyReason: 'x' }));
  expect(anomalous.state.classification).toBe(quota);
  // The diagnostics still record the classification the turn had before the accepted reset.
  const turn = turnOutput({ exitOnly: true, recordsTurn: true, classification: quota });
  const verdict = turnDiagnostics(state, turn, { gate: gateOutput(), modelResponded: true });
  expect(verdict).toMatchObject([{ kind: 'writeTurnDiagnostics', verdict: { classification: quota, accepted: true } }]);
});

const GATE_SERVICES = (run: Execution) => ({
  sessionId: null, stage: null, decisionValues: [], artifactName: null, ask: null, protocol: 1, files: FILES,
  store: run.store, context: run.context,
});

test('the reply gate keeps a pending failure and marks a saved reply pending-gate', async () => {
  const run = execution();
  const gate = createReplyGateOperation(GATE_SERVICES(run));
  const base: GateInput = { responseText: 'r', invokeError: 'err', gateFailure: null, outcome: null };
  const kept = await gate.handle(base);
  expect(kept).toMatchObject({
    kind: 'succeeded', output: { invokeError: 'err', eligible: true, pendingGate: true },
  });
  const accepted = await gate.handle({ ...base, invokeError: null, outcome: toOutcomeData(complete) });
  expect(accepted).toMatchObject({ output: { invokeError: null, gateFailure: null, outcome: { status: 'complete' } } });
});

test('a complete reply with nothing to verify ends the execution completed and saves it', () => {
  const run = execution();
  const state = stateOf(run, { turn: 1 }, { verifyCommands: [] });
  const gate = gateOutput();
  const transition = decideGate(run, state, turnOutput(), gate);
  expect(transition.kind).toBe('end');
  expect(run.record.status).toBe('completed');
  const saved = JSON.parse(readFileSync(path.join(run.context.directory, 'execution.json'), 'utf8')) as Record<string, unknown>;
  expect(saved).toMatchObject({ status: 'completed', final_turn: 1 });
});

test('a failed fresh turn reports the quota failure reason', () => {
  const run = execution();
  const state = stateOf(run, { classification: quota }, { verifyCommands: [] });
  const transition = decideGate(
    run, state, turnOutput({ classification: quota, eligible: false }), gateOutput({ invokeError: 'quota', outcome: null, eligible: false }),
  );
  expect(transition).toMatchObject({ kind: 'end', result: { failureReason: 'quota' } });
  expect(run.record.status).toBe('failed');
});

test('a passing verify run ends completed, emits verify.passed, and publishes the report', () => {
  const run = execution();
  const state = stateOf(run, { reply: replyState(gateOutput(), true) });
  const ended = decideVerify(run, state, { passed: true, infraError: null, commands: [] });
  expect(ended).toMatchObject({ kind: 'end', result: { outcome: { status: 'complete' } } });
  expect(run.record.status).toBe('completed');
  expect(run.events()).toContain('verify.passed');
  const saved = JSON.parse(readFileSync(path.join(run.context.directory, 'execution.json'), 'utf8')) as Record<string, unknown>;
  expect(saved).toMatchObject({
    status: 'completed', verify: { runs: 1, red: 0, last_result: 'pass', last_report: 'turns/01/verify.md' },
  });
  expect(existsSync(path.join(run.context.artifactDirectory, 'verify.md'))).toBe(true);
});

test('a verify infrastructure error ends the execution failed', () => {
  const run = execution();
  const state = stateOf(run, { reply: replyState(gateOutput(), true) });
  const ended = decideVerify(run, state, { passed: false, infraError: 'no shell', commands: [] });
  expect(ended.kind).toBe('end');
  expect(run.record.status).toBe('failed');
});

test('a red verify run queues a repair, and an exhausted budget ends the execution', () => {
  const run = execution();
  const state = stateOf(run, { reply: replyState(gateOutput(), true) });
  const repair = decideVerify(run, state, red);
  expect(repair.kind).toBe('next');
  if (repair.kind === 'next') {
    expect(repair.state).toMatchObject({
      turn: 2, red: 1, verifyRuns: 1, lastResult: 'fail', lastReport: 'turns/01/verify.md',
    });
    expect(repair.request.input).toMatchObject({ prompt: expect.stringContaining('Verify failed') as string });
    expect(repair.request.input).toMatchObject({ keepFile: false });
    expect(repair.request.identity).toMatchObject({ operationId: 'agent.turn', attempt: 2 });
  }
  expect(run.record.history.at(-1)?.role).toBe('user');
  const spent = decideVerify(run, stateOf(run, { red: 1, reply: replyState(gateOutput(), true) }), red);
  expect(spent).toMatchObject({ kind: 'end', result: { failureReason: 'verify_exhausted', outcome: null } });
  expect(run.events()).toContain('verify.failed');
});

test('a correction spends the budget once, persists it before the message, and resends on the same turn', () => {
  const run = execution();
  const failing = gateOutput({
    gateFailure: { kind: 'question_file', errorKind: 'bad', detail: 'broken' }, invokeError: 'broken', outcome: null,
  });
  const state = stateOf(run, {}, { verifyCommands: [] });
  const first = decideGate(run, state, turnOutput(), failing);
  expect(first.kind).toBe('next');
  if (first.kind !== 'next') return;
  expect(first.state).toMatchObject({ turn: 2, currentAgentId: null });
  expect(first.request.input).toMatchObject({ keepFile: true, agentId: null, newAgentId: null });
  expect(first.state.corrections.question_file?.turn).toBe(1);
  expect(run.record.history.map((item) => item.role)).toEqual(['assistant', 'user']);
  expect(run.events()).toContain('question.file_invalid');
  // The budget is saved before the correction message joins the history.
  expect(run.record.history).toHaveLength(2);
  const again = stateOf(run, { corrections: first.state.corrections }, { verifyCommands: [] });
  const resend = decideGate(run, again, turnOutput(), failing);
  expect(resend).toMatchObject({ kind: 'next', state: { turn: 2 } });
  const exhausted = decideGate(
    run, stateOf(run, { corrections: first.state.corrections, turn: 2 }, { verifyCommands: [] }), turnOutput(), failing,
  );
  expect(exhausted).toMatchObject({ kind: 'end', result: { failureReason: 'question_file_invalid' } });
  expect(run.record.status).toBe('failed');
});

test('a fresh turn with nothing to verify ends, but a saved reply goes on to verify', () => {
  const run = execution();
  const state = stateOf(run);
  const saved: GateInput = { responseText: 'r', invokeError: null, gateFailure: null, outcome: toOutcomeData(complete) };
  const proceeds = decideSaved(run, state, saved, gateOutput({ pendingGate: true }));
  expect(proceeds).toMatchObject({ kind: 'next', request: { identity: { operationId: VERIFY_RUN, attempt: 1 } } });
  const fresh = decideGate(run, stateOf(run, {}, { verifyCommands: [] }), turnOutput(), gateOutput());
  expect(fresh.kind).toBe('end');
  // A fresh complete turn with a verify list goes straight to verify, with no operation between.
  const verifying = decideGate(run, stateOf(run), turnOutput(), gateOutput());
  expect(verifying).toMatchObject({ kind: 'next', request: { identity: { operationId: VERIFY_RUN, attempt: 1 } } });
});

test('a saved reply without a complete outcome ends instead of verifying', () => {
  const run = execution();
  const failed = decideSaved(
    run, stateOf(run), { responseText: 'r', invokeError: 'err', gateFailure: null, outcome: null },
    gateOutput({ invokeError: 'err', outcome: null, pendingGate: true }),
  );
  expect(failed.kind).toBe('end');
  expect(run.record.status).toBe('failed');
});

test('a handoff failure with its budget spent fails the stage with the unusable-handoff detail', () => {
  const run = execution();
  const failing = gateOutput({
    gateFailure: { kind: 'handoff', errorKind: 'bad', detail: 'broken' }, invokeError: 'broken', outcome: null,
  });
  const state = stateOf(run, {}, { verifyCommands: [] });
  const first = decideGate(run, state, turnOutput(), failing);
  expect(first).toMatchObject({ kind: 'next', request: { identity: { operationId: 'agent.turn', attempt: 2 } } });
  if (first.kind !== 'next') return;
  const second = decideGate(run, { ...state, turn: 2, corrections: first.state.corrections }, turnOutput(), failing);
  expect(second).toMatchObject({ kind: 'end', result: { failureReason: 'handoff_file_invalid' } });
  if (second.kind === 'end') expect(second.result.failureDetail).toContain('handoff file is unusable');
  expect(run.record.status).toBe('failed');
});

function turnResult(patch: Partial<TurnResult> = {}): TurnResult {
  return {
    responseText: 'echo', sessionId: null, invokeError: null, argv: [], usage: null, classification: null,
    source: undefined, exitCode: 0, summarizer: new StreamSummarizer(false), ...patch,
  };
}

function turnOperation(run: Execution, signalFile: string, runTurn: (args: RunTurnArgs) => Promise<TurnResult>) {
  return createAgentTurnOperation({
    client: new FakeClient(), model: 'm1', workspace: run.workspace, options: {}, store: run.store,
    context: run.context, eventReporter: run.eventReporter, signalFile, applier: run.applier, runTurn,
    gates: GATE_SERVICES(run),
  });
}

const input = {
  turn: 1, prompt: 'go', agentId: null, newAgentId: null, recordAgentId: null, keepFile: false,
} as const;

test('the provider turn removes the signal file unless kept and returns the classification', async () => {
  const run = execution();
  const signalFile = path.join(run.workspace, 'signal.json');
  writeFileSync(signalFile, '{}', 'utf8');
  const classification: FailureClassification = { kind: 'quota', origin: 'provider-error', message: 'limit', resetAt: 'tomorrow', window: 'day' };
  const operation = turnOperation(run, signalFile, () => Promise.resolve(turnResult({ classification })));
  const result = await operation.handle(input);
  expect(existsSync(signalFile)).toBe(false);
  expect(result).toMatchObject({ kind: 'succeeded', output: { classification: { kind: 'quota' } } });
  writeFileSync(signalFile, '{}', 'utf8');
  await turnOperation(run, signalFile, () => Promise.resolve(turnResult())).handle({ ...input, keepFile: true });
  expect(existsSync(signalFile)).toBe(true);
});

test('the provider turn marks the execution cancelled and rethrows a cancellation', async () => {
  const run = execution();
  const cancel = new CancellationRequested(2);
  const operation = turnOperation(run, path.join(run.workspace, 's'), () => Promise.reject(cancel));
  await expect(operation.handle({ ...input, keepFile: true })).rejects.toBe(cancel);
  expect(run.record.status).toBe('cancelled');
  expect(run.events()).toContain('provider.cancelled');
});

test('the verify operation runs the commands, proposes the report, and a repair prompt follows a red run', async () => {
  const run = execution();
  const verifyRunner = { run: () => Promise.resolve<VerifyRunResult>(red) };
  const operation = createVerifyRunOperation({
    store: run.store, context: run.context, eventReporter: run.eventReporter, verifyRunner, workspace: run.workspace,
    applier: run.applier, cancel: 'role',
  });
  const request = verifyRequest(stateOf(run));
  const result = await operation.handle(request.input as never);
  expect(result).toMatchObject({ kind: 'succeeded', changes: [{ kind: 'saveTurnVerify', turn: 1 }] });
  expect(run.events()).toContain('verify.started');
});
