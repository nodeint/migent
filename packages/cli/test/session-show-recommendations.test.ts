/** #125 P2: the `recommendations` field of `session show` and the first `session follow --json` line. */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { CommandSpec } from '@nodeint/migent-contracts';
import { AgentToolRunner } from '@nodeint/migent-engine';
import { createPluginRegistry } from '@nodeint/migent-plugins';
import { afterEach, expect, test } from 'vitest';

import { cliHooks } from '../src/hooks.ts';
import { main } from '../src/index.ts';
import { capture, registryOf, removeWorkspace, ScriptedClient, writeFakeWorkflowWorkspace } from './support.ts';

const WAIT_MS = 50;
const WAIT_ATTEMPTS = 200;
const DOWNSTREAM = 'downstream:\n  - workflow: implement\n    task: Build it\n';
const STAGES = 'stages:\n  - id: one\n    role: planner\n';
const WITH = `schema_version: 8\nid: wf\n${DOWNSTREAM}${STAGES}`;
const WITHOUT = `schema_version: 8\nid: wf\n${STAGES}`;
const TARGET = 'schema_version: 8\nid: implement\nstages:\n  - id: a\n    role: planner\n';
const reply = (next: Record<string, unknown>) =>
  `status: complete\n\ndone\n<<FILE>>${JSON.stringify({ schema_version: 1, status: 'complete', next })}`;

const roots: string[] = [];
afterEach(() => {
  cliHooks.runner = null;
  for (const root of roots.splice(0)) removeWorkspace(root);
});

function runnerOf(...responses: string[]): AgentToolRunner {
  const runner = new AgentToolRunner(registryOf({ fake: new ScriptedClient(responses) }), 10);
  runner.pluginRegistry = createPluginRegistry();
  return runner;
}

/** A finished session whose one stage recommended `next`. */
interface Finished { root: string; id: string; dir: string }
async function finished(workflow: string, next: Record<string, unknown> | null): Promise<Finished> {
  const root = writeFakeWorkflowWorkspace({ wf: workflow, implement: TARGET });
  roots.push(root);
  cliHooks.runner = runnerOf(next === null ? 'status: complete\n\ndone' : reply(next));
  expect((await capture(() => main(['session', 'run', '--workflow', 'wf', '--task', 'Task'], root))).value).toBe(0);
  const id = readdirSync(path.join(root, '.migent/sessions'))[0] ?? '';
  return { root, id, dir: path.join(root, '.migent/sessions', id) };
}

const artifactPath = (dir: string): string => path.join(dir, 'plugins', 'next', 'recommendations.json');
const show = (root: string, id: string, ...flags: string[]) => capture(() => main(['session', 'show', id, ...flags], root));

test('show --json and text list the recommendation, with abstain and a warning suffix', async () => {
  const session = await finished(WITH, { workflow: 'elsewhere', reason: 'odd' });
  const json = JSON.parse((await show(session.root, session.id, '--json')).stdout) as { recommendations?: unknown };
  expect(json.recommendations).toEqual([
    { stage_id: 'one', execution_id: '0001-one--attempt-01', workflow: 'elsewhere', reason: 'odd', warning: 'elsewhere is not in downstream' },
  ]);
  expect((await show(session.root, session.id)).stdout).toContain('recommend  one → elsewhere: odd (warning: elsewhere is not in downstream)');

  writeFileSync(artifactPath(session.dir), JSON.stringify({
    schema_version: 1, recommendations: [{ stage_id: 'one', execution_id: 'e1', workflow: null, reason: 'nothing fits' }],
  }));
  expect((await show(session.root, session.id)).stdout).toContain('recommend  one → abstain: nothing fits');
}, 30_000);

test('a missing file leaves the field absent', async () => {
  const session = await finished(WITH, { workflow: 'implement', reason: 'ready' });
  rmSync(artifactPath(session.dir));
  const shown = await show(session.root, session.id, '--json');
  expect(JSON.parse(shown.stdout)).not.toHaveProperty('recommendations');
  expect(shown.stderr).not.toContain('Ignoring');
}, 30_000);

test('a corrupt or schema-invalid file leaves the field absent, notes it on stderr, and keeps stdout one object', async () => {
  const session = await finished(WITH, { workflow: 'implement', reason: 'ready' });
  for (const body of ['{not json', JSON.stringify({ schema_version: 1, recommendations: [{ stage_id: 1 }] })]) {
    writeFileSync(artifactPath(session.dir), body);
    const shown = await show(session.root, session.id, '--json');
    expect(JSON.parse(shown.stdout)).not.toHaveProperty('recommendations');
    expect(shown.stderr).toContain('Ignoring');
  }
}, 30_000);

test('a freeze without next contracts hides an existing file', async () => {
  const session = await finished(WITHOUT, null);
  mkdirSync(path.dirname(artifactPath(session.dir)), { recursive: true });
  writeFileSync(artifactPath(session.dir), JSON.stringify({
    schema_version: 1, recommendations: [{ stage_id: 'one', execution_id: 'e1', workflow: 'implement', reason: 'x' }],
  }));
  expect(JSON.parse((await show(session.root, session.id, '--json')).stdout)).not.toHaveProperty('recommendations');
}, 30_000);

test('the first session follow --json line carries the recommendations', async () => {
  const session = await finished(WITH, { workflow: 'implement', reason: 'ready' });
  const followed = await capture(() => main(['session', 'follow', session.id, '--exit-when-done', '--json'], session.root));
  expect(JSON.parse(followed.stdout.trim().split('\n')[0] ?? '')).toMatchObject({
    recommendations: [{ stage_id: 'one', workflow: 'implement', reason: 'ready' }],
  });
}, 30_000);

/** Blocks the call it was told to gate until the gate file exists, so a test can observe the state in between. */
class GatedClient extends ScriptedClient {
  constructor(
    responses: readonly string[],
    private readonly gated: { call: number; started: string; release: string },
  ) {
    super(responses);
  }

  protected override buildCommand(input: Parameters<ScriptedClient['runCommand']>[0]): CommandSpec {
    const spec = super.buildCommand(input);
    const call = this.calls.length - 1;
    if (call !== this.gated.call) return spec;
    const { started, release } = this.gated;
    const script = `const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(started)}, '');
      const wait = () => fs.existsSync(${JSON.stringify(release)}) ? process.stdout.write(${JSON.stringify(JSON.stringify({ call }))}) : setTimeout(wait, 20);
      wait();`;
    return { argv: [process.execPath, '-e', script] };
  }
}

async function until(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < WAIT_ATTEMPTS && !done(); attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, WAIT_MS); });
  }
  expect(done()).toBe(true);
}

test('a refresh that removes downstream hides the field at once, and the file is rebuilt empty at the next execution.finished', async () => {
  const two = `${STAGES}  - id: two\n    role: planner\n    depends_on: [one]\n    ask: human\n`;
  const question = 'status: question\n\n' + JSON.stringify({ schema_version: 1, questions: [{
    id: '1', question: 'Scope?', context: 'Needed.', selection: 'single', options: [{ id: 'A', label: 'Small' }, { id: 'B', label: 'Large' }],
  }] });
  const root = writeFakeWorkflowWorkspace({ wf: `schema_version: 8\nid: wf\n${DOWNSTREAM}${two}`, implement: TARGET });
  roots.push(root);
  const started = path.join(root, 'gate-started');
  const release = path.join(root, 'gate-release');
  const runner = new AgentToolRunner(
    registryOf({ fake: new GatedClient([reply({ workflow: 'implement', reason: 'ready' }), question, 'status: complete\n\ndone'], { call: 2, started, release }) }),
    10,
  );
  runner.pluginRegistry = createPluginRegistry();
  cliHooks.runner = runner;
  await capture(() => main(['session', 'run', '--workflow', 'wf', '--task', 'Task'], root));
  const id = readdirSync(path.join(root, '.migent/sessions'))[0] ?? '';
  const dir = path.join(root, '.migent/sessions', id);
  expect(JSON.parse((await show(root, id, '--json')).stdout)).toHaveProperty('recommendations');

  writeFileSync(path.join(root, '.migent/workflows/wf.yaml'), `schema_version: 8\nid: wf\n${two}`);
  cliHooks.runner = runner;
  const resumed = capture(() => main(['session', 'continue', id, '--reply', 'Small', '--refresh-workflow'], root));
  try {
    // The resumed stage runs against the refreshed freeze but has not finished: the old artifact is still on disk.
    await until(() => existsSync(started));
    expect(JSON.parse(readFileSync(artifactPath(dir), 'utf8')).recommendations).toHaveLength(1);
    expect(JSON.parse((await show(root, id, '--json')).stdout)).not.toHaveProperty('recommendations');
  } finally {
    writeFileSync(release, '');
  }
  expect((await resumed).value).toBe(0);
  expect(JSON.parse((await show(root, id, '--json')).stdout)).not.toHaveProperty('recommendations');
  expect(JSON.parse(readFileSync(artifactPath(dir), 'utf8'))).toEqual({ schema_version: 1, recommendations: [] });
}, 30_000);
