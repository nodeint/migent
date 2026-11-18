/** #150 P7: the `plugins` section of `session show`, and `session follow` streaming `plugin.*` records. */
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Plugin, PluginHandler, PluginHook, PluginRegistry, PluginUses, TSchema } from '@nodeint/migent-contracts';
import { AgentToolRunner } from '@nodeint/migent-engine';
import { expect, test } from 'vitest';

import { cliHooks } from '../src/hooks.ts';
import { main } from '../src/index.ts';
import { capture, FAKE_FLOW_CONFIG, registryOf, removeWorkspace, ScriptedClient, writeFakeWorkflowWorkspace } from './support.ts';

const WORKFLOW = 'schema_version: 7\nid: wf\nstages:\n  - { id: one, role: planner }\n';
const OK = 'status: complete\n\nDone';
const schema = { type: 'object' } as unknown as TSchema;

const NO_USES: PluginUses = { operations: [], events: [], session: [], artifacts: [], agents: false, config: [] };

const plugin = (id: string, handlers: Partial<Record<PluginHook, PluginHandler>>): Plugin => ({
  manifest: {
    id, version: '1.2.3', apiVersion: { major: 1, minor: 0 }, advisory: false, configSchema: schema,
    uses: { ...NO_USES, events: Object.keys(handlers) as PluginHook[], artifacts: [{ name: 'report.md', mode: 'replace', media_type: 'text/markdown' }] },
  },
  activate: (_options, migent) => {
    for (const [hook, handler] of Object.entries(handlers)) migent.events.on(hook as PluginHook, handler);
  },
});
const registryOfPlugins = (...plugins: Plugin[]): PluginRegistry => ({
  ids: () => plugins.map((entry) => entry.manifest.id),
  get: (id) => plugins.find((entry) => entry.manifest.id === id),
});

function setup(plugins: Plugin[], entryBody = ''): { root: string; runner: AgentToolRunner } {
  const root = writeFakeWorkflowWorkspace({ wf: WORKFLOW });
  const section = plugins.map((entry) => `  ${entry.manifest.id}:\n    enabled: true\n${entryBody}`).join('');
  writeFileSync(path.join(root, '.migent', 'config.yaml'), `${FAKE_FLOW_CONFIG}plugins:\n${section}`, 'utf8');
  const runner = new AgentToolRunner(registryOf({ fake: new ScriptedClient([OK, OK]) }), 10);
  runner.pluginRegistry = registryOfPlugins(...plugins);
  return { root, runner };
}

function cli(run: { root: string; runner: AgentToolRunner }, ...args: string[]) {
  return capture(() => { cliHooks.runner = run.runner; return main(args, run.root); });
}
const sessionDir = (root: string): string => path.join(root, '.migent/sessions', readdirSync(path.join(root, '.migent/sessions'))[0] ?? '');
const showJson = async (run: { root: string; runner: AgentToolRunner }) => {
  const shown = await cli(run, 'session', 'show', path.basename(sessionDir(run.root)), '--json');
  return JSON.parse(shown.stdout) as { plugins?: Record<string, unknown> };
};

const reporter = plugin('demo', {
  'execution.finished': () => Promise.resolve([{ kind: 'artifact' as const, name: 'report.md', content: 'hi' }]),
});

test('a successful invocation lists the active set, the output and the result', async () => {
  const run = setup([reporter]);
  try {
    expect((await cli(run, 'session', 'run', '--workflow', 'wf', '--task', 'Task')).value).toBe(0);
    const { plugins } = await showJson(run);
    expect(plugins).toMatchObject({
      active: [{ id: 'demo', version: '1.2.3', enabled: true, advisory: false }],
      invocations: [{ plugin: 'demo', hook: 'execution.finished', status: 'succeeded', results: [{ kind: 'artifact', status: 'applied', path: 'plugins/demo/report.md' }] }],
      added_after_freeze: [], holds: [], freeze_mismatch: null,
    });
    const text = await cli(run, 'session', 'show', path.basename(sessionDir(run.root)));
    expect(text.stdout).toContain('plugins  demo@1.2.3');
    expect(text.stdout).toContain('plugin  demo execution.finished · succeeded · artifact applied plugins/demo/report.md');
  } finally { cliHooks.runner = null; removeWorkspace(run.root); }
}, 30_000);

test('a failed invocation under on_error stop shows the failure and the unresolved hold', async () => {
  const failing = plugin('demo', { 'execution.finished': () => Promise.reject(new Error('boom')) });
  const run = setup([failing], '    on_error: stop\n');
  try {
    await cli(run, 'session', 'run', '--workflow', 'wf', '--task', 'Task');
    const { plugins } = await showJson(run);
    expect(plugins).toMatchObject({
      invocations: [{ status: 'failed', failure: { reason: 'error', on_error: 'stop', error: expect.stringContaining('boom') } }],
      holds: [{ plugin: 'demo', hook: 'execution.finished', on_error: 'stop' }],
    });
    const text = await cli(run, 'session', 'show', path.basename(sessionDir(run.root)));
    expect(text.stdout).toContain('plugin  demo execution.finished · failed · error (on_error stop)');
    expect(text.stdout).toContain('plugin_hold  demo (execution.finished) · on_error stop');
  } finally { cliHooks.runner = null; removeWorkspace(run.root); }
}, 30_000);

test('a hook_invoked record with no result shows interrupted', async () => {
  const run = setup([reporter]);
  try {
    await cli(run, 'session', 'run', '--workflow', 'wf', '--task', 'Task');
    appendFileSync(path.join(sessionDir(run.root), 'events.jsonl'), `${JSON.stringify({
      v: 2, seq: 9999, event: 'plugin.hook_invoked', timestamp: '2026-01-01T00:00:00+00:00',
      data: { plugin: 'demo', version: '1.2.3', hook: 'session.stopped', trigger_seq: null, invocation_id: 'crashed', advisory: false },
    })}\n`);
    const { plugins } = await showJson(run);
    expect(plugins?.invocations).toMatchObject([{ status: 'succeeded' }, { invocation_id: 'crashed', hook: 'session.stopped', status: 'interrupted' }]);
    const text = await cli(run, 'session', 'show', path.basename(sessionDir(run.root)));
    expect(text.stdout).toContain('plugin  demo session.stopped · interrupted');
  } finally { cliHooks.runner = null; removeWorkspace(run.root); }
}, 30_000);

test('an edited freeze shows the mismatch, and a new unregistered id shows addedAfterFreeze', async () => {
  const run = setup([reporter]);
  try {
    await cli(run, 'session', 'run', '--workflow', 'wf', '--task', 'Task');
    appendFileSync(path.join(run.root, '.migent', 'config.yaml'), '  newcomer:\n    enabled: true\n');
    expect((await showJson(run)).plugins).toMatchObject({ added_after_freeze: ['newcomer'], freeze_mismatch: null });
    appendFileSync(path.join(sessionDir(run.root), 'workflow.frozen.yaml'), '# edited\n');
    const { plugins } = await showJson(run);
    expect(plugins?.freeze_mismatch).toContain('does not match the recorded plugins.frozen');
    const text = await cli(run, 'session', 'show', path.basename(sessionDir(run.root)));
    expect(text.stdout).toContain('plugin_freeze_mismatch  ');
  } finally { cliHooks.runner = null; removeWorkspace(run.root); }
}, 30_000);

test('session follow --cursor 0 replays plugin.* records, as text and as JSON lines', async () => {
  const run = setup([reporter]);
  try {
    await cli(run, 'session', 'run', '--workflow', 'wf', '--task', 'Task');
    const id = path.basename(sessionDir(run.root));
    const text = await cli(run, 'session', 'follow', id, '--cursor', '0', '--exit-when-done');
    expect(text.stdout).toMatch(/plugin\.hook_invoked demo execution\.finished/);
    expect(text.stdout).toMatch(/plugin\.decision demo/);
    const json = await cli(run, 'session', 'follow', id, '--cursor', '0', '--exit-when-done', '--json');
    const events = json.stdout.split('\n').filter((line) => line !== '').map((line) => (JSON.parse(line) as { event: string }).event);
    expect(events).toEqual(expect.arrayContaining(['plugins.frozen', 'plugin.hook_invoked', 'plugin.decision']));
  } finally { cliHooks.runner = null; removeWorkspace(run.root); }
}, 30_000);

test('a session without plugin data has no plugins section', async () => {
  const root = writeFakeWorkflowWorkspace({ wf: WORKFLOW });
  const run = { root, runner: new AgentToolRunner(registryOf({ fake: new ScriptedClient([OK]) }), 10) };
  try {
    await cli(run, 'session', 'run', '--workflow', 'wf', '--task', 'Task');
    expect(await showJson(run)).not.toHaveProperty('plugins');
    const text = await cli(run, 'session', 'show', path.basename(sessionDir(root)));
    expect(text.stdout).not.toMatch(/^plugin/m);
  } finally { cliHooks.runner = null; removeWorkspace(root); }
}, 30_000);


const advisory = (id: string, version: string): Plugin => ({
  manifest: { id, version, apiVersion: { major: 1, minor: 0 }, advisory: true, uses: { ...NO_USES, events: ['execution.finished'] }, configSchema: schema },
  activate: (_options, migent) => { migent.events.on('execution.finished', () => Promise.resolve([])); },
});
const configPath = (root: string): string => path.join(root, '.migent', 'config.yaml');

test('advisory entries follow the live config: enabled, added, removed and upgraded', async () => {
  const run = setup([reporter, advisory('adv', '1.0.0')]);
  try {
    writeFileSync(configPath(run.root), `${FAKE_FLOW_CONFIG}plugins:\n  demo:\n    enabled: true\n  adv:\n    enabled: false\n`, 'utf8');
    await cli(run, 'session', 'run', '--workflow', 'wf', '--task', 'Task');
    const id = path.basename(sessionDir(run.root));
    expect((await showJson(run)).plugins?.active).toEqual(expect.arrayContaining([{ id: 'adv', version: '1.0.0', enabled: false, advisory: true }]));
    // Enabled live, with a newer registered version.
    writeFileSync(configPath(run.root), `${FAKE_FLOW_CONFIG}plugins:\n  demo:\n    enabled: true\n  adv:\n    enabled: true\n`, 'utf8');
    run.runner.pluginRegistry = registryOfPlugins(reporter, advisory('adv', '2.0.0'));
    const enabled = (await showJson(run)).plugins?.active as { id: string; version: string; enabled: boolean }[];
    expect(enabled.find((row) => row.id === 'adv')).toMatchObject({ version: '2.0.0', enabled: true });
    expect(enabled.find((row) => row.id === 'demo')).toMatchObject({ version: '1.2.3' });
    expect((await cli(run, 'session', 'show', id)).stdout).toContain('adv@2.0.0');
    // Removed from the live config: it is no longer active.
    writeFileSync(configPath(run.root), `${FAKE_FLOW_CONFIG}plugins:\n  demo:\n    enabled: true\n`, 'utf8');
    expect(((await showJson(run)).plugins?.active as { id: string }[]).map((row) => row.id)).toEqual(['demo']);
    // Added after the freeze.
    writeFileSync(configPath(run.root), `${FAKE_FLOW_CONFIG}plugins:\n  demo:\n    enabled: true\n  adv2:\n    enabled: true\n`, 'utf8');
    run.runner.pluginRegistry = registryOfPlugins(reporter, advisory('adv2', '3.0.0'));
    expect(((await showJson(run)).plugins?.active as { id: string; version: string }[]).find((row) => row.id === 'adv2')).toMatchObject({ version: '3.0.0' });
  } finally { cliHooks.runner = null; removeWorkspace(run.root); }
}, 30_000);

test('added entries and the mismatch are both reported, even with a missing frozen plugin', async () => {
  const run = setup([reporter]);
  try {
    await cli(run, 'session', 'run', '--workflow', 'wf', '--task', 'Task');
    const id = path.basename(sessionDir(run.root));
    appendFileSync(configPath(run.root), '  newcomer:\n    enabled: true\n');
    appendFileSync(path.join(sessionDir(run.root), 'workflow.frozen.yaml'), '# edited\n');
    run.runner.pluginRegistry = registryOfPlugins();
    const { plugins } = await showJson(run);
    expect(plugins).toMatchObject({ added_after_freeze: ['newcomer'], live_unavailable: null });
    expect(plugins?.freeze_mismatch).toContain('does not match');
    const text = await cli(run, 'session', 'show', id);
    expect(text.stdout).toContain('plugin_added_after_freeze  newcomer');
    expect(text.stdout).toContain('plugin_freeze_mismatch');
  } finally { cliHooks.runner = null; removeWorkspace(run.root); }
}, 30_000);

test('an unreadable live config is reported as live_unavailable, not as no added entries', async () => {
  const run = setup([reporter]);
  try {
    await cli(run, 'session', 'run', '--workflow', 'wf', '--task', 'Task');
    writeFileSync(configPath(run.root), 'plugins: [not, a, mapping]\n', 'utf8');
    const { plugins } = await showJson(run);
    expect(plugins?.added_after_freeze).toBeNull();
    expect(plugins?.live_unavailable).toEqual(expect.any(String));
    expect(plugins?.active).toMatchObject([{ id: 'demo' }]);
  } finally { cliHooks.runner = null; removeWorkspace(run.root); }
}, 30_000);

test('a plugins freeze with no plugins.frozen record is reported, with or without other plugin records', async () => {
  const run = setup([reporter]);
  try {
    await cli(run, 'session', 'run', '--workflow', 'wf', '--task', 'Task');
    const dir = sessionDir(run.root);
    const events = path.join(dir, 'events.jsonl');
    const lines = readFileSync(events, 'utf8').split('\n').filter((line) => line !== '');
    writeFileSync(events, `${lines.filter((line) => !line.includes('"plugins.frozen"')).join('\n')}\n`, 'utf8');
    const withRecords = await showJson(run);
    expect(withRecords.plugins?.freeze_mismatch).toContain('no plugins.frozen event');
    expect((await cli(run, 'session', 'show', path.basename(dir))).stdout).toContain('plugin_freeze_mismatch  ');
    writeFileSync(events, `${lines.filter((line) => !line.includes('"plugin')).join('\n')}\n`, 'utf8');
    const bare = await showJson(run);
    expect(bare.plugins).toMatchObject({ active: [], invocations: [] });
    expect(bare.plugins?.freeze_mismatch).toContain('no plugins.frozen event');
  } finally { cliHooks.runner = null; removeWorkspace(run.root); }
}, 30_000);

test('an unrelated malformed workflow freeze adds no plugins section to a session without plugin data', async () => {
  const root = writeFakeWorkflowWorkspace({ wf: WORKFLOW });
  const run = { root, runner: new AgentToolRunner(registryOf({ fake: new ScriptedClient([OK]) }), 10) };
  try {
    await cli(run, 'session', 'run', '--workflow', 'wf', '--task', 'Task');
    const dir = sessionDir(root);
    writeFileSync(path.join(dir, 'workflow.frozen.yaml'), 'schema_version: 2\nsource_sha256: null\nworkflow: [broken]\nroles: {}\ntargets: {}\n', 'utf8');
    expect(await showJson(run)).not.toHaveProperty('plugins');
    const text = await cli(run, 'session', 'show', path.basename(dir));
    expect(text.stdout).not.toMatch(/^plugin/m);
  } finally { cliHooks.runner = null; removeWorkspace(root); }
}, 30_000);
