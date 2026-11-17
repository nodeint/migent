/**
 * P1 characterization of issue #158: guarantees of one execution that the operation-runtime refactor must keep.
 * Every assertion here passes on the pre-refactor code and is rerun unchanged afterwards (the baseline is these
 * assertions, not regenerated fixtures). Volatile values (timestamps, pids, durations, temp roots) are never compared.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { BuildCommandInput, CommandSpec } from '@nodeint/migent-kernel';
import { raiseCancellation } from '@nodeint/migent-kernel';
import { createWorkflowSession, SessionStore } from '@nodeint/migent-session';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';

import { AgentToolRunner, executeNamedWorkflow } from '../src/index.ts';
import { registryOf, ScriptedClient, tempDir as createTempDir } from './support.ts';

vi.setConfig({ testTimeout: 60_000 });
afterEach(() => {
  vi.restoreAllMocks();
});

/** A temporary directory removed when the test ends, whether it passed or failed. */
function tempDir(prefix: string): string {
  const directory = createTempDir(prefix);
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return directory;
}

/** The kernel package version, read from its package.json as the diagnostics writer does. */
const KERNEL_VERSION = (createRequire(import.meta.url)('../../kernel/package.json') as { version: string }).version;

const CONFIG = 'agents:\n  fake:\n    client:\n      type: fake\n    model: m1\nroles:\n  developer:\n    agent: fake\n';
const OK = 'status: complete\n\ndone';

/** Provider whose given 1-based calls hang until cancelled. */
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

function workspaceWith(workflow: string): { workspace: string; sessionId: string } {
  const workspace = tempDir('migent-characterize-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), CONFIG, 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'wf.yaml'), workflow, 'utf8');
  return { workspace, sessionId: createWorkflowSession(workspace, 'wf', { task: 'Finish the notes' }) };
}

function roleWorkflow(verify: string[], maxVerify = 3): string {
  const lines = verify.map((item) => `      - ${JSON.stringify(item)}\n`).join('');
  return `id: wf
stages:
  - id: implement
    role: developer
${verify.length > 0 ? `    max_verify: ${maxVerify}\n` : ''}    produces:
      artifact: notes.md
${verify.length > 0 ? `    verify:\n${lines}` : ''}completion:
  stage: implement
`;
}

function executionsDir(workspace: string, sessionId: string): string {
  return path.join(workspace, '.migent', 'sessions', sessionId, 'executions');
}

function onlyExecution(workspace: string, sessionId: string): string {
  const ids = readdirSync(executionsDir(workspace, sessionId));
  expect(ids).toHaveLength(1);
  return path.join(executionsDir(workspace, sessionId), ids[0]!);
}

function json(file: string): Record<string, any> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
}

function eventKinds(workspace: string, sessionId: string): string[] {
  const text = readFileSync(path.join(workspace, '.migent', 'sessions', sessionId, 'events.jsonl'), 'utf8');
  return text.split('\n').filter((line) => line !== '').map((line) => (JSON.parse(line) as { event: string }).event);
}

/** Cancels cooperatively once `pidFile` appears (a process is running), as the existing cancel tests do. */
function cancelWhenRunning(pidFile: string): () => void {
  const timer = setInterval(() => {
    if (!existsSync(pidFile) || readFileSync(pidFile, 'utf8').trim() === '') return;
    clearInterval(timer);
    try {
      raiseCancellation(15);
    } catch {
      // Waiters were woken; the throw is for signal handlers.
    }
  }, 40);
  const stop = (): void => { clearInterval(timer); };
  // The timer is also disposed when the test ends early, so a failure never leaves it running.
  onTestFinished(stop);
  return stop;
}

/** A verify script run by number: exit codes per run, a hold (until `go` exists) for the runs in `hold`. */
interface VerifyScript { command: string; pidFile: string; go: string; runs: () => number }

function verifyScript(root: string, exits: number[], hold: number[] = []): VerifyScript {
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
  return {
    command: `"${process.execPath}" "${script}"`, pidFile, go,
    runs: () => (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0),
  };
}

/** Records the order of the durable writes and events of every execution under the spies. */
function recordWrites(provider?: ScriptedClient): string[] {
  const log: string[] = [];
  if (provider !== undefined) {
    const original = provider.buildCommand.bind(provider);
    vi.spyOn(provider, 'buildCommand').mockImplementation((input: BuildCommandInput) => {
      log.push('invoke');
      return original(input);
    });
  }
  const proto = SessionStore.prototype as unknown as Record<string, (...args: any[]) => unknown>;
  const names = ['save', 'saveExecution', 'saveExecutionProgress', 'saveTurnResponse', 'saveTurnOutcome',
    'saveTurnVerify', 'saveDiagnostics', 'publishVerifyReport', 'recordProviderEvent'];
  for (const name of names) {
    const original = proto[name]!;
    vi.spyOn(proto, name).mockImplementation(function (this: unknown, ...args: any[]) {
      if (name === 'recordProviderEvent') {
        log.push(`event:${(args[1] as { event: string }).event}`);
      } else if (name === 'saveExecutionProgress') log.push(`${name}:${Object.keys(args[2] as object).join(',')}`);
      else log.push(name);
      return original.apply(this, args);
    } as never);
  }
  return log;
}

function runner(provider: ScriptedClient): AgentToolRunner {
  return new AgentToolRunner(registryOf({ fake: provider }), 10);
}

// --- Write order ---

/** Provider whose process exits with the scripted code per call; a non-zero exit with a usable reply is an anomaly. */
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

  override parseRun(stdout: string) {
    void stdout;
    const [text, id] = this.parseResponse();
    return { text, sessionId: id, source: 'model' as const };
  }
}

/** Indices of `steps` as an ordered subsequence of the trace; fails with the whole trace when one is missing. */
function inOrder(log: readonly string[], steps: readonly string[], from = 0): number[] {
  const found: number[] = [];
  let at = from;
  for (const step of steps) {
    const index = log.indexOf(step, at);
    expect(index, `${step} after index ${at} in ${JSON.stringify(log)}`).toBeGreaterThanOrEqual(0);
    found.push(index);
    at = index + 1;
  }
  return found;
}

const indicesOf = (log: readonly string[], step: string): number[] =>
  log.flatMap((item, index) => (item === step ? [index] : []));

test('a correction commits budget, event, history and pending turn before the next provider invocation', async () => {
  const { workspace, sessionId } = workspaceWith(roleWorkflow([]));
  const provider = new ExitCodes([0, 3], ['', OK], [null, '# n\n']);
  const log = recordWrites(provider);
  await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner(provider));
  const invokes = indicesOf(log, 'invoke');
  expect(invokes).toHaveLength(2);
  const [budget, event, history, pending] = inOrder(log, [
    'saveExecutionProgress:corrections', 'event:handoff.file_invalid', 'save',
    'saveExecutionProgress:turn_kind,pending_turn',
  ], invokes[0]);
  // Nothing invokes the provider between the first turn and the end of the correction commit.
  expect(invokes[0]).toBeLessThan(budget!);
  expect(invokes[1]).toBeGreaterThan(pending!);
  expect(history).toBeGreaterThan(event!);
  // The abnormal follow-up turn: its events precede its persistence, and diagnostics follow its turn files.
  inOrder(log, [
    'event:provider.exit_anomaly', 'save', 'saveDiagnostics', 'saveExecution',
  ], invokes[1]);
  // Without a verify command no turn files are written.
  expect(indicesOf(log, 'saveTurnResponse')).toHaveLength(0);
  expect(indicesOf(log, 'saveDiagnostics')).toHaveLength(1);
  expect(provider.calls).toHaveLength(2);
});

test('a clean turn invokes first, writes its turn events before the record save, and ends with the final write', async () => {
  const { workspace, sessionId } = workspaceWith(roleWorkflow([]));
  const provider = new ScriptedClient([OK], ['# n\n']);
  const log = recordWrites(provider);
  await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner(provider));
  inOrder(log, ['invoke', 'event:provider.turn_completed', 'save', 'saveExecution']);
  expect(log.at(-1)).toBe('saveExecution');
  expect(indicesOf(log, 'invoke')).toHaveLength(1);
  expect(indicesOf(log, 'saveDiagnostics')).toHaveLength(0);
});

test('a red verify persists its report and counters, then the repair, before the next provider invocation', async () => {
  const root = tempDir('migent-characterize-v-');
  const script = verifyScript(root, [1, 0]);
  const { workspace, sessionId } = workspaceWith(roleWorkflow([script.command]));
  const provider = new ExitCodes([3, 3], [OK, OK], ['# n\n', '# n\n']);
  const log = recordWrites(provider);
  const result = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner(provider));
  expect(result.code).toBe(0);
  const invokes = indicesOf(log, 'invoke');
  expect(invokes).toHaveLength(2);
  // The abnormal first turn: events, then persistence and turn files, then diagnostics, then verify.
  const first = inOrder(log, [
    'event:provider.exit_anomaly', 'save', 'saveTurnResponse', 'saveTurnOutcome', 'saveDiagnostics',
    'event:verify.started', 'saveTurnVerify', 'event:verify.failed', 'saveExecutionProgress:turns,verify', 'save',
    'saveExecutionProgress:turn_kind,pending_turn',
  ], invokes[0]);
  expect(first.at(-1)).toBeLessThan(invokes[1]!);
  // The abnormal follow-up turn after the repair follows the same boundary and is verified afterwards.
  inOrder(log, [
    'event:provider.exit_anomaly', 'save', 'saveTurnResponse', 'saveTurnOutcome', 'saveDiagnostics',
    'event:verify.started', 'saveTurnVerify', 'event:verify.passed', 'save', 'saveExecution', 'publishVerifyReport',
  ], invokes[1]);
  expect(indicesOf(log, 'saveDiagnostics')).toHaveLength(2);
  expect(script.runs()).toBe(2);
});

// --- Cancellation and resume rows ---

function verifyOnlyWorkflow(command: string): string {
  return `schema_version: 2
id: wf
stages:
  - id: prepare
    description: Check the tree.
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

test('a cancelled verify-only execution continues in place without an agent call', async () => {
  const root = tempDir('migent-characterize-vo-');
  const script = verifyScript(root, [0], [1]);
  const { workspace, sessionId } = workspaceWith(verifyOnlyWorkflow(script.command));
  const provider = new ScriptedClient([OK], ['# n\n']);
  const stop = cancelWhenRunning(script.pidFile);
  const first = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner(provider));
  stop();
  expect(first.stopReason).toBe('cancelled');
  expect(provider.calls).toHaveLength(0);
  const [executionId] = readdirSync(executionsDir(workspace, sessionId));
  const directory = path.join(executionsDir(workspace, sessionId), executionId!);
  expect(json(path.join(directory, 'execution.json'))).toMatchObject({ kind: 'verify', status: 'cancelled', client: null });
  writeFileSync(script.go, '1', 'utf8');
  const second = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId, resetRevisions: true }, runner(provider));
  expect(second.code).toBe(0);
  expect(readdirSync(executionsDir(workspace, sessionId)).filter((id) => id.includes('prepare'))).toEqual([executionId]);
  expect(json(path.join(directory, 'execution.json'))).toMatchObject({ kind: 'verify', status: 'completed' });
  expect(existsSync(path.join(directory, 'turns', '01', 'verify.md'))).toBe(true);
  expect(existsSync(path.join(directory, 'artifacts', 'verify.md'))).toBe(true);
  expect(existsSync(path.join(directory, 'prompt.md'))).toBe(false);
  expect(script.runs()).toBe(2);
  // Turn 1 and a single-run report, as on a fresh verify-only execution.
  expect(readFileSync(path.join(directory, 'turns', '01', 'verify.md'), 'utf8')).toContain('[pass]');
  expect(provider.calls).toHaveLength(1);
});

test('cancel during the repair provider turn resumes the same repair turn with spent budgets unchanged', async () => {
  const root = tempDir('migent-characterize-r-');
  const script = verifyScript(root, [1, 0]);
  const pidFile = path.join(root, 'provider-pid');
  const { workspace, sessionId } = workspaceWith(roleWorkflow([script.command]));
  const provider = new HangOnCalls([2], pidFile, [OK, OK], ['# n\n', '# n\n']);
  const stop = cancelWhenRunning(pidFile);
  const first = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner(provider));
  stop();
  expect(first.stopReason).toBe('cancelled');
  const directory = onlyExecution(workspace, sessionId);
  const before = json(path.join(directory, 'execution.json'));
  expect(before).toMatchObject({ status: 'cancelled', turn_kind: 'repair', pending_turn: 2 });
  expect(before.verify).toMatchObject({ runs: 1, red: 1, last_result: 'fail' });
  const conversation = json(path.join(directory, 'conversation.json')) as { history: { role: string; content: string }[] };
  expect(conversation.history.map((item) => item.role)).toEqual(['user', 'assistant', 'user']);
  const repairPrompt = provider.calls[1]!.prompt;
  expect(provider.calls).toHaveLength(2);

  const second = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId, resetRevisions: true }, runner(provider));
  expect(second.code).toBe(0);
  expect(provider.calls).toHaveLength(3);
  // The resent repair carries the same pending repair message as the interrupted one.
  expect(provider.calls[2]!.prompt).toContain('Verify failed');
  expect(repairPrompt).toContain('Verify failed');
  expect(script.runs()).toBe(2);
  const after = json(path.join(directory, 'execution.json'));
  expect(after).toMatchObject({ status: 'completed', turn_kind: 'repair' });
  expect(after.verify).toMatchObject({ runs: 2, red: 1, last_result: 'pass' });
  expect(readdirSync(executionsDir(workspace, sessionId))).toHaveLength(1);
});

test('cancel during the verify that follows a repair reruns it without a new provider turn', async () => {
  const root = tempDir('migent-characterize-rv-');
  const script = verifyScript(root, [1, 0, 0], [2]);
  const { workspace, sessionId } = workspaceWith(roleWorkflow([script.command]));
  const provider = new ScriptedClient([OK, OK], ['# n\n', '# n\n']);
  const stop = cancelWhenRunning(script.pidFile);
  const first = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner(provider));
  stop();
  expect(first.stopReason).toBe('cancelled');
  expect(provider.calls).toHaveLength(2);
  const directory = onlyExecution(workspace, sessionId);
  const before = json(path.join(directory, 'execution.json'));
  expect(before).toMatchObject({ status: 'cancelled', turn_kind: 'repair', pending_turn: 2 });
  expect(before.verify).toMatchObject({ runs: 1, red: 1 });
  const conversation = json(path.join(directory, 'conversation.json')) as { history: { role: string }[] };
  expect(conversation.history.map((item) => item.role)).toEqual(['user', 'assistant', 'user', 'assistant']);

  writeFileSync(script.go, '1', 'utf8');
  const second = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId, resetRevisions: true }, runner(provider));
  expect(second.code).toBe(0);
  expect(provider.calls).toHaveLength(2);
  expect(script.runs()).toBe(3);
  const after = json(path.join(directory, 'execution.json'));
  expect(after).toMatchObject({ status: 'completed' });
  expect(after.verify).toMatchObject({ runs: 2, red: 1, last_result: 'pass' });
  expect(readdirSync(executionsDir(workspace, sessionId))).toHaveLength(1);
});

test('an execution left running without a cancellation is not reopened by continue', async () => {
  const root = tempDir('migent-characterize-run-');
  const pidFile = path.join(root, 'pid');
  const { workspace, sessionId } = workspaceWith(roleWorkflow([]));
  const provider = new HangOnCalls([1], pidFile, [OK], ['# n\n']);
  const stop = cancelWhenRunning(pidFile);
  await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner(provider));
  stop();
  const directory = onlyExecution(workspace, sessionId);
  const file = path.join(directory, 'execution.json');
  // Simulate a process death: the record says running and nothing reconciles it.
  writeFileSync(file, JSON.stringify({ ...json(file), status: 'running' }), 'utf8');
  const sessionFile = path.join(workspace, '.migent', 'sessions', sessionId, 'status.json');
  const status = json(sessionFile);
  writeFileSync(sessionFile, JSON.stringify({ ...status, status: 'active' }), 'utf8');
  const callsBefore = provider.calls.length;
  let outcome: string;
  try {
    const result = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId, resetRevisions: true }, runner(provider));
    outcome = `returned:${result.stopReason}`;
  } catch (error) {
    outcome = `threw:${(error as Error).message}`;
  }
  // Recorded behavior: the stale running execution stays running and is never resumed in place.
  // Recorded behavior (design D12): the orphan reaper fails the stale execution; it is never resumed in place,
  // never calls the agent, and starts no second execution. Crash recovery stays out of scope.
  expect(outcome).toBe('returned:stage_failed');
  expect(json(file)).toMatchObject({ status: 'failed', error: expect.stringContaining('Owner process is not running') });
  expect(provider.calls.length - callsBefore).toBe(0);
  expect(readdirSync(executionsDir(workspace, sessionId))).toHaveLength(1);
});

// --- Baseline artifact comparison (committed snapshots, recorded before the refactor) ---

const VOLATILE = new Set(['created_at', 'completed_at', 'timestamp', 'owner_pid', 'provider_pid', 'provider_endpoint', 'hostname',
  'duration_ms', 'duration_sec', 'elapsed_seconds', 'started_at', 'updated_at', 'ts', 'hash', 'endpoint']);

interface MaskedRoot { root: string; label: string }

/** A root as it can appear in text: native, with forward slashes, or as an escaped backslash path. */
function rootVariants(root: string): string[] {
  return [...new Set([root, root.replaceAll('\\', '/'), root.replaceAll('\\', '\\\\')])];
}

/** Masks every root (longest first), then folds the separators of the path that follows to a single `/`. */
function maskRoots(text: string, roots: readonly MaskedRoot[]): string {
  let masked = text;
  const variants = roots.flatMap((item) => rootVariants(item.root).map((root) => ({ root, label: item.label })))
    .sort((a, b) => b.root.length - a.root.length);
  for (const { root, label } of variants) masked = masked.split(root).join(label);
  const labels = [...new Set(roots.map((item) => item.label))].map((label) => label.replace(/[<>]/g, '\\$&')).join('|');
  const tail = new RegExp(`(${labels})([\\\\/][^\\s"')]*)`, 'g');
  return masked.replace(tail, (_all, label: string, rest: string) => `${label}${rest.replace(/[\\/]+/g, '/')}`);
}

/** Stable view of a JSON value: volatile keys dropped, temp roots and timestamps masked. */
function normalize(value: unknown, roots: readonly MaskedRoot[]): unknown {
  if (typeof value === 'string') {
    return maskRoots(value, roots)
      .replace(/\d{4}-\d\d-\d\dT[\d:.]+(\+00:00|Z)/g, '<time>').replace(/\b\d+(\.\d+)?s\b/g, '<n>s')
      .replace(/\(\d+ ?ms\)/g, '(<ms>)');
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, roots));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !VOLATILE.has(key)).map(([key, item]) => [key, normalize(item, roots)]));
  }
  return value;
}

/**
 * Diagnostics fields that come from the machine, not the behavior. Each is checked against its runtime source
 * (so a wrong value still fails), then replaced by a marker so the snapshot holds on any platform, temp root,
 * architecture, Node patch or package version. Field presence stays pinned.
 */
function environmentMarkers(raw: unknown): Record<string, unknown> {
  const record = { ...(raw as Record<string, unknown>) };
  const checks: [string, unknown, string][] = [
    ['endpoint_length', typeof record.endpoint === 'string' ? Buffer.byteLength(record.endpoint) : null, '<endpoint-length>'],
    ['node_version', process.version, '<node-version>'],
    ['platform', process.platform, '<platform>'],
    ['arch', process.arch, '<arch>'],
    ['migent_version', KERNEL_VERSION, '<migent-version>'],
  ];
  for (const [key, expected, marker] of checks) {
    expect(record, `${key} present`).toHaveProperty(key);
    expect(record[key], key).toBe(expected);
    record[key] = marker;
  }
  return record;
}

function files(directory: string, base = directory): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, name.name);
    const relative = path.relative(base, full).split(path.sep).join('/');
    if (name.isDirectory()) Object.assign(out, files(full, base));
    else if (['stream.jsonl', 'debug.log', 'process.json'].includes(name.name) || name.name.endsWith('.sock')) out[relative] = '<volatile file present>';
    else if (name.name === 'diagnostics.json') out[relative] = environmentMarkers(JSON.parse(readFileSync(full, 'utf8')));
    else if (name.name.endsWith('.json')) out[relative] = JSON.parse(readFileSync(full, 'utf8'));
    else out[relative] = readFileSync(full, 'utf8');
  }
  return out;
}

/** `scriptRoots` are the helper-script directories of the run; their paths are masked as `<tmp>`. */
function sessionView(
  workspace: string,
  sessionId: string,
  result: Record<string, unknown>,
  scriptRoots: readonly string[] = [],
): unknown {
  const root = path.join(workspace, '.migent', 'sessions', sessionId);
  const events = readFileSync(path.join(root, 'events.jsonl'), 'utf8').split('\n').filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const executions: Record<string, unknown> = {};
  for (const id of readdirSync(path.join(root, 'executions')).sort()) executions[id] = files(path.join(root, 'executions', id));
  const roots: MaskedRoot[] = [
    { root: workspace, label: '<ws>' }, { root: process.execPath, label: '<node>' },
    ...scriptRoots.map((item) => ({ root: item, label: '<tmp>' })),
  ];
  // A root can also surface as its realpath (e.g. /tmp -> /private/tmp on macOS).
  const real = roots.map((item) => ({ root: realpathSync(item.root), label: item.label }));
  return normalize({ result, events, executions }, [...roots, ...real]);
}

function publicResult(result: Record<string, unknown>): Record<string, unknown> {
  const { code, status, stopReason, latestExecutionId } = result;
  return { code, status, stopReason, latestExecutionId };
}

test('baseline: role execution with correction, red verify, repair and pass', async () => {
  const root = tempDir('migent-characterize-b1-');
  const script = verifyScript(root, [1, 0]);
  const { workspace, sessionId } = workspaceWith(roleWorkflow([script.command]));
  const provider = new ScriptedClient(['', OK, OK], [null, '# n\n', '# n\n']);
  const result = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner(provider));
  expect(result.code).toBe(0);
  expect(provider.calls).toHaveLength(3);
  expect(sessionView(workspace, sessionId, publicResult(result as never), [root])).toMatchSnapshot();
});

test('baseline: role execution that exhausts its verify budget', async () => {
  const root = tempDir('migent-characterize-b2-');
  const script = verifyScript(root, [1, 1]);
  const { workspace, sessionId } = workspaceWith(roleWorkflow([script.command], 2));
  const provider = new ScriptedClient([OK, OK], ['# n\n', '# n\n']);
  const result = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner(provider));
  expect(result.code).not.toBe(0);
  expect(sessionView(workspace, sessionId, publicResult(result as never), [root])).toMatchSnapshot();
});

test('baseline: verify-only pass and red executions', async () => {
  const passRoot = tempDir('migent-characterize-b3-');
  const pass = verifyScript(passRoot, [0]);
  const first = workspaceWith(verifyOnlyWorkflow(pass.command));
  const passed = await executeNamedWorkflow(first.workspace, { workflowId: 'wf', sessionId: first.sessionId }, runner(new ScriptedClient([OK], ['# n\n'])));
  expect(passed.code).toBe(0);
  expect(sessionView(first.workspace, first.sessionId, publicResult(passed as never), [passRoot])).toMatchSnapshot('pass');

  const redRoot = tempDir('migent-characterize-b4-');
  const red = verifyScript(redRoot, [1]);
  const second = workspaceWith(verifyOnlyWorkflow(red.command));
  const failed = await executeNamedWorkflow(second.workspace, { workflowId: 'wf', sessionId: second.sessionId }, runner(new ScriptedClient([OK], ['# n\n'])));
  expect(failed.code).toBe(7);
  expect(sessionView(second.workspace, second.sessionId, publicResult(failed as never), [redRoot])).toMatchSnapshot('red');
});

// --- Remaining resume rows ---

test('a final execution stays terminal: continue starts no agent call and rewrites nothing', async () => {
  const { workspace, sessionId } = workspaceWith(roleWorkflow([]));
  const provider = new ScriptedClient([OK], ['# n\n']);
  const first = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner(provider));
  expect(first.code).toBe(0);
  const directory = onlyExecution(workspace, sessionId);
  const before = JSON.stringify(files(directory, directory));
  const events = eventKinds(workspace, sessionId).length;
  await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId, resetRevisions: true }, runner(provider)).catch(() => null);
  expect(provider.calls).toHaveLength(1);
  expect(readdirSync(executionsDir(workspace, sessionId))).toHaveLength(1);
  expect(JSON.stringify(files(directory, directory))).toBe(before);
  expect(eventKinds(workspace, sessionId).length).toBe(events);
});

test('a saved-reply continuation does not rewrite diagnostics of the abnormal turn it resumes after', async () => {
  const root = tempDir('migent-characterize-sd-');
  const script = verifyScript(root, [0], [1]);
  const { workspace, sessionId } = workspaceWith(roleWorkflow([script.command]));
  const provider = new ExitCodes([3], [OK], ['# n\n']);
  const stop = cancelWhenRunning(script.pidFile);
  const first = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner(provider));
  stop();
  expect(first.stopReason).toBe('cancelled');
  const directory = onlyExecution(workspace, sessionId);
  const diagnosticsFile = path.join(directory, 'diagnostics.json');
  expect(existsSync(diagnosticsFile)).toBe(true);
  const before = readFileSync(diagnosticsFile, 'utf8');
  writeFileSync(script.go, '1', 'utf8');
  const second = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId, resetRevisions: true }, runner(provider));
  expect(second.code).toBe(0);
  expect(provider.calls).toHaveLength(1);
  expect(readFileSync(diagnosticsFile, 'utf8')).toBe(before);
});

test('baseline: abnormal turns with diagnostics, red verify and repair', async () => {
  const root = tempDir('migent-characterize-b5-');
  const script = verifyScript(root, [1, 0]);
  const { workspace, sessionId } = workspaceWith(roleWorkflow([script.command]));
  const provider = new ExitCodes([3, 3], [OK, OK], ['# n\n', '# n\n']);
  const result = await executeNamedWorkflow(workspace, { workflowId: 'wf', sessionId }, runner(provider));
  expect(result.code).toBe(0);
  const view = sessionView(workspace, sessionId, publicResult(result as never), [root]);
  expect(JSON.stringify(view)).toContain('diagnostics.json');
  expect(view).toMatchSnapshot();
});

test('normalization masks Windows-shaped roots, escaped serializations and separators, keeping file identity', () => {
  const workspace = 'C:\\Users\\runner\\AppData\\Local\\Temp\\migent-characterize-abc123';
  const scripts = 'C:\\Users\\runner\\AppData\\Local\\Temp\\migent-characterize-b1-xyz789';
  const node = 'C:\\hostedtoolcache\\windows\\node\\24.0.0\\x64\\node.exe';
  const roots = [
    { root: workspace, label: '<ws>' }, { root: node, label: '<node>' }, { root: scripts, label: '<tmp>' },
  ];
  const view = normalize({
    command: `"${node}" "${scripts}\\verify.cjs"`,
    serialized: JSON.stringify({ file: `${workspace}\\.migent\\sessions\\1\\executions\\0001-a\\handoff.json` }),
    forward: `${scripts.replaceAll('\\', '/')}/verify.cjs failed`,
  }, roots);
  expect(view).toEqual({
    command: '"<node>" "<tmp>/verify.cjs"',
    serialized: '{"file":"<ws>/.migent/sessions/1/executions/0001-a/handoff.json"}',
    forward: '<tmp>/verify.cjs failed',
  });
  // A POSIX root normalizes to the same labels, so snapshots agree across platforms.
  const posix = normalize({ command: '"/usr/bin/node" "/tmp/migent-x-1/verify.cjs"' }, [
    { root: '/usr/bin/node', label: '<node>' }, { root: '/tmp/migent-x-1', label: '<tmp>' },
  ]);
  expect(posix).toEqual({ command: '"<node>" "<tmp>/verify.cjs"' });
});

test('environment markers check each machine-derived field against its runtime source', () => {
  const good = {
    endpoint: '/tmp/x.sock', endpoint_length: 11, node_version: process.version, platform: process.platform,
    arch: process.arch, migent_version: KERNEL_VERSION, stable: 'kept',
  };
  expect(environmentMarkers(good)).toEqual({
    endpoint: '/tmp/x.sock', endpoint_length: '<endpoint-length>', node_version: '<node-version>',
    platform: '<platform>', arch: '<arch>', migent_version: '<migent-version>', stable: 'kept',
  });
  // A wrong value or a missing field is not masked: it fails.
  expect(() => environmentMarkers({ ...good, endpoint_length: 12 })).toThrow();
  expect(() => environmentMarkers({ ...good, platform: 'plan9' })).toThrow();
  const { arch: omitted, ...missing } = good;
  void omitted;
  expect(() => environmentMarkers(missing)).toThrow();
});
