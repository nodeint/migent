/** #141 P4: the `summary` field and line of `session show`, and `--summary`. */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { AgentToolRunner } from '@nodeint/migent-engine';
import { createPluginRegistry } from '@nodeint/migent-plugins';
import { readBasisSeq } from '@nodeint/migent-session';
import { afterEach, expect, test } from 'vitest';

import { cliHooks } from '../src/hooks.ts';
import { main } from '../src/index.ts';
import { capture, registryOf, removeWorkspace, ScriptedClient, writeFakeWorkflowWorkspace } from './support.ts';

const WORKFLOW = 'schema_version: 8\nid: wf\nstages:\n  - id: one\n    role: planner\n';
/** Blank lines at both ends: the body must be reported exactly as stored. */
const BODY = '\n# Session x · wf · completed · t\n\n## Done\nBuilt it.\n\n\n';
const PATH = 'plugins/summarizer/summary.md';
const ENTRY = 'plugins:\n  summarizer:\n    enabled: true\n    agent: fake-model\n';

const roots: string[] = [];
afterEach(() => {
  cliHooks.runner = null;
  for (const root of roots.splice(0)) removeWorkspace(root);
});

interface Finished { root: string; id: string; dir: string; seq: number }
async function finished(plugins = ''): Promise<Finished> {
  const root = writeFakeWorkflowWorkspace({ wf: WORKFLOW });
  roots.push(root);
  if (plugins !== '') appendFileSync(path.join(root, '.migent', 'config.yaml'), `\n${plugins}`);
  const runner = new AgentToolRunner(registryOf({ fake: new ScriptedClient(['status: complete\n\ndone']) }), 10);
  runner.pluginRegistry = createPluginRegistry();
  cliHooks.runner = runner;
  expect((await capture(() => main(['session', 'run', '--workflow', 'wf', '--task', 'Task'], root))).value).toBe(0);
  const id = readdirSync(path.join(root, '.migent/sessions'))[0] ?? '';
  return { root, id, dir: path.join(root, '.migent/sessions', id), seq: readBasisSeq(root, id) ?? 0 };
}

function store(session: Finished, content: string | Buffer): void {
  mkdirSync(path.join(session.dir, 'plugins', 'summarizer'), { recursive: true });
  writeFileSync(path.join(session.dir, PATH), content);
}
const header = (seq: number | string): string => `<!-- migent-summary v1 basis_seq=${seq} -->\n`;
const show = (session: Finished, ...flags: string[]) =>
  capture(() => main(['session', 'show', session.id, ...flags], session.root));
const addEvent = (session: Finished, name: string, seq: number): void =>
  appendFileSync(path.join(session.dir, 'events.jsonl'),
    `${JSON.stringify({ seq, event: name, timestamp: '2026-01-01T00:00:00Z', session_id: session.id })}\n`);

test('without a summary the output has no summary key or line, and --summary is null in JSON', async () => {
  const session = await finished();
  expect(JSON.parse((await show(session, '--json')).stdout)).not.toHaveProperty('summary');
  expect((await show(session)).stdout).not.toContain('summary  ');
  expect(JSON.parse((await show(session, '--json', '--summary')).stdout)).toHaveProperty('summary', null);
  const text = await show(session, '--summary');
  expect(text.value).toBe(0);
  expect(text.stderr).toContain(`No summary for session: ${session.id}.`);
}, 30_000);

test('a current summary: line without text, JSON fields, and the body exactly as stored', async () => {
  const session = await finished();
  store(session, `${header(session.seq)}${BODY}`);
  const plain = await show(session);
  expect(plain.stdout).toContain(`summary  ${PATH} · current`);
  expect(plain.stdout).not.toContain('Built it.');
  const json = JSON.parse((await show(session, '--json')).stdout) as { summary: unknown };
  expect(json.summary).toEqual({ path: PATH, basis_seq: session.seq, stale: false });
  const withText = JSON.parse((await show(session, '--json', '--summary')).stdout) as { summary: { text: string } };
  expect(withText.summary.text).toBe(BODY);
  const text = await show(session, '--summary');
  expect(text.stdout).toContain(`summary  ${PATH} · current`);
  expect(text.stdout.endsWith(`\n${BODY}`)).toBe(true);
  expect(text.stdout).not.toContain('migent-summary');
  expect(text.stderr).not.toContain('No summary');
}, 30_000);

test('a later non-plugin event makes it stale; a plugin event alone does not', async () => {
  const session = await finished();
  store(session, `${header(session.seq)}${BODY}`);
  addEvent(session, 'plugin.failed', session.seq + 1);
  expect((await show(session)).stdout).toContain('· current');
  addEvent(session, 'execution.started', session.seq + 2);
  expect((await show(session)).stdout).toContain(`summary  ${PATH} · stale`);
}, 30_000);

test('a malformed header or invalid UTF-8 gives a notice, no field, and one JSON object', async () => {
  const session = await finished();
  for (const content of ['no header\n', Buffer.concat([Buffer.from(header(1)), Buffer.from([0xff, 0xfe])])]) {
    store(session, content);
    const shown = await show(session, '--json');
    expect(JSON.parse(shown.stdout)).not.toHaveProperty('summary');
    expect(shown.stderr).toContain('Ignoring');
  }
  rmSync(path.join(session.dir, PATH));
}, 30_000);

test('a basis_seq outside the safe integer range is rejected like a malformed header', async () => {
  const session = await finished();
  for (const seq of ['9'.repeat(400), '9007199254740993']) {
    store(session, `${header(seq)}${BODY}`);
    const shown = await show(session, '--json', '--summary');
    expect(JSON.parse(shown.stdout)).toHaveProperty('summary', null);
    expect(shown.stderr).toContain('Ignoring');
    expect((await show(session)).stdout).not.toContain('summary  ');
  }
}, 30_000);

test('a summary stored while the entry was configured stays shown after the entry is removed, then goes stale', async () => {
  const session = await finished(ENTRY);
  const configPath = path.join(session.root, '.migent', 'config.yaml');
  expect(readFileSync(configPath, 'utf8')).toContain('summarizer');
  store(session, `${header(session.seq)}${BODY}`);
  writeFileSync(configPath, readFileSync(configPath, 'utf8').replace(ENTRY, ''));
  expect(readFileSync(configPath, 'utf8')).not.toContain('summarizer');
  expect((await show(session)).stdout).toContain(`summary  ${PATH} · current`);
  addEvent(session, 'execution.started', session.seq + 1);
  const after = await show(session, '--summary');
  expect(after.stdout).toContain(`summary  ${PATH} · stale`);
  expect(after.stdout).toContain('Built it.');
}, 30_000);
