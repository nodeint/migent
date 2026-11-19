import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { type BuildCommandInput, type CommandSpec, raiseCancellation, StageOutcome, type VerifyRunResult } from '@nodeint/migent-kernel';
import { createWorkflowSession } from '@nodeint/migent-session';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';

import { ExecutionApplier } from '../src/execution/applier.ts';
import { createReplyGateOperation, createVerifyRunOperation } from '../src/execution/handlers.ts';
import { toOutcomeData, toStageOutcome } from '../src/execution/outcome-data.ts';
import { roleDefinition } from '../src/execution/role-definition.ts';
import {
  gateInputCheck, gateOutputCheck, turnInputCheck, turnOutputCheck, verifyInputCheck, verifyOutputCheck,
} from '../src/execution/shapes.ts';
import { verifyOnlyDefinition } from '../src/execution/verify-only-definition.ts';
import { AgentToolRunner, executeNamedWorkflow } from '../src/index.ts';
import { isPlainData } from '../src/runtime/plain-data.ts';
import { ALLOW_ALL_POLICY } from '../src/runtime/policy.ts';
import { registryOf, ScriptedClient, tempDir as createTempDir } from './support.ts';

vi.setConfig({ testTimeout: 60_000 });
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function tempDir(prefix: string): string {
  const directory = createTempDir(prefix);
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return directory;
}

const CONFIG = 'agents:\n  fake:\n    client:\n      type: fake\n    model: m1\nroles:\n  developer:\n    agent: fake\n';
const OK = 'status: complete\n\ndone';

function workspaceWith(workflow: string): { workspace: string; sessionId: string } {
  const workspace = tempDir('migent-operations-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), CONFIG, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), workflow, 'utf8');
  return { workspace, sessionId: createWorkflowSession(workspace, 'wf', { task: 'Finish the notes' }) };
}

function roleWorkflow(verify: string[]): string {
  const lines = verify.map((item) => `      - ${JSON.stringify(item)}\n`).join('');
  return `id: wf
stages:
  - id: implement
    role: developer
${verify.length > 0 ? '    max_verify: 3\n' : ''}    produces:
      artifact: notes.md
${verify.length > 0 ? `    verify:\n${lines}` : ''}completion:
  stage: implement
`;
}

function verifyOnlyWorkflow(command: string): string {
  return `schema_version: 2
id: wf
stages:
  - id: prepare
    verify:
      - ${JSON.stringify(command)}
    depends_on: []
  - id: implement
    role: developer
    depends_on: [prepare]
    produces:
      artifact: notes.md
outputs:
  - name: notes
    from_stage: implement
    artifact: notes.md
`;
}

function verifyScript(root: string, exits: number[], hold: number[] = []) {
  const counter = path.join(root, 'runs');
  const pidFile = path.join(root, 'verify-pid');
  const go = path.join(root, 'go');
  const script = path.join(root, 'verify.cjs');
  writeFileSync(script, `const fs=require("fs");
const f=${JSON.stringify(counter)};
const n=(fs.existsSync(f)?Number(fs.readFileSync(f,"utf8")):0)+1;
fs.writeFileSync(f,String(n));
const exits=${JSON.stringify(exits)};
const hold=${JSON.stringify(hold)};
if(hold.includes(n)&&!fs.existsSync(${JSON.stringify(go)})){
  fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
  setInterval(()=>{},1000);
} else process.exit(exits[n-1]??0);
`, 'utf8');
  return { command: `"${process.execPath}" "${script}"`, pidFile, go };
}

function cancelWhenRunning(pidFile: string): void {
  const timer = setInterval(() => {
    if (!existsSync(pidFile) || readFileSync(pidFile, 'utf8').trim() === '') return;
    clearInterval(timer);
    try {
      raiseCancellation(15);
    } catch {
      // Waiters were woken; the throw is for signal handlers.
    }
  }, 40);
  onTestFinished(() => { clearInterval(timer); });
}

class ExitCodes extends ScriptedClient {
  private call = 0;
  constructor(private readonly exits: number[], responses: string[], artifacts?: (string | null)[]) {
    super(responses, artifacts);
  }

  override buildCommand(input: BuildCommandInput): CommandSpec {
    super.buildCommand(input);
    const code = this.exits[this.call] ?? 0;
    this.call += 1;
    return { argv: [process.execPath, '-e', `process.exit(${code})`] };
  }
}

const runner = (provider: ScriptedClient): AgentToolRunner => new AgentToolRunner(registryOf({ fake: provider }), 10);

type Entry = { kind: string; operationId?: string; attempt?: number; executionId?: string; verdict?: string;
  outcome?: string; transition?: string; nextOperationId?: string | null };

/** The runtime decisions of every execution, read from the execution's own debug log. */
function trace(workspace: string, sessionId: string): { executions: string[]; entries: Entry[] } {
  const root = path.join(workspace, '.migent', 'sessions', sessionId, 'executions');
  const executions = readdirSync(root);
  const entries = executions.flatMap((id) => {
    const file = path.join(root, id, 'debug.log');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').filter((line) => line.includes(' runtime {')).map(
      (line) => JSON.parse(line.slice(line.indexOf(' runtime ') + ' runtime '.length)) as Entry,
    );
  });
  return { executions, entries };
}

/** The request identities in order, without the transient invocation id. */
const requests = (entries: readonly Entry[]): string[] =>
  entries.filter((entry) => entry.kind === 'request').map((entry) => `${entry.operationId}#${entry.attempt}`);

type Identity = { executionId: string; operationId: string; attempt: number };

/** The full logical identities in order: execution, operation and durable attempt. */
const identities = (entries: readonly Entry[]): Identity[] =>
  entries.filter((entry) => entry.kind === 'request').map((entry) => ({
    executionId: entry.executionId!, operationId: entry.operationId!, attempt: entry.attempt!,
  }));

const transitions = (entries: readonly Entry[]): (string | null | undefined)[] =>
  entries.filter((entry) => entry.kind === 'transition').map((entry) => entry.nextOperationId);

/** What the real operations received and returned, read where the runtime hands them over. */
type Observed = {
  inputs: { identity: Identity; input: unknown }[];
  contexts: unknown[];
  outputs: { operationId: string; output: unknown }[];
};

/** Spies on the shared policy and on both definitions; production code is not configured for this. */
function observeBoundaries(): Observed {
  const seen: Observed = { inputs: [], contexts: [], outputs: [] };
  const evaluate = ALLOW_ALL_POLICY.evaluate.bind(ALLOW_ALL_POLICY);
  vi.spyOn(ALLOW_ALL_POLICY, 'evaluate').mockImplementation((request, context) => {
    seen.inputs.push({ identity: request.identity, input: request.input });
    seen.contexts.push(context);
    return evaluate(request, context);
  });
  type Seen = { identity: { operationId: string } };
  type Result = { kind: string; output?: unknown };
  const record = (request: Seen, outcome: Result): void => {
    if (outcome.kind !== 'succeeded') return;
    seen.outputs.push({ operationId: request.identity.operationId, output: outcome.output });
  };
  const decideRole = roleDefinition.decide.bind(roleDefinition);
  vi.spyOn(roleDefinition, 'decide').mockImplementation((state, request, outcome) => {
    record(request, outcome);
    return decideRole(state, request, outcome);
  });
  const decideVerify = verifyOnlyDefinition.decide.bind(verifyOnlyDefinition);
  vi.spyOn(verifyOnlyDefinition, 'decide').mockImplementation((state, request, outcome) => {
    record(request, outcome);
    return decideVerify(state, request, outcome);
  });
  return seen;
}

/** Plain prototypes all the way down, no live values, and a lossless JSON round trip. */
function expectPlain(value: unknown, label: string): void {
  expect(isPlainData(value), label).toBe(true);
  expect(JSON.parse(JSON.stringify(value)), label).toEqual(value);
  const walk = (item: unknown): void => {
    if (typeof item === 'function') throw new Error(`${label}: function member`);
    if (item === null || typeof item !== 'object') return;
    const proto = Object.getPrototypeOf(item) as unknown;
    expect(proto === Object.prototype || proto === Array.prototype || proto === null, label).toBe(true);
    for (const child of Object.values(item)) walk(child);
  };
  walk(value);
}

// --- the trace reaches the execution's debug log ---

test('under debug a clean turn traces one agent.turn that ends the execution, with no reply.gate step', async () => {
  vi.stubEnv('MIGENT_DEBUG', '1');
  const { workspace, sessionId } = workspaceWith(roleWorkflow([]));
  await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner(new ScriptedClient([OK], ['# n\n'])));
  const { entries } = trace(workspace, sessionId);
  expect(requests(entries)).toEqual(['agent.turn#1']);
  expect(entries.map((entry) => entry.kind)).toEqual(['request', 'policy', 'outcome', 'transition']);
  expect(transitions(entries)).toEqual([null]);
  expect(entries.every((entry) => isPlainData(entry))).toBe(true);
});

test('under debug a correction, red verify and repair trace their logical identities in order', async () => {
  vi.stubEnv('MIGENT_DEBUG', '1');
  const root = tempDir('migent-operations-v-');
  const script = verifyScript(root, [1, 0]);
  const { workspace, sessionId } = workspaceWith(roleWorkflow([script.command]));
  const provider = new ExitCodes([0, 0, 0], ['', OK, OK], [null, '# n\n', '# n\n']);
  const result = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner(provider));
  expect(result.code).toBe(0);
  const { entries } = trace(workspace, sessionId);
  // Turn 1 has no reply, so a correction is queued; turn 2 verifies red; turn 3 repairs and passes.
  expect(requests(entries)).toEqual([
    'agent.turn#1', 'agent.turn#2', 'run.verify#1', 'agent.turn#3', 'run.verify#2',
  ]);
  expect(transitions(entries)).toEqual(['agent.turn', 'run.verify', 'agent.turn', 'run.verify', null]);
  expect(entries.filter((entry) => entry.kind === 'policy').every((entry) => entry.verdict === 'allow')).toBe(true);
});

test('under debug a verify-only execution traces one run.verify attempt that ends', async () => {
  vi.stubEnv('MIGENT_DEBUG', '1');
  const root = tempDir('migent-operations-vo-');
  const script = verifyScript(root, [0]);
  const { workspace, sessionId } = workspaceWith(verifyOnlyWorkflow(script.command));
  await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner(new ScriptedClient([OK], ['# n\n'])));
  const { entries } = trace(workspace, sessionId);
  expect(requests(entries).slice(0, 1)).toEqual(['run.verify#1']);
  expect(transitions(entries)[0]).toBeNull();
});

test('with debug off no runtime trace and no debug log are written', async () => {
  vi.stubEnv('MIGENT_DEBUG', '');
  const { workspace, sessionId } = workspaceWith(roleWorkflow([]));
  await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner(new ScriptedClient([OK], ['# n\n'])));
  const { executions, entries } = trace(workspace, sessionId);
  expect(entries).toEqual([]);
  const directory = path.join(workspace, '.migent', 'sessions', sessionId, 'executions', executions[0]!);
  expect(existsSync(path.join(directory, 'debug.log'))).toBe(false);
  const events = readFileSync(path.join(workspace, '.migent', 'sessions', sessionId, 'events.jsonl'), 'utf8');
  expect(events).not.toContain('runtime');
});

// --- identities are stable across an interruption ---

class HangOnCalls extends ScriptedClient {
  public count = 0;
  constructor(
    private readonly hangOn: number[],
    private readonly pidFile: string,
    responses: string[],
    artifacts?: (string | null)[],
  ) {
    super(responses, artifacts);
  }

  override buildCommand(input: BuildCommandInput): CommandSpec {
    this.count += 1;
    if (!this.hangOn.includes(this.count)) return super.buildCommand(input);
    this.calls.push({
      model: input.model, workspace: input.workspace, prompt: input.prompt, agentId: input.agentId,
      newAgentId: input.newAgentId, promptFile: input.promptFile, options: { ...input.options },
    });
    const code = `require("fs").writeFileSync(${JSON.stringify(this.pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    return { argv: [process.execPath, '-e', code] };
  }
}

test('an interrupted repair turn resumes with the same logical identity', async () => {
  vi.stubEnv('MIGENT_DEBUG', '1');
  const root = tempDir('migent-operations-r-');
  const script = verifyScript(root, [1, 0]);
  const pidFile = path.join(root, 'provider-pid');
  const { workspace, sessionId } = workspaceWith(roleWorkflow([script.command]));
  const provider = new HangOnCalls([2], pidFile, [OK, OK], ['# n\n', '# n\n']);
  cancelWhenRunning(pidFile);
  const first = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner(provider));
  expect(first.stopReason).toBe('cancelled');
  const before = requests(trace(workspace, sessionId).entries);
  expect(before).toEqual(['agent.turn#1', 'run.verify#1', 'agent.turn#2']);
  await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId, resetRevisions: true }, runner(provider));
  const after = requests(trace(workspace, sessionId).entries);
  // The resumed run asks for the same repair turn, then the second verify run.
  expect(after.slice(before.length)).toEqual(['agent.turn#2', 'run.verify#2']);
});

test('an interrupted verify resumes as the saved reply gate and reruns the verify attempt', async () => {
  vi.stubEnv('MIGENT_DEBUG', '1');
  const root = tempDir('migent-operations-sv-');
  const script = verifyScript(root, [0], [1]);
  const { workspace, sessionId } = workspaceWith(roleWorkflow([script.command]));
  const provider = new ScriptedClient([OK], ['# n\n']);
  cancelWhenRunning(script.pidFile);
  const first = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner(provider));
  expect(first.stopReason).toBe('cancelled');
  const before = requests(trace(workspace, sessionId).entries);
  expect(before).toEqual(['agent.turn#1', 'run.verify#1']);
  writeFileSync(script.go, '1', 'utf8');
  await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId, resetRevisions: true }, runner(provider));
  const after = requests(trace(workspace, sessionId).entries);
  // Nothing was saved for the cancelled verify run, so the attempt is 1 again; the saved reply is gated first.
  expect(after.slice(before.length)).toEqual(['reply.gate#1', 'run.verify#1']);
  expect(provider.calls).toHaveLength(1);
});

test('an interrupted verify-only execution resumes with the same single attempt', async () => {
  vi.stubEnv('MIGENT_DEBUG', '1');
  const root = tempDir('migent-operations-vo2-');
  const script = verifyScript(root, [0], [1]);
  const { workspace, sessionId } = workspaceWith(verifyOnlyWorkflow(script.command));
  const provider = new ScriptedClient([OK], ['# n\n']);
  cancelWhenRunning(script.pidFile);
  await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner(provider));
  const before = requests(trace(workspace, sessionId).entries);
  expect(before).toEqual(['run.verify#1']);
  writeFileSync(script.go, '1', 'utf8');
  await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId, resetRevisions: true }, runner(provider));
  expect(requests(trace(workspace, sessionId).entries).slice(0, 2)).toEqual(['run.verify#1', 'run.verify#1']);
});

// --- every boundary rejects malformed payloads ---

const validTurnInput = {
  turn: 1, prompt: 'p', agentId: null, newAgentId: null, recordAgentId: null, keepFile: false,
};
const gates = {
  outcome: { state: 'passed' }, artifact: { state: 'not-applicable' }, completion_outputs: { state: 'not-evaluated' },
};
const validGate = {
  responseText: 'r', outcome: null, invokeError: null, gateFailure: null, eligible: true, pendingGate: false,
  anomalyReason: null, turnError: null, gates,
};
const validTurnOutput = {
  responseText: 'r', sessionId: null, invokeError: null, exitCode: 0, parsedSource: null, source: 'model',
  classification: null, agentId: null, turnDetails: { turn: 1 }, recordsTurn: false, exitOnly: false,
  candidate: false, eligible: true, anomalyReason: null, exitMessage: null, turnError: null, failure: null,
  facts: null,
  stream: {
    stdout_bytes: 0, lines: 0, non_json_lines: 0, events: {}, last_events: [], labelled: false,
    error_messages: [],
  },
  gate: validGate,
};
const validVerifyInput = {
  turn: 1, commands: ['t'], timeoutSec: null, run: 1, redIfPassed: 0, redIfFailed: 1, maxVerify: 2,
};
const validVerifyOutput = {
  result: { passed: true, infraError: null, commands: [] }, report: 'x', reportPath: 'turns/01/verify.md',
};

test('every check accepts a complete payload', () => {
  expect(turnInputCheck(validTurnInput)).toBe(true);
  expect(turnOutputCheck(validTurnOutput)).toBe(true);
  expect(gateInputCheck({ responseText: 'r', invokeError: null, gateFailure: null, outcome: null })).toBe(true);
  expect(gateOutputCheck(validGate)).toBe(true);
  expect(verifyInputCheck(validVerifyInput)).toBe(true);
  expect(verifyOutputCheck(validVerifyOutput)).toBe(true);
});

test('every check rejects a payload that misses a member or breaks a nested shape or literal', () => {
  const without = (value: object, key: string): object =>
    Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
  for (const key of Object.keys(validTurnOutput)) {
    expect(turnOutputCheck(without(validTurnOutput, key) as never), key).toBe(false);
  }
  for (const key of Object.keys(validGate)) expect(gateOutputCheck(without(validGate, key) as never), key).toBe(false);
  expect(turnOutputCheck({ ...validTurnOutput, source: 'robot' })).toBe(false);
  expect(turnOutputCheck({ ...validTurnOutput, classification: { kind: 'quota', origin: 'x', message: 'm' } })).toBe(false);
  expect(turnOutputCheck({ ...validTurnOutput, stream: {} })).toBe(false);
  expect(turnOutputCheck({ ...validTurnOutput, gate: { ...validGate, gates: { outcome: { state: 'bogus' } } } })).toBe(false);
  expect(gateInputCheck({ responseText: 'r', invokeError: null, gateFailure: null, outcome: { status: 'bogus' } })).toBe(false);
  expect(gateInputCheck({ responseText: 'r', invokeError: null, gateFailure: { kind: 'nope', errorKind: 'e', detail: 'd' }, outcome: null })).toBe(false);
  expect(verifyInputCheck({ ...validVerifyInput, commands: [42] })).toBe(false);
  expect(verifyOutputCheck({ result: {}, report: 'x', reportPath: 'turns/01/verify.md' })).toBe(false);
  const badCommand = { passed: true, infraError: null, commands: [{ command: 1 }] };
  expect(verifyOutputCheck({ ...validVerifyOutput, result: badCommand })).toBe(false);
});

test('the real operations refuse malformed requests through the runtime before running anything', async () => {
  const { OperationRuntime } = await import('../src/runtime/operation-runtime.ts');
  const { SessionStore } = await import('@nodeint/migent-session');
  const { ProviderEventReporter } = await import('../src/provider-events.ts');
  const workspace = tempDir('migent-operations-n-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), CONFIG, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), roleWorkflow([]), 'utf8');
  const sessionId = createWorkflowSession(workspace, 'wf', { task: 't' });
  const { holdSessionLock } = await import('./support.ts');
  holdSessionLock(workspace, sessionId);
  const store = new SessionStore(workspace);
  const [record, , context] = store.loadOrCreate({
    client: 'fake', model: 'm1', options: null, workspace, sessionId, stageId: 'implement', stageAttempt: 1,
    executionOrder: 1, prompt: 'go',
  });
  const eventReporter = new ProviderEventReporter({ store, context }, { client: 'fake', model: 'm1' });
  const applier = new ExecutionApplier({ record, store, context, eventReporter });
  const run = vi.fn(() => Promise.resolve<VerifyRunResult>({ passed: true, infraError: null, commands: [] }));
  const runtime = new OperationRuntime({
    applier,
    operations: [
      createVerifyRunOperation({
        store, context, eventReporter, verifyRunner: { run }, workspace, applier, cancel: 'role',
      }),
      createReplyGateOperation({
        sessionId: null, stage: null, decisionValues: [], artifactName: null, ask: null, protocol: 1,
        files: { protocol: 1, questionFile: '/q', handoffFile: '/h' }, store, context,
      }),
    ],
  });
  const definition = { edges: [], decide: () => { throw new Error('unreachable'); } };
  const scope = { sessionId, stageId: 'implement', role: 'developer' };
  const identity = { executionId: context.executionId, attempt: 1 };
  await expect(runtime.run({
    scope, definition, state: null,
    request: { identity: { ...identity, operationId: 'run.verify' }, input: { ...validVerifyInput, commands: [42] } },
  })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(runtime.run({
    scope, definition, state: null,
    request: {
      identity: { ...identity, operationId: 'reply.gate' },
      input: { responseText: 'r', invokeError: null, gateFailure: null, outcome: { status: 'bogus' } },
    },
  })).rejects.toMatchObject({ code: 'invalid_input' });
  expect(run).not.toHaveBeenCalled();
});

// --- conversion round trips ---

test('every outcome status and question form survives detach and revive, omitting nothing', () => {
  const question = {
    id: '1', question: 'Which?', context: 'Why', selection: 'single' as const,
    options: [{ id: 'A', label: 'a', description: 'first' }, { id: 'B', label: 'b' }], recommended: ['A'],
  };
  const outcomes = [
    new StageOutcome('complete'),
    new StageOutcome('complete', { decision: 'go' }),
    new StageOutcome('blocked', { blocker: 'stuck' }),
    new StageOutcome('question', { question: 'q', questions: [question, { ...question, id: '2', selection: 'multiple' as const, recommended: undefined }] }),
  ];
  for (const outcome of outcomes) {
    const data = toOutcomeData(outcome);
    expect(isPlainData(data)).toBe(true);
    expect(outcomeShape(data)).toBe(true);
    const back = toStageOutcome(JSON.parse(JSON.stringify(data)) as typeof data);
    expect(back).toBeInstanceOf(StageOutcome);
    expect(back.toJson()).toEqual(outcome.toJson());
    expect(back.questions).toEqual(JSON.parse(JSON.stringify(outcome.questions)));
  }
});

function outcomeShape(data: object): boolean {
  return gateOutputCheck({ ...validGate, outcome: data as never });
}

// --- One synchronous commit, in list order ---

test('the commit lands every write in list order before the next invocation starts', async () => {
  vi.stubEnv('MIGENT_DEBUG', '');
  const { workspace, sessionId } = workspaceWith(roleWorkflow([]));
  const order: string[] = [];
  const { SessionStore } = await import('@nodeint/migent-session');
  const proto = SessionStore.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of ['save', 'saveExecution', 'saveResponse']) {
    const original = proto[name]!;
    vi.spyOn(proto, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
      order.push(name);
      return original.apply(this, args);
    } as never);
  }
  await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner(new ScriptedClient([OK], ['# n\n'])));
  expect(order.indexOf('saveResponse')).toBeLessThan(order.lastIndexOf('saveExecution'));
  expect(order.at(-1)).toBe('saveExecution');
});

// --- real-handler boundary values and full logical identities across resume ---

const ASSERTED_OPERATIONS = ['agent.turn', 'reply.gate', 'run.verify'];

function expectBoundaries(seen: Observed, operations: readonly string[]): void {
  for (const operationId of operations) {
    const inputs = seen.inputs.filter((item) => item.identity.operationId === operationId);
    const outputs = seen.outputs.filter((item) => item.operationId === operationId);
    expect(inputs.length, `${operationId} input`).toBeGreaterThan(0);
    expect(outputs.length, `${operationId} output`).toBeGreaterThan(0);
    for (const item of inputs) expectPlain(item.input, `${operationId} input`);
    for (const item of outputs) expectPlain(item.output, `${operationId} output`);
  }
  expect(seen.contexts.length).toBeGreaterThan(0);
  for (const context of seen.contexts) {
    expectPlain(context, 'policy context');
    expect(Object.keys(context as object).sort()).toEqual(
      ['attempt', 'executionId', 'operationId', 'role', 'sessionId', 'stageId'],
    );
  }
}

test('the provider and verify operations see and return plain data, and the policy context is plain', async () => {
  const root = tempDir('migent-operations-b1-');
  const script = verifyScript(root, [1, 0]);
  const { workspace, sessionId } = workspaceWith(roleWorkflow([script.command]));
  const seen = observeBoundaries();
  const provider = new ExitCodes([0, 0, 0], ['', OK, OK], [null, '# n\n', '# n\n']);
  const result = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner(provider));
  expect(result.code).toBe(0);
  expectBoundaries(seen, ['agent.turn', 'run.verify']);
  // Provider outputs carry the detached verdict, never a live outcome or summarizer.
  const turn = seen.outputs.find((item) => item.operationId === 'agent.turn')!.output as { gate: unknown; stream: unknown };
  expectPlain(turn.gate, 'turn gate');
  expectPlain(turn.stream, 'turn stream');
});

test('the saved-reply gate sees and returns plain data after an interrupted verify', async () => {
  const root = tempDir('migent-operations-b2-');
  const script = verifyScript(root, [0], [1]);
  const { workspace, sessionId } = workspaceWith(roleWorkflow([script.command]));
  const provider = new ScriptedClient([OK], ['# n\n']);
  cancelWhenRunning(script.pidFile);
  await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner(provider));
  writeFileSync(script.go, '1', 'utf8');
  const seen = observeBoundaries();
  const result = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId, resetRevisions: true }, runner(provider));
  expect(result.code).toBe(0);
  expectBoundaries(seen, ['reply.gate', 'run.verify']);
  const saved = seen.inputs.find((item) => item.identity.operationId === 'reply.gate')!.input as { outcome: { status: string } };
  expect(saved.outcome.status).toBe('complete');
});

test('the verify-only execution sees and returns plain data', async () => {
  const root = tempDir('migent-operations-b3-');
  const script = verifyScript(root, [0]);
  const { workspace, sessionId } = workspaceWith(verifyOnlyWorkflow(script.command));
  const seen = observeBoundaries();
  const result = await executeNamedWorkflow(
    workspace, { workflowId: 'wf', sessionId }, runner(new ScriptedClient([OK], ['# n\n'])),
  );
  expect(result.code).toBe(0);
  expectBoundaries(seen, ['run.verify']);
});

/** Runs a cancelled execution, resumes it, and returns what each run requested. */
async function interruptedPair(options: {
  workflow: string;
  provider: ScriptedClient;
  stopFile: string;
  release?: string;
}) {
  const { workspace, sessionId } = workspaceWith(options.workflow);
  cancelWhenRunning(options.stopFile);
  const first = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner(options.provider));
  expect(first.stopReason).toBe('cancelled');
  const before = identities(trace(workspace, sessionId).entries);
  if (options.release !== undefined) writeFileSync(options.release, '1', 'utf8');
  const second = await executeNamedWorkflow(
    workspace, { workflowId: 'wf', sessionId, resetRevisions: true }, runner(options.provider),
  );
  expect(second.code).toBe(0);
  const after = identities(trace(workspace, sessionId).entries).slice(before.length);
  return { workspace, sessionId, before, after };
}

const executionIdsOf = (list: readonly Identity[]): string[] => [...new Set(list.map((item) => item.executionId))];

test('an interrupted correction turn resumes with the same execution, operation and attempt', async () => {
  vi.stubEnv('MIGENT_DEBUG', '1');
  const root = tempDir('migent-operations-i1-');
  const pidFile = path.join(root, 'provider-pid');
  const provider = new HangOnCalls([2], pidFile, ['', OK], [null, '# n\n']);
  const { workspace, sessionId, before, after } = await interruptedPair({
    workflow: roleWorkflow([]), provider, stopFile: pidFile,
  });
  expect(before.map((item) => `${item.operationId}#${item.attempt}`)).toEqual(['agent.turn#1', 'agent.turn#2']);
  // The resumed run requests exactly the interrupted request again: same execution, operation and attempt.
  expect(after).toEqual([before[1]]);
  expect(executionIdsOf([...before, ...after])).toHaveLength(1);
  expect(provider.calls).toHaveLength(3);
  const saved = JSON.parse(readFileSync(
    path.join(workspace, '.migent', 'sessions', sessionId, 'executions', before[0]!.executionId, 'execution.json'), 'utf8',
  )) as { status: string; corrections: Record<string, { turn: number }> };
  expect(saved.status).toBe('completed');
  // The correction budget stayed spent once.
  expect(Object.values(saved.corrections)).toHaveLength(1);
  expect(provider.calls[2]!.prompt).toBe(provider.calls[1]!.prompt);
});

test('an interrupted repair turn resumes with the same identity and the verify counters it left', async () => {
  vi.stubEnv('MIGENT_DEBUG', '1');
  const root = tempDir('migent-operations-i2-');
  const script = verifyScript(root, [1, 0]);
  const pidFile = path.join(root, 'provider-pid');
  const provider = new HangOnCalls([2], pidFile, [OK, OK], ['# n\n', '# n\n']);
  const { workspace, sessionId, before, after } = await interruptedPair({
    workflow: roleWorkflow([script.command]), provider, stopFile: pidFile,
  });
  expect(before.map((item) => `${item.operationId}#${item.attempt}`)).toEqual([
    'agent.turn#1', 'run.verify#1', 'agent.turn#2',
  ]);
  expect(after[0]).toEqual(before[2]);
  expect(after.map((item) => `${item.operationId}#${item.attempt}`)).toEqual(['agent.turn#2', 'run.verify#2']);
  expect(executionIdsOf([...before, ...after])).toHaveLength(1);
  const saved = JSON.parse(readFileSync(
    path.join(workspace, '.migent', 'sessions', sessionId, 'executions', before[0]!.executionId, 'execution.json'), 'utf8',
  )) as { status: string; verify: { runs: number; red: number; last_result: string } };
  expect(saved).toMatchObject({ status: 'completed', verify: { runs: 2, red: 1, last_result: 'pass' } });
  expect(provider.calls).toHaveLength(3);
});

test('an interrupted verify after a repair resumes as the saved reply and the next verify attempt', async () => {
  vi.stubEnv('MIGENT_DEBUG', '1');
  const root = tempDir('migent-operations-i3-');
  const script = verifyScript(root, [1, 0, 0], [2]);
  const provider = new ScriptedClient([OK, OK], ['# n\n', '# n\n']);
  const { workspace, sessionId, before, after } = await interruptedPair({
    workflow: roleWorkflow([script.command]), provider, stopFile: script.pidFile, release: script.go,
  });
  expect(before.map((item) => `${item.operationId}#${item.attempt}`)).toEqual([
    'agent.turn#1', 'run.verify#1', 'agent.turn#2', 'run.verify#2',
  ]);
  // The saved verify count is already one, so the rerun is the same second attempt, after the saved reply is gated.
  expect(after.map((item) => `${item.operationId}#${item.attempt}`)).toEqual(['reply.gate#2', 'run.verify#2']);
  expect(after[1]).toEqual(before[3]);
  expect(executionIdsOf([...before, ...after])).toHaveLength(1);
  expect(provider.calls).toHaveLength(2);
  const saved = JSON.parse(readFileSync(
    path.join(workspace, '.migent', 'sessions', sessionId, 'executions', before[0]!.executionId, 'execution.json'), 'utf8',
  )) as { status: string; verify: { runs: number; red: number; last_result: string } };
  expect(saved).toMatchObject({ status: 'completed', verify: { runs: 2, red: 1, last_result: 'pass' } });
});

test('an interrupted first verify and an interrupted verify-only run resume with their same full identity', async () => {
  vi.stubEnv('MIGENT_DEBUG', '1');
  const root = tempDir('migent-operations-i4-');
  const script = verifyScript(root, [0], [1]);
  const provider = new ScriptedClient([OK], ['# n\n']);
  const role = await interruptedPair({
    workflow: roleWorkflow([script.command]), provider, stopFile: script.pidFile, release: script.go,
  });
  expect(role.after.map((item) => `${item.operationId}#${item.attempt}`)).toEqual(['reply.gate#1', 'run.verify#1']);
  expect(role.after[1]).toEqual(role.before[1]);
  expect(executionIdsOf([...role.before, ...role.after])).toHaveLength(1);

  const only = tempDir('migent-operations-i5-');
  const onlyScript = verifyScript(only, [0], [1]);
  const pair = await interruptedPair({
    workflow: verifyOnlyWorkflow(onlyScript.command), provider: new ScriptedClient([OK], ['# n\n']),
    stopFile: onlyScript.pidFile, release: onlyScript.go,
  });
  expect(pair.before).toHaveLength(1);
  expect(pair.after[0]).toEqual(pair.before[0]);
  expect(pair.after[0]!.operationId).toBe('run.verify');
  expect(ASSERTED_OPERATIONS).toContain(pair.after[0]!.operationId);
});
