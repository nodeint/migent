import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Plugin, PluginHandler } from '@nodeint/migent-contracts';
import { AgentToolRunner } from '@nodeint/migent-engine';
import { raiseCancellation, resetCancellation, utcNow } from '@nodeint/migent-kernel';
import { createPluginRegistry, metricsPlugin } from '@nodeint/migent-plugins';
import { sessionEventLog } from '@nodeint/migent-session';
import { afterEach, expect, test } from 'vitest';

import { cliHooks } from '../src/hooks.ts';
import { main } from '../src/index.ts';
import { cleanWorkspaces, stoppedSession, workspaces } from './complete-fixtures.ts';
import { capture, registryOf, ScriptedClient, writeFakeWorkflowWorkspace } from './support.ts';

afterEach(() => {
  cliHooks.runner = null;
  resetCancellation();
  cleanWorkspaces();
});

const TWO_STAGES = 'schema_version: 8\nid: wf\nstages:\n  - { id: one, role: planner }\n  - { id: two, role: planner, depends_on: [one] }\n';
const METRICS = (directory: string): string => path.join(directory, 'plugins', 'metrics', 'metrics.json');

/** Installs the metrics plugin with its handler replaced, keeping its manifest and default `ignore` policy. */
function installHandler(handler: PluginHandler, timeoutSec?: number): void {
  const { manifest } = metricsPlugin;
  const wrapped: Plugin = {
    manifest: timeoutSec === undefined
      ? manifest
      : { ...manifest, defaults: { ...manifest.defaults, timeout_sec: timeoutSec } },
    activate: (_options, migent) => { migent.events.on('session.completed', handler); },
  };
  const runner = new AgentToolRunner(registryOf({}), 10);
  runner.pluginRegistry = createPluginRegistry([wrapped]);
  cliHooks.runner = runner;
}

function installReal(): void {
  const runner = new AgentToolRunner(registryOf({}), 10);
  runner.pluginRegistry = createPluginRegistry();
  cliHooks.runner = runner;
}

interface Logged { event: string; data: Record<string, unknown> }
const events = (directory: string): Logged[] =>
  readFileSync(path.join(directory, 'events.jsonl'), 'utf8').split('\n').filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Logged);
const failures = (directory: string): string[] =>
  events(directory).filter((entry) => entry.event === 'plugin.failed').map((entry) => String(entry.data.reason));

/** The completion still succeeds, the plugin failure is recorded, and nothing holds the session. */
function expectCompletedWithoutHold(directory: string, reason: string): void {
  const status = JSON.parse(readFileSync(path.join(directory, 'status.json'), 'utf8')) as Record<string, unknown>;
  expect(status.status).toBe('completed');
  expect(status.plugin_holds ?? []).toEqual([]);
  expect(failures(directory)).toEqual([reason]);
  expect(events(directory).find((entry) => entry.event === 'plugin.failed')?.data).toMatchObject({ on_error: 'ignore' });
}

test('a handler timeout leaves the session completed with plugin.failed and no hold', async () => {
  const { workspace, sessionId, directory } = stoppedSession();
  installHandler(() => new Promise(() => undefined), 0.05);
  const result = await capture(() => main(['session', 'complete', sessionId, '--json'], workspace));
  expect(result.value).toBe(0);
  expectCompletedWithoutHold(directory, 'timeout');
  expect(existsSync(METRICS(directory))).toBe(false);
});

test('a cancelled completion leaves the session completed with plugin.failed and no hold', async () => {
  const { workspace, sessionId, directory } = stoppedSession();
  installHandler(async () => {
    await Promise.resolve();
    try { raiseCancellation(2); } catch { /* the flag stays set */ }
    return new Promise(() => undefined);
  });
  const result = await capture(() => main(['session', 'complete', sessionId, '--json'], workspace));
  expect(result.value).toBe(0);
  expectCompletedWithoutHold(directory, 'cancelled');
  expect(existsSync(METRICS(directory))).toBe(false);
});

test('a snapshot that changes twice re-runs once, records stale, and writes nothing', async () => {
  const { workspace, sessionId, directory } = stoppedSession();
  let runs = 0;
  installHandler(async (_input, call) => {
    runs += 1;
    await call.session.snapshot();
    sessionEventLog.record(directory, { event: 'baseline.captured', timestamp: utcNow(), data: { commit: null, error: null } });
    return [call.artifacts.propose('metrics.json', '{}')];
  });
  const result = await capture(() => main(['session', 'complete', sessionId, '--json'], workspace));
  expect(result.value).toBe(0);
  expect(runs).toBe(2);
  expectCompletedWithoutHold(directory, 'stale');
  expect(existsSync(METRICS(directory))).toBe(false);
});

test.each([
  ['an existing valid file', '{"session_id":"kept"}'],
  ['an existing corrupt file', 'not-json'],
])('%s is rejected as exists, its bytes are kept, and the session completes', async (_name, bytes) => {
  const { workspace, sessionId, directory } = stoppedSession();
  mkdirSync(path.dirname(METRICS(directory)), { recursive: true });
  writeFileSync(METRICS(directory), bytes);
  installReal();
  const result = await capture(() => main(['session', 'complete', sessionId, '--json'], workspace));
  expect(result.value).toBe(0);
  expect(readFileSync(METRICS(directory), 'utf8')).toBe(bytes);
  const decision = events(directory).find((entry) => entry.event === 'plugin.decision');
  expect(decision?.data.results).toMatchObject([{ kind: 'artifact', status: 'rejected', reason: 'exists' }]);
  const status = JSON.parse(readFileSync(path.join(directory, 'status.json'), 'utf8')) as Record<string, unknown>;
  expect(status.status).toBe('completed');
  expect(status.plugin_holds ?? []).toEqual([]);
});

test('a write that cannot happen leaves the session completed with plugin.failed and no hold', async () => {
  const { workspace, sessionId, directory } = stoppedSession();
  writeFileSync(path.join(directory, 'plugins'), 'a file where the directory must go');
  installReal();
  const result = await capture(() => main(['session', 'complete', sessionId, '--json'], workspace));
  expect(result.value).toBe(0);
  const status = JSON.parse(readFileSync(path.join(directory, 'status.json'), 'utf8')) as Record<string, unknown>;
  expect(status.status).toBe('completed');
  expect(status.plugin_holds ?? []).toEqual([]);
  expectCompletedWithoutHold(directory, 'error');
  expect(readFileSync(path.join(directory, 'plugins'), 'utf8')).toBe('a file where the directory must go');
  expect(existsSync(METRICS(directory))).toBe(false);
});

const metricsCli = (workspace: string, ...args: string[]) => capture(() => main(['session', 'metrics', ...args], workspace));
const pluginEvents = (directory: string): string[] =>
  events(directory).map((entry) => entry.event).filter((kind) => kind.startsWith('plugin'));

test('plugins.metrics.enabled false writes no metrics and session metrics says so', async () => {
  const { workspace, sessionId, directory } = stoppedSession();
  appendFileSync(path.join(workspace, '.migent', 'config.yaml'), '\nplugins:\n  metrics:\n    enabled: false\n');
  installReal();
  expect((await capture(() => main(['session', 'complete', sessionId, '--json'], workspace))).value).toBe(0);
  expect(existsSync(METRICS(directory))).toBe(false);
  const read = await metricsCli(workspace, sessionId, '--json');
  expect(read.value).toBe(2);
  expect(read.stderr).toContain(`No metrics for session: ${sessionId}`);
});

test('a session frozen before the plugin existed completes with the metrics plugin running implicitly', async () => {
  const { workspace, sessionId, directory } = stoppedSession();
  // The fixture's freeze carries no plugins section and no plugins.frozen event, as an old session does.
  expect(events(directory).some((entry) => entry.event === 'plugins.frozen')).toBe(false);
  installReal();
  expect((await capture(() => main(['session', 'complete', sessionId, '--json'], workspace))).value).toBe(0);
  expect(existsSync(METRICS(directory))).toBe(true);
  const shown = JSON.parse((await capture(() => main(['session', 'show', sessionId, '--json'], workspace))).stdout);
  expect(shown.plugins.active).toMatchObject([{ id: 'metrics', source: 'implicit' }, { id: 'next', source: 'implicit' }, { id: 'prompt_cache_ttl', source: 'implicit' }]);
  expect(JSON.parse((await metricsCli(workspace, sessionId, '--json')).stdout)).toMatchObject({ session_id: sessionId });
});

test('continuing a session frozen before the plugin existed completes it with the metrics plugin running implicitly', async () => {
  const workspace = writeFakeWorkflowWorkspace({ wf: TWO_STAGES });
  workspaces.push(workspace);
  // A runner with no plugin registry freezes no plugins, as a session started before registration.
  const old = new AgentToolRunner(registryOf({ fake: new ScriptedClient(['status: complete\n\nDone']) }), 10);
  cliHooks.runner = old;
  expect((await capture(() => main(['session', 'run', '--workflow', 'wf', '--task', 'T', '--max-dispatches', '1'], workspace))).value).toBe(5);
  const sessionId = readdirSync(path.join(workspace, '.migent', 'sessions')).find((name) => /^\d+$/.test(name)) ?? '';
  const directory = path.join(workspace, '.migent', 'sessions', sessionId);
  expect(events(directory).some((entry) => entry.event === 'plugins.frozen')).toBe(false);
  const next = new AgentToolRunner(registryOf({ fake: new ScriptedClient(['status: complete\n\nDone']) }), 10);
  next.pluginRegistry = createPluginRegistry();
  cliHooks.runner = next;
  expect((await capture(() => main(['session', 'continue', sessionId], workspace))).value).toBe(0);
  const status = JSON.parse(readFileSync(path.join(directory, 'status.json'), 'utf8')) as Record<string, unknown>;
  expect(status.status).toBe('completed');
  expect(existsSync(METRICS(directory))).toBe(true);
  cliHooks.runner = next;
  expect(JSON.parse((await metricsCli(workspace, sessionId, '--json')).stdout)).toMatchObject({ session_id: sessionId });
  cliHooks.runner = next;
  const shown = JSON.parse((await capture(() => main(['session', 'show', sessionId, '--json'], workspace))).stdout);
  expect(shown.plugins.active).toMatchObject([{ id: 'metrics', source: 'implicit' }, { id: 'next', source: 'implicit' }, { id: 'prompt_cache_ttl', source: 'implicit' }]);
});

test('a session with no freeze file completes with no metrics and no plugin events', async () => {
  const { workspace, sessionId, directory } = stoppedSession();
  rmSync(path.join(directory, 'workflow.frozen.yaml'));
  installReal();
  const before = pluginEvents(directory);
  const result = await capture(() => main(['session', 'complete', sessionId, '--json'], workspace));
  expect(result.value).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: 'completed' });
  expect(existsSync(METRICS(directory))).toBe(false);
  expect(pluginEvents(directory)).toEqual(before);
});

test('an unrecorded complete metrics file is still read and session show lists it as unrecorded', async () => {
  const { workspace, sessionId, directory } = stoppedSession();
  installReal();
  await capture(() => main(['session', 'complete', sessionId, '--json'], workspace));
  const document = readFileSync(METRICS(directory), 'utf8');
  // Drop the plugin records: the file is complete on disk, but no event names it.
  const kept = readFileSync(path.join(directory, 'events.jsonl'), 'utf8').split('\n')
    .filter((line) => !line.includes('"plugin.decision"') && !line.includes('"plugin.hook_invoked"')).join('\n');
  writeFileSync(path.join(directory, 'events.jsonl'), kept);
  const read = await metricsCli(workspace, sessionId, '--json');
  expect(read.value).toBe(0);
  expect(JSON.parse(read.stdout)).toEqual(JSON.parse(document));
  const shown = JSON.parse((await capture(() => main(['session', 'show', sessionId, '--json'], workspace))).stdout);
  expect(JSON.stringify(shown.plugins.unrecorded)).toContain('metrics.json');
});

test('a frozen metrics version change completes with the warning, an unchanged payload and no metrics', async () => {
  const workspace = writeFakeWorkflowWorkspace({ wf: TWO_STAGES });
  workspaces.push(workspace);
  const runner = new AgentToolRunner(registryOf({ fake: new ScriptedClient(['status: complete\n\nDone']) }), 10);
  runner.pluginRegistry = createPluginRegistry();
  cliHooks.runner = runner;
  expect((await capture(() => main(['session', 'run', '--workflow', 'wf', '--task', 'T', '--max-dispatches', '1'], workspace))).value).toBe(5);
  const sessionId = readdirSync(path.join(workspace, '.migent', 'sessions')).find((name) => /^\d+$/.test(name)) ?? '';
  const directory = path.join(workspace, '.migent', 'sessions', sessionId);
  const bumped = { ...metricsPlugin, manifest: { ...metricsPlugin.manifest, version: '1.0.1' } };
  runner.pluginRegistry = createPluginRegistry([bumped]);
  cliHooks.runner = runner;
  const base = await capture(() => main(['session', 'complete', sessionId, '--json'], workspace));
  expect(base.value).toBe(0);
  expect(base.stdout.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(base.stdout)).toMatchObject({ session_id: sessionId, status: 'completed', already_completed: false });
  expect(base.stderr).toMatch(/warning: plugins not run:.*metrics.*version/s);
  expect(existsSync(METRICS(directory))).toBe(false);
  expect(failures(directory)).toEqual([]);
});
