/**
 * #150 P1 baseline: what a session without a `plugins` key produces today. Later phases rerun this file unchanged.
 * Volatile values (ids, timestamps, durations, pids, temp roots) are normalized before comparing.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { AgentToolRunner } from '@nodeint/migent-engine';
import { expect, test } from 'vitest';

import { cliHooks } from '../src/hooks.ts';
import { main } from '../src/index.ts';
import { capture, registryOf, removeWorkspace, ScriptedClient, writeFakeWorkflowWorkspace } from './support.ts';

const WORKFLOW = 'schema_version: 7\nid: wf\nstages:\n  - { id: one, role: planner }\n  - { id: two, role: reviewer, depends_on: [one] }\n';
const OK = 'status: complete\n\nDone';

function setup(responses: string[]): { root: string; provider: ScriptedClient; runner: AgentToolRunner } {
  const root = writeFakeWorkflowWorkspace({ wf: WORKFLOW });
  const provider = new ScriptedClient(responses);
  return { root, provider, runner: new AgentToolRunner(registryOf({ fake: provider }), 10) };
}

/** `main` clears the runner hook when it returns, so every command sets it again. */
function cli(run: { root: string; runner: AgentToolRunner }, ...args: string[]) {
  return capture(() => { cliHooks.runner = run.runner; return main(args, run.root); });
}

function sessionDir(root: string): string {
  const id = readdirSync(path.join(root, '.migent/sessions'))[0] ?? '';
  return path.join(root, '.migent/sessions', id);
}

function normalize(text: string, root: string): string {
  return text
    .replaceAll(root, '<root>')
    .replaceAll(/\d{4}-\d\d-\d\d[ T][\d:.]+(?:Z|[+-]\d\d:\d\d)/g, '<time>')
    .replaceAll(/\b\d+(?:\.\d+)?m?s\b/g, '<duration>')
    .replaceAll(/^(events_cursor\s+)\d+$/gm, '$1<cursor>')
    .replaceAll(/"(pid|duration_ms|duration_seconds)":\s*\d+/g, '"$1":0');
}

/** Machine-specific leaves: the git error text, the byte-offset cursor, and the node binary path. */
function normalizeLeaf(key: string, value: unknown, root: string): unknown {
  if (key === 'events_cursor') return '<cursor>';
  if (key === 'error' && typeof value === 'string' && value.startsWith('not a Git work tree')) return '<git error>';
  if (typeof value === 'string') return normalize(value.replaceAll(process.execPath, '<node>'), root);
  return value;
}

/** Full JSON content with volatile values replaced, so the snapshot pins every field. */
function normalizeJson(value: unknown, root: string, key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item, root, key));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeJson(v, root, k)]));
  }
  return normalizeLeaf(key, value, root);
}

function eventKinds(dir: string): string[] {
  return readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter((l) => l !== '')
    .map((l) => (JSON.parse(l) as { event: string }).event);
}

test('a run without a plugins key: frozen bytes, events, status, show and exit code', async () => {
  const run = setup([OK, OK]);
  try {
    const result = await cli(run, 'session', 'run', '--workflow', 'wf', '--task', 'Task');
    expect(result.value).toBe(0);
    const dir = sessionDir(run.root);
    const frozen = readFileSync(path.join(dir, 'workflow.frozen.yaml'), 'utf8');
    expect(frozen).not.toContain('plugins');
    expect(normalize(frozen, run.root)).toMatchSnapshot('frozen');
    expect(eventKinds(dir)).toMatchSnapshot('events');
    const status = JSON.parse(readFileSync(path.join(dir, 'status.json'), 'utf8')) as Record<string, unknown>;
    expect(status.status).toBe('completed');
    expect(status).not.toHaveProperty('plugin_holds');
    expect(normalizeJson(status, run.root)).toMatchSnapshot('status.json');
    const shown = await cli(run, 'session', 'show', path.basename(dir));
    expect(shown.value).toBe(0);
    expect(normalize(shown.stdout, run.root)).toMatchSnapshot('show text');
    const shownJson = await cli(run, 'session', 'show', path.basename(dir), '--json');
    const body = JSON.parse(shownJson.stdout) as Record<string, unknown>;
    expect(body).not.toHaveProperty('plugins');
    expect(normalizeJson(body, run.root)).toMatchSnapshot('show json');
  } finally { cliHooks.runner = null; removeWorkspace(run.root); }
}, 30_000);

test('continue and --refresh-workflow on a session without plugins keep their exit codes and freeze', async () => {
  const run = setup([OK, OK]);
  try {
    expect((await cli(run, 'session', 'run', '--workflow', 'wf', '--task', 'Task', '--once')).value).toBe(0);
    const dir = sessionDir(run.root);
    const id = path.basename(dir);
    const before = readFileSync(path.join(dir, 'workflow.frozen.yaml'), 'utf8');
    const kindsBefore = eventKinds(dir);
    const refreshed = await cli(run, 'session', 'continue', id, '--refresh-workflow');
    expect(refreshed.value).toBe(0);
    expect(normalize(readFileSync(path.join(dir, 'workflow.frozen.yaml'), 'utf8'), run.root)).toBe(normalize(before, run.root));
    expect(eventKinds(dir)).toMatchSnapshot('events after refresh');
    expect(eventKinds(dir).slice(0, kindsBefore.length)).toEqual(kindsBefore);
    // Nothing is left to run: a plain continue still exits 0 and records nothing new.
    const kindsDone = eventKinds(dir);
    expect((await cli(run, 'session', 'continue', id)).value).toBe(0);
    expect(eventKinds(dir)).toEqual(kindsDone);
  } finally { cliHooks.runner = null; removeWorkspace(run.root); }
}, 30_000);
