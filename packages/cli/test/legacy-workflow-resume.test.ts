import { createHash } from 'node:crypto';
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { AgentToolRunner } from '@nodeint/migent-engine';
import { afterEach, expect, test } from 'vitest';
import { parse, stringify } from 'yaml';

import { withPlugins } from '../src/client.ts';
import { executeWorkflow } from '../src/commands/execute.ts';
import { cliHooks } from '../src/hooks.ts';
import { main } from '../src/index.ts';
import { ageProviderEvents, question } from './resume-support.ts';
import { capture, registryOf, removeWorkspace, ScriptedClient, writeFakeWorkflowWorkspace } from './support.ts';

const EXIT_EXPIRED = 10;
const FAKE_POLICIES = {
  fake: { match: { client: 'fake' }, cache_ttl: '1s', on_expired: 'ask' },
  slow: { cache_ttl: '1h', on_expired: 'resume' },
};
const WORKFLOW = 'schema_version: 8\nid: plan\nstages:\n  - { id: plan, role: planner, ask: human }\n';

type Doc = Record<string, any>;
type Mutate = (doc: Doc) => void;

interface Options {
  /** Edits the parsed freeze, which already has its plugin and extension sections removed. */
  readonly freeze?: Mutate;
  /** Keeps the #166 `plugins` section and records it again in `plugins.frozen`. */
  readonly keepPluginsSection?: boolean;
  readonly liveConfig?: string;
  readonly plain?: boolean;
}

const roots: string[] = [];
afterEach(() => {
  cliHooks.runner = null;
  for (const root of roots.splice(0)) removeWorkspace(root);
});

const eventsFile = (root: string, id: string) => path.join(root, '.migent/sessions', id, 'events.jsonl');
const freezeFile = (root: string, id: string) => path.join(root, '.migent/sessions', id, 'workflow.frozen.yaml');
const readEvents = (root: string, id: string): Record<string, any>[] =>
  readFileSync(eventsFile(root, id), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);

/** Rewrites the freeze and its `plugins.frozen` event into the shape written before the plugin existed. */
function toLegacy(root: string, id: string, options: Options): void {
  const file = freezeFile(root, id);
  const doc = parse(readFileSync(file, 'utf8')) as Doc;
  delete doc.extensions;
  if (options.keepPluginsSection === true) {
    delete doc.config.plugins.entries.prompt_cache_ttl;
  } else {
    delete doc.config;
  }
  doc.workflow.schema_version = 7;
  options.freeze?.(doc);
  writeFileSync(file, stringify(doc, { lineWidth: 0 }));
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  const lines = readFileSync(eventsFile(root, id), 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    const event = JSON.parse(line) as Doc;
    if (event.event !== 'plugins.frozen') return [line];
    if (options.keepPluginsSection !== true) return [];
    event.data.freeze_hash = hash;
    event.data.plugins = event.data.plugins.filter((row: Doc) => row.id !== 'prompt_cache_ttl');
    return [JSON.stringify(event)];
  });
  writeFileSync(eventsFile(root, id), `${lines.join('\n')}\n`);
}

/** A workflow session whose asking stage was answered later by `continue`, frozen the old way. */
async function legacySession(options: Options = {}) {
  const root = writeFakeWorkflowWorkspace({ plan: WORKFLOW });
  roots.push(root);
  const provider = new ScriptedClient([question, 'status: complete\n\nDone']);
  const base = new AgentToolRunner(registryOf({ fake: provider }), 10);
  const runner = options.plain === true ? base : withPlugins(base);
  cliHooks.runner = runner;
  await capture(() => executeWorkflow(root, { action: 'start', workflowId: 'plan', task: 'Plan', runner, stageId: null }));
  const id = readdirSync(path.join(root, '.migent/sessions'))[0] ?? '';
  const directory = path.join(root, '.migent/sessions', id, 'executions');
  const executionFile = path.join(directory, readdirSync(directory)[0] ?? '', 'execution.json');
  const metadata = JSON.parse(readFileSync(executionFile, 'utf8')) as Record<string, unknown>;
  writeFileSync(executionFile, JSON.stringify({ ...metadata, completed_at: '2026-01-01T00:00:00.000+00:00' }));
  ageProviderEvents(executionFile);
  toLegacy(root, id, options);
  if (options.liveConfig !== undefined) appendFileSync(path.join(root, '.migent/config.yaml'), `\n${options.liveConfig}`);
  const bytes = readFileSync(freezeFile(root, id));
  const next = () => capture(() => {
    cliHooks.runner = runner;
    return main(['session', 'continue', id, '--reply', 'New only'], root);
  });
  return { root, id, provider, next, bytes };
}

const withPolicies = (extra: Mutate = () => undefined): Mutate => (doc) => {
  doc.resume_policies = FAKE_POLICIES;
  extra(doc);
};
const expiredEvent = (root: string, id: string) => readEvents(root, id).find((event) => event.event === 'resume.expired');

test('a policy match from a legacy freeze still gates the resume and records the expiry', async () => {
  const run = await legacySession({ freeze: withPolicies() });
  const result = await run.next();
  expect(result.value).toBe(EXIT_EXPIRED);
  expect(run.provider.calls).toHaveLength(1);
  expect(expiredEvent(run.root, run.id)?.data).toMatchObject({ policy: 'fake', action: 'ask' });
  expect(readFileSync(freezeFile(run.root, run.id)).equals(run.bytes)).toBe(true);
}, 30_000);

test('an explicit legacy target policy wins over the matching one', async () => {
  const run = await legacySession({ freeze: withPolicies((doc) => { doc.targets.plan.resume_policy = 'slow'; }) });
  expect((await run.next()).value).toBe(0);
  expect(run.provider.calls[1]?.agent_id).toBe('native-session-1');
  expect(expiredEvent(run.root, run.id)?.data).toMatchObject({ policy: 'slow', action: 'resume', origin: 'policy' });
  expect(readFileSync(freezeFile(run.root, run.id)).equals(run.bytes)).toBe(true);
}, 30_000);

test('a null legacy target policy falls back to matching', async () => {
  const run = await legacySession({ freeze: withPolicies((doc) => { doc.targets.plan.resume_policy = null; }) });
  expect((await run.next()).value).toBe(EXIT_EXPIRED);
  expect(expiredEvent(run.root, run.id)?.data).toMatchObject({ policy: 'fake' });
}, 30_000);

test('a legacy stage session.on_expired overrides the policy action', async () => {
  const run = await legacySession({
    freeze: withPolicies((doc) => { doc.workflow.stages[0].session = { on_expired: 'fresh' }; }),
  });
  expect((await run.next()).value).toBe(0);
  expect(run.provider.calls[1]?.agent_id).toBeNull();
  expect(run.provider.calls[1]?.prompt).toContain('New only');
  expect(expiredEvent(run.root, run.id)?.data).toMatchObject({ policy: 'fake', action: 'fresh', origin: 'stage' });
  expect(readFileSync(freezeFile(run.root, run.id)).equals(run.bytes)).toBe(true);
}, 30_000);

test('a legacy inline agent resume_policy is read as the stage policy', async () => {
  const run = await legacySession({
    freeze: withPolicies((doc) => {
      doc.workflow.stages[0].agent = { client: { type: 'fake' }, model: 'm1', resume_policy: 'slow' };
      // The old writer also copied the inline agent's policy into its target.
      doc.targets.plan.resume_policy = 'slow';
    }),
  });
  expect((await run.next()).value).toBe(0);
  expect(run.provider.calls[1]?.agent_id).toBe('native-session-1');
  expect(expiredEvent(run.root, run.id)?.data).toMatchObject({ policy: 'slow', action: 'resume' });
}, 30_000);

test('a legacy freeze without policies resumes and records no expiry', async () => {
  const run = await legacySession();
  expect((await run.next()).value).toBe(0);
  expect(run.provider.calls[1]?.agent_id).toBe('native-session-1');
  expect(expiredEvent(run.root, run.id)).toBeUndefined();
  expect(readFileSync(freezeFile(run.root, run.id)).equals(run.bytes)).toBe(true);
}, 30_000);

test('a #166 plugins freeze with legacy policy keys still gates, from the recorded policies', async () => {
  const run = await legacySession({ keepPluginsSection: true, freeze: withPolicies() });
  expect((await run.next()).value).toBe(EXIT_EXPIRED);
  expect(expiredEvent(run.root, run.id)?.data).toMatchObject({ policy: 'fake' });
  expect(readFileSync(freezeFile(run.root, run.id)).equals(run.bytes)).toBe(true);
}, 30_000);

test('a live enabled: false stops the legacy gate on dispatch', async () => {
  const run = await legacySession({ freeze: withPolicies(), liveConfig: 'plugins:\n  prompt_cache_ttl:\n    enabled: false\n' });
  expect((await run.next()).value).toBe(0);
  expect(run.provider.calls[1]?.agent_id).toBe('native-session-1');
  expect(expiredEvent(run.root, run.id)).toBeUndefined();
}, 30_000);

test('a runner without a plugin registry resumes a legacy freeze without gating', async () => {
  const run = await legacySession({ freeze: withPolicies(), plain: true });
  expect((await run.next()).value).toBe(0);
  expect(run.provider.calls[1]?.agent_id).toBe('native-session-1');
  expect(expiredEvent(run.root, run.id)).toBeUndefined();
}, 30_000);

test('a session with no policies anywhere records no resume events', async () => {
  const run = await legacySession();
  await run.next();
  const events = readEvents(run.root, run.id);
  expect(events.map((event) => event.event).filter((name) => name.startsWith('resume.'))).toEqual([]);
  // No interceptor is registered, so the policy plugin emits no hook, decision or failure event.
  // Other plugins (metrics) may still emit their own lifecycle events.
  const gate = /^plugin\.(hook_invoked|decision|failed)$/;
  const fromPolicyPlugin = events.filter((event) => gate.test(event.event) && event.data?.plugin === 'prompt_cache_ttl');
  expect(fromPolicyPlugin).toEqual([]);
}, 30_000);
