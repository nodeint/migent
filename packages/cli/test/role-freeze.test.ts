import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Plugin, PluginRegistry, TSchema } from '@nodeint/migent-contracts';
import { AgentToolRunner } from '@nodeint/migent-engine';
import { createAgentSession, readParsedEvents } from '@nodeint/migent-session';
import { expect, test } from 'vitest';

import { continueAgent, dispatchAgent } from '../src/commands/agent.ts';
import { capture, registryOf, removeWorkspace, ScriptedClient, writeFakeWorkflowWorkspace } from './support.ts';

const OK = 'status: complete\n\nDone';

function frozenEvents(root: string, id: string) {
  return readParsedEvents(path.join(root, '.migent/sessions', id, 'events.jsonl')).filter((event) => event.event === 'plugins.frozen');
}

const eventNames = (root: string, id: string): string[] =>
  readParsedEvents(path.join(root, '.migent/sessions', id, 'events.jsonl')).map((event) => event.event);

function runnerOf(responses: string[]): { runner: AgentToolRunner; provider: ScriptedClient } {
  const provider = new ScriptedClient(responses);
  return { runner: new AgentToolRunner(registryOf({ fake: provider }), 10), provider };
}

/** A session that crashed between `session.created` and `plugins.frozen`: no freeze, no execution. */
function crashed(root: string): string {
  return createAgentSession(root, 'reviewer', 'Review');
}

test('a new role session records exactly one role freeze before its first execution', async () => {
  const root = writeFakeWorkflowWorkspace({});
  try {
    const { runner } = runnerOf([OK]);
    expect((await capture(() => dispatchAgent(root, { role: 'reviewer', prompt: 'Review', runner }))).value).toBe(0);
    const id = readdirSync(path.join(root, '.migent/sessions'))[0]!;
    const frozen = frozenEvents(root, id);
    expect(frozen).toHaveLength(1);
    const freeze = frozen[0]!.data.role_freeze as { target: { client: string; model: string } };
    expect(freeze.target).toMatchObject({ client: 'fake', model: 'm1' });
    const names = eventNames(root, id);
    expect(names.indexOf('plugins.frozen')).toBeGreaterThan(-1);
    expect(names.indexOf('plugins.frozen')).toBeLessThan(names.findIndex((name) => name.startsWith('execution.')));
  } finally { removeWorkspace(root); }
}, 30_000);

test('a crashed role session records its freeze before the first execution of `session run --session`', async () => {
  const root = writeFakeWorkflowWorkspace({});
  try {
    const id = crashed(root);
    expect(frozenEvents(root, id)).toHaveLength(0);
    const { runner } = runnerOf([OK]);
    expect((await capture(() => dispatchAgent(root, { role: 'reviewer', sessionId: id, prompt: 'Review', runner }))).value).toBe(0);
    expect(frozenEvents(root, id)).toHaveLength(1);
    const names = eventNames(root, id);
    expect(names.indexOf('plugins.frozen')).toBeLessThan(names.findIndex((name) => name.startsWith('execution.')));
  } finally { removeWorkspace(root); }
}, 30_000);

test('continuing a crashed role session records the freeze, then reports no execution', async () => {
  const root = writeFakeWorkflowWorkspace({});
  try {
    const id = crashed(root);
    const { runner } = runnerOf([OK]);
    await expect(continueAgent(root, { sessionId: id, reply: null, runner })).rejects.toThrow(`Session ${id} has no execution.`);
    expect(frozenEvents(root, id)).toHaveLength(1);
    await expect(continueAgent(root, { sessionId: id, reply: null, runner })).rejects.toThrow('has no execution');
    expect(frozenEvents(root, id)).toHaveLength(1);
  } finally { removeWorkspace(root); }
}, 30_000);

test('running a role session twice records only one freeze', async () => {
  const root = writeFakeWorkflowWorkspace({});
  try {
    const { runner } = runnerOf([OK, OK]);
    await capture(() => dispatchAgent(root, { role: 'reviewer', prompt: 'Review', runner }));
    const id = readdirSync(path.join(root, '.migent/sessions'))[0]!;
    await capture(() => dispatchAgent(root, { role: 'reviewer', sessionId: id, prompt: 'Again', runner }));
    expect(frozenEvents(root, id)).toHaveLength(1);
  } finally { removeWorkspace(root); }
}, 30_000);

test('a legacy role session with an execution and no freeze records nothing', async () => {
  const root = writeFakeWorkflowWorkspace({});
  try {
    const { runner } = runnerOf([OK, OK]);
    await capture(() => dispatchAgent(root, { role: 'reviewer', prompt: 'Review', runner }));
    const id = readdirSync(path.join(root, '.migent/sessions'))[0]!;
    // Make the session legacy: drop the freeze event the first run recorded.
    const log = path.join(root, '.migent/sessions', id, 'events.jsonl');
    const kept = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '' && !line.includes('"plugins.frozen"'));
    writeFileSync(log, `${kept.join('\n')}\n`);
    expect(frozenEvents(root, id)).toHaveLength(0);
    expect((await capture(() => dispatchAgent(root, { role: 'reviewer', sessionId: id, prompt: 'Again', runner }))).value).toBe(0);
    expect(frozenEvents(root, id)).toHaveLength(0);
  } finally { removeWorkspace(root); }
}, 30_000);

const schema = { type: 'object' } as unknown as TSchema;
const ASK = 'status: question\n\n' + JSON.stringify({ schema_version: 1, questions: [{
  id: '1', question: 'Scope?', context: 'c', selection: 'single',
  options: [{ id: 'A', label: 'a' }, { id: 'B', label: 'b' }],
}] });
const POLICY = '\nresume_policies:\n  fake:\n    match: { client: fake }\n    cache_ttl: 1h\n    on_expired: ask\n';

/** A default-enabled plugin that records every hook and every `conversation.resume` request it sees. */
function probeOf(seen: string[], requests: Record<string, unknown>[]): Plugin {
  const record = (hook: string) => (): Promise<[]> => {
    seen.push(hook);
    return Promise.resolve([]);
  };
  return {
    manifest: {
      id: 'probe', version: '1.0.0', apiVersion: { major: 1, minor: 0 }, advisory: false, defaultEnabled: true,
      configSchema: schema,
      uses: {
        operations: [{ target: 'conversation.resume', phases: ['before'] }],
        events: ['session.started', 'execution.finished', 'session.stopped'],
        session: [], artifacts: [], agents: false, config: [],
      },
    },
    activate: (_options, migent) => {
      migent.events.on('session.started', record('session.started'));
      migent.events.on('execution.finished', record('execution.finished'));
      migent.events.on('session.stopped', record('session.stopped'));
      migent.operations.intercept('conversation.resume', {
        before: (request) => {
          requests.push({ ...request });
          return Promise.resolve({ kind: 'continue' });
        },
      });
    },
  };
}
const withProbe = (runner: AgentToolRunner, plugin: Plugin): AgentToolRunner => Object.assign(runner, {
  pluginRegistry: { ids: () => ['probe'], get: (id: string) => (id === 'probe' ? plugin : undefined) } satisfies PluginRegistry,
});

test('a role run fires start and stop hooks, and a continuation fires only its own stop', async () => {
  const root = writeFakeWorkflowWorkspace({});
  try {
    const seen: string[] = [];
    const { runner } = runnerOf([ASK, OK]);
    withProbe(runner, probeOf(seen, []));
    appendFileSync(path.join(root, '.migent/config.yaml'), POLICY);
    expect((await capture(() => dispatchAgent(root, { role: 'reviewer', prompt: 'Review', runner }))).value).toBe(9);
    expect(seen).toEqual(['session.started', 'execution.finished', 'session.stopped']);
    const id = readdirSync(path.join(root, '.migent/sessions'))[0]!;
    // A config edit after creation does not change the frozen selection: the probe still runs.
    appendFileSync(path.join(root, '.migent/config.yaml'), '\nplugins:\n  probe:\n    enabled: false\n');
    seen.length = 0;
    expect((await capture(() => continueAgent(root, { sessionId: id, reply: 'B', runner }))).value).toBe(0);
    expect(seen).toEqual(['execution.finished', 'session.stopped']);
    expect(frozenEvents(root, id)).toHaveLength(1);
  } finally { removeWorkspace(root); }
}, 30_000);

test('the resume gate receives the frozen client and model, not the live profile', async () => {
  const root = writeFakeWorkflowWorkspace({});
  try {
    const requests: Record<string, unknown>[] = [];
    const { runner } = runnerOf([ASK, OK]);
    withProbe(runner, probeOf([], requests));
    appendFileSync(path.join(root, '.migent/config.yaml'), POLICY);
    await capture(() => dispatchAgent(root, { role: 'reviewer', prompt: 'Review', runner }));
    const id = readdirSync(path.join(root, '.migent/sessions'))[0]!;
    requests.length = 0;
    // The explicit model differs from the frozen one; the gate still judges the frozen target.
    const again = dispatchAgent(root, { role: 'reviewer', sessionId: id, client: 'fake', model: 'm2', prompt: 'Again', runner });
    await expect(again).rejects.toThrow('recorded fake/m1, requested fake/m2');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ client: 'fake', model: 'm1' });
  } finally { removeWorkspace(root); }
}, 30_000);
