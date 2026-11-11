import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { type ClientRegistry,ConfigurationError } from '@nodeint/migent-kernel';
import { createAgentSession, createPreparedSession, createWorkflowSession, selectSessionWorkflow,WORKFLOW_FREEZE_FILE } from '@nodeint/migent-session';
import { expect, test } from 'vitest';
import { parse, stringify } from 'yaml';

import {
  type Check,
  type DiagnoseOptions,
  diagnoseSession,
  type SessionDiagnosis,
  sessionEffortKeys,
} from '../src/index.ts';
import { clientRegistryOf, defaultClients, tempDir, testClient, whichFound, writeStageWorkspace } from './support.ts';

const ALL = new Set(['codex', 'grok']);

function run(
  workspace: string,
  sessionId: string,
  options: Partial<DiagnoseOptions> = {},
): SessionDiagnosis {
  const selection = selectSessionWorkflow(workspace, sessionId);
  return diagnoseSession(workspace, selection, {
    clients: defaultClients(),
    which: whichFound(ALL),
    ...options,
  });
}

function check(diagnosis: SessionDiagnosis, name: string): Check {
  const found = diagnosis.checks.find((item) => item.name === name);
  if (found === undefined) throw new Error(`no ${name} check in ${diagnosis.checks.map((item) => item.name).join(',')}`);
  return found;
}

function allProblems(diagnosis: SessionDiagnosis): string {
  return diagnosis.checks.flatMap((item) => item.problems).join('\n');
}

function sessionDirectory(workspace: string, sessionId: string): string {
  return path.join(workspace, '.migent', 'sessions', sessionId);
}

function editFreeze(workspace: string, sessionId: string, edit: (body: Record<string, any>) => void): void {
  const file = path.join(sessionDirectory(workspace, sessionId), WORKFLOW_FREEZE_FILE);
  const body = parse(readFileSync(file, 'utf8')) as Record<string, any>;
  edit(body);
  writeFileSync(file, stringify(body), 'utf8');
}

function snapshot(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) visit(full);
      else files[path.relative(directory, full)] = readFileSync(full, 'utf8');
    }
  };
  visit(directory);
  return files;
}

test('a valid prepared draft passes and identifies its source', () => {
  const workspace = writeStageWorkspace();
  const sessionId = createPreparedSession(workspace, { title: 'wave', workflowId: 'plan-implement' });
  const diagnosis = run(workspace, sessionId);
  expect(diagnosis.ok).toBe(true);
  expect(diagnosis.source).toEqual({
    sessionId,
    workflowId: 'plan-implement',
    kind: 'draft',
    path: `.migent/sessions/${sessionId}/workflow.yaml`,
  });
  expect(check(diagnosis, 'session').items).toContain(`source  draft  .migent/sessions/${sessionId}/workflow.yaml`);
  expect(check(diagnosis, 'clients').items).toEqual(['codex  /bin/codex', 'grok  /bin/grok']);
  expect(check(diagnosis, 'bindings').items).toEqual([
    'implement  grok  grok-4.6',
    'review-work  codex  gpt-5.6-terra',
  ]);
});

test('a broken edited draft fails while the project workflow stays valid', () => {
  const workspace = writeStageWorkspace();
  const sessionId = createPreparedSession(workspace, { title: 'wave', workflowId: 'plan-implement' });
  const draft = path.join(sessionDirectory(workspace, sessionId), 'workflow.yaml');
  writeFileSync(draft, readFileSync(draft, 'utf8').replace('- implement', '- missing-stage'), 'utf8');
  const diagnosis = run(workspace, sessionId);
  expect(diagnosis.ok).toBe(false);
  expect(check(diagnosis, 'session').ok).toBe(false);
  expect(allProblems(diagnosis)).toContain('missing-stage');
  expect(diagnosis.source?.kind).toBe('draft');
});

test('a draft with an unknown role or model, bad options, or a missing executable names the stage', () => {
  const workspace = writeStageWorkspace();
  const sessionId = createPreparedSession(workspace, { title: 'wave', workflowId: 'plan-implement' });
  const draft = path.join(sessionDirectory(workspace, sessionId), 'workflow.yaml');
  const original = readFileSync(draft, 'utf8');
  writeFileSync(draft, original.replace('role: developer', 'role: ghost'), 'utf8');
  expect(allProblems(run(workspace, sessionId))).toContain('plan-implement.implement: Missing or invalid roles.ghost.');
  writeFileSync(draft, original.replace(
    '    role: developer\n',
    '    role: developer\n    agent:\n      client:\n        type: grok\n        options:\n          bogus: x\n      model: grok-4.6\n',
  ), 'utf8');
  expect(allProblems(run(workspace, sessionId)))
    .toMatch(/plan-implement\.implement: stages\.implement\.agent\.client\.options: .*bogus/);
  writeFileSync(draft, original, 'utf8');
  const missing = run(workspace, sessionId, { which: whichFound(new Set(['codex'])) });
  expect(missing.ok).toBe(false);
  expect(check(missing, 'clients').problems).toEqual(['grok is not on PATH (stages: implement)']);
});

test('an empty draft is rejected', () => {
  const workspace = writeStageWorkspace();
  const sessionId = createPreparedSession(workspace, { title: 'wave', workflowId: 'plan-implement' });
  writeFileSync(path.join(sessionDirectory(workspace, sessionId), 'workflow.yaml'), 'id: plan-implement\nstages: []\n', 'utf8');
  const diagnosis = run(workspace, sessionId);
  expect(diagnosis.ok).toBe(false);
  expect(allProblems(diagnosis)).toMatch(/no stages|stages/);
});

test('a changed id in the prepared draft is diagnosed', () => {
  const workspace = writeStageWorkspace();
  const sessionId = createPreparedSession(workspace, { title: 'wave', workflowId: 'plan-implement' });
  const draft = path.join(sessionDirectory(workspace, sessionId), 'workflow.yaml');
  writeFileSync(draft, readFileSync(draft, 'utf8').replace('id: plan-implement', 'id: renamed'), 'utf8');
  const diagnosis = run(workspace, sessionId);
  expect(diagnosis.ok).toBe(false);
  expect(allProblems(diagnosis)).toContain('Session workflow id is renamed, not plan-implement. Do not change id in workflow.yaml.');
});

test('a draft reports unknown keys as warnings without failing', () => {
  const workspace = writeStageWorkspace();
  const sessionId = createPreparedSession(workspace, { title: 'wave', workflowId: 'plan-implement' });
  const draft = path.join(sessionDirectory(workspace, sessionId), 'workflow.yaml');
  writeFileSync(draft, 'schema_version: 4\nid: plan-implement\nextra_note: 1\nstages:\n  - id: implement\n    role: developer\n    depends_on: []\n', 'utf8');
  const diagnosis = run(workspace, sessionId);
  expect(diagnosis.ok).toBe(true);
  expect(check(diagnosis, 'workflow').warnings.join('\n')).toContain(`.migent/sessions/${sessionId}/workflow.yaml`);
});

test('a valid freeze stays valid after the live workflow and config are removed', () => {
  const workspace = writeStageWorkspace();
  const sessionId = createWorkflowSession(workspace, 'plan-implement', { task: 'do it' });
  rmSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  rmSync(path.join(workspace, '.migent', 'config.yaml'));
  const diagnosis = run(workspace, sessionId);
  expect(diagnosis.ok).toBe(true);
  expect(diagnosis.source?.kind).toBe('frozen');
  expect(diagnosis.source?.path).toBe(`.migent/sessions/${sessionId}/${WORKFLOW_FREEZE_FILE}`);
  expect(check(diagnosis, 'bindings').items).toEqual(['implement  grok  grok-4.6', 'review-work  codex  gpt-5.6-terra']);
  expect(check(diagnosis, 'workflow').warnings.join('\n')).toContain('The workflow file is missing.');
});

test('a frozen session ignores unrelated invalid workspace workflows and config entries', () => {
  const workspace = writeStageWorkspace();
  const sessionId = createWorkflowSession(workspace, 'plan-implement', { task: 'do it' });
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'other.yaml'), 'id: other\nstages: nope\n', 'utf8');
  const configPath = path.join(workspace, '.migent', 'config.yaml');
  writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}  stray:\n    agent: nothing\n`, 'utf8');
  const diagnosis = run(workspace, sessionId);
  expect(diagnosis.ok).toBe(true);
});

test('drift between the freeze and live files is a warning only', () => {
  const workspace = writeStageWorkspace();
  const sessionId = createWorkflowSession(workspace, 'plan-implement', { task: 'do it' });
  const live = path.join(workspace, '.migent', 'workflows', 'plan-implement.yaml');
  writeFileSync(live, `${readFileSync(live, 'utf8')}# edit\n`, 'utf8');
  const configPath = path.join(workspace, '.migent', 'config.yaml');
  writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('grok-4.6', 'grok-9'), 'utf8');
  const diagnosis = run(workspace, sessionId);
  expect(diagnosis.ok).toBe(true);
  const warnings = check(diagnosis, 'workflow').warnings.join('\n');
  expect(warnings).toContain('The workflow file differs.');
  expect(warnings).toContain('Stage implement model differs.');
  expect(check(diagnosis, 'bindings').items[0]).toBe('implement  grok  grok-4.6');
});

test('corrupt freeze YAML fails and does not fall back to the live source', () => {
  const workspace = writeStageWorkspace();
  const sessionId = createWorkflowSession(workspace, 'plan-implement', { task: 'do it' });
  const freeze = path.join(sessionDirectory(workspace, sessionId), WORKFLOW_FREEZE_FILE);
  writeFileSync(freeze, 'workflow: [unclosed\n', 'utf8');
  const diagnosis = run(workspace, sessionId);
  expect(diagnosis.ok).toBe(false);
  expect(diagnosis.source?.kind).toBe('frozen');
  expect(allProblems(diagnosis)).toContain('Workflow freeze is corrupt:');
  expect(allProblems(diagnosis)).toContain(WORKFLOW_FREEZE_FILE);
});

test('a freeze missing a pinned role or target is diagnosed per stage', () => {
  const workspace = writeStageWorkspace();
  const sessionId = createWorkflowSession(workspace, 'plan-implement', { task: 'do it' });
  editFreeze(workspace, sessionId, (body) => {
    delete body.roles.developer;
    delete body.targets['review-work'];
  });
  const problems = allProblems(run(workspace, sessionId));
  expect(problems).toContain('plan-implement.implement: workflow.frozen.yaml pins no instructions for role developer.');
  expect(problems).toContain('plan-implement.review-work: workflow.frozen.yaml pins no target for stage review-work.');
});

test('frozen targets with an unsupported client or option are diagnosed', () => {
  const workspace = writeStageWorkspace();
  const sessionId = createWorkflowSession(workspace, 'plan-implement', { task: 'do it' });
  editFreeze(workspace, sessionId, (body) => {
    body.targets.implement.client = 'nope';
    body.targets['review-work'].options = { 'not-an-option': '' };
  });
  const problems = allProblems(run(workspace, sessionId));
  expect(problems).toContain('plan-implement.implement: targets.implement.client is not supported: Unknown CLI client: nope');
  expect(problems).toMatch(/plan-implement\.review-work: targets\.review-work\.options: .*not-an-option/);
  editFreeze(workspace, sessionId, (body) => {
    body.targets.implement.client = 'grok';
    body.targets['review-work'].options = {};
    body.targets.implement.options = { 'not-an-option': '' };
  });
  expect(allProblems(run(workspace, sessionId)))
    .toMatch(/plan-implement\.implement: targets\.implement\.options: .*not-an-option/);
});

test("a frozen target's missing executable is reported with its stage", () => {
  const workspace = writeStageWorkspace();
  const sessionId = createWorkflowSession(workspace, 'plan-implement', { task: 'do it' });
  const diagnosis = run(workspace, sessionId, { which: whichFound(new Set(['grok'])) });
  expect(diagnosis.ok).toBe(false);
  expect(check(diagnosis, 'clients').problems).toEqual(['codex is not on PATH (stages: review-work)']);
  expect(check(diagnosis, 'clients').items).toEqual(['grok  /bin/grok']);
});

test('a frozen session pinned from an older workflow schema is accepted', () => {
  const workspace = writeStageWorkspace();
  const sessionId = createWorkflowSession(workspace, 'plan-implement', { task: 'do it' });
  editFreeze(workspace, sessionId, (body) => {
    body.workflow = {
      schema_version: 1,
      id: 'plan-implement',
      stages: [
        { id: 'implement', role: 'developer', depends_on: [] },
        { id: 'review-work', role: 'reviewer', depends_on: ['implement'] },
      ],
      completion: { stage: 'review-work' },
    };
  });
  const diagnosis = run(workspace, sessionId);
  expect(diagnosis.ok).toBe(true);
});

test('a session without a freeze uses its recorded live source', () => {
  const workspace = writeStageWorkspace();
  const sessionId = createWorkflowSession(workspace, 'plan-implement', { task: 'do it' });
  rmSync(path.join(sessionDirectory(workspace, sessionId), WORKFLOW_FREEZE_FILE));
  const diagnosis = run(workspace, sessionId);
  expect(diagnosis.ok).toBe(true);
  expect(diagnosis.source).toMatchObject({ kind: 'live', path: '.migent/workflows/plan-implement.yaml' });
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'plan-implement.yaml'), 'id: plan-implement\nstages: nope\n', 'utf8');
  expect(run(workspace, sessionId).ok).toBe(false);
});

test('a freeze-less session whose recorded file is gone falls back to the workflow id', () => {
  const workspace = writeStageWorkspace();
  const sessionId = createWorkflowSession(workspace, 'plan-implement', { task: 'do it' });
  rmSync(path.join(sessionDirectory(workspace, sessionId), WORKFLOW_FREEZE_FILE));
  const manifest = path.join(sessionDirectory(workspace, sessionId), 'manifest.yaml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/workflow_path: .*/, 'workflow_path: .migent/workflows/gone.yaml'), 'utf8');
  const diagnosis = run(workspace, sessionId);
  expect(diagnosis.ok).toBe(true);
  expect(check(diagnosis, 'session').warnings.join('\n')).toContain('gone.yaml is missing');
});

test('an invalid session id throws and unknown, role, and metadata problems are diagnosed', () => {
  const workspace = writeStageWorkspace();
  for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', path.resolve(workspace)]) {
    expect(() => selectSessionWorkflow(workspace, bad)).toThrow(ConfigurationError);
  }
  const unknown = run(workspace, 'nope');
  expect(unknown.ok).toBe(false);
  expect(allProblems(unknown)).toBe('Session not found: nope.');

  const roleId = createAgentSession(workspace, 'reviewer', 'Think');
  expect(allProblems(run(workspace, roleId))).toBe(`Session ${roleId} is a role session; it has no workflow to validate.`);

  const sessionId = createPreparedSession(workspace, { title: 'wave', workflowId: 'plan-implement' });
  const manifest = path.join(sessionDirectory(workspace, sessionId), 'manifest.yaml');
  const original = readFileSync(manifest, 'utf8');
  writeFileSync(manifest, '- just\n- a list\n', 'utf8');
  expect(allProblems(run(workspace, sessionId))).toContain('Session manifest is corrupt');
  writeFileSync(manifest, 'session_id: x\ntitle: t\n', 'utf8');
  expect(allProblems(run(workspace, sessionId))).toContain('names no workflow');
  rmSync(manifest);
  expect(allProblems(run(workspace, sessionId))).toContain('Session manifest is missing');
  writeFileSync(manifest, original, 'utf8');
  rmSync(path.join(sessionDirectory(workspace, sessionId), 'workflow.yaml'));
  const missing = run(workspace, sessionId);
  expect(missing.ok).toBe(false);
  expect(allProblems(missing)).toContain('Unable to read workflow');
});

const VERIFY_ONLY = `\
schema_version: 7
id: checks
stages:
  - id: gate
    description: Check the tree.
    verify:
      - "true"
    depends_on: []
`;

test('verify-only workflows need no role, model, or executable', () => {
  const workspace = tempDir('migent-doctor-session-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), 'roles:\n  x:\n    agent: nothing\n', 'utf8');
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'checks.yaml'), VERIFY_ONLY, 'utf8');
  const draftId = createPreparedSession(workspace, { title: 'wave', workflowId: 'checks' });
  const calls: string[] = [];
  const draft = run(workspace, draftId, { which: (command) => { calls.push(command); return null; } });
  expect(draft.ok).toBe(true);
  expect(check(draft, 'clients').items).toEqual([]);
  expect(calls).toEqual([]);

  const frozenId = createWorkflowSession(workspace, 'checks', { task: 'go' });
  rmSync(path.join(workspace, '.migent', 'config.yaml'));
  const frozen = run(workspace, frozenId);
  expect(frozen.ok).toBe(true);
  expect(check(frozen, 'bindings').items).toEqual([]);
});

function namedClients(): ClientRegistry {
  return clientRegistryOf({
    alpha: testClient('alpha', 'alpha-cli'),
    beta: testClient('beta', 'beta-cli'),
  });
}

test('distinct clients are checked as distinct executables', () => {
  const workspace = tempDir('migent-doctor-session-');
  mkdirSync(path.join(workspace, '.migent', 'workflows'), { recursive: true });
  writeFileSync(
    path.join(workspace, '.migent', 'config.yaml'),
    `\
schema_version: 7
agents:
  a:
    client:
      type: alpha
    model: m1
  b:
    client:
      type: beta
    model: m2
roles:
  developer:
    agent: a
  reviewer:
    agent: b
`,
    'utf8',
  );
  writeFileSync(
    path.join(workspace, '.migent', 'workflows', 'two.yaml'),
    'schema_version: 7\nid: two\nstages:\n  - id: one\n    role: developer\n    depends_on: []\n  - id: two\n    role: reviewer\n    depends_on: [one]\n',
    'utf8',
  );
  const draftId = createPreparedSession(workspace, { title: 'wave', workflowId: 'two', priorSessionId: null });
  const found = run(workspace, draftId, { clients: namedClients(), which: whichFound(new Set(['alpha-cli'])) });
  expect(check(found, 'clients').items).toEqual(['alpha  /bin/alpha-cli']);
  expect(check(found, 'clients').problems).toEqual(['beta-cli is not on PATH (stages: two)']);
  const frozenId = createWorkflowSession(workspace, 'two', { task: 'go' });
  const frozen = run(workspace, frozenId, { clients: namedClients(), which: whichFound(new Set(['alpha-cli', 'beta-cli'])) });
  expect(frozen.ok).toBe(true);
  expect(check(frozen, 'clients').items).toEqual(['alpha  /bin/alpha-cli', 'beta  /bin/beta-cli']);
});

test('effort problems and warnings are scoped to the models the session uses', () => {
  const workspace = writeStageWorkspace();
  const sessionId = createPreparedSession(workspace, { title: 'wave', workflowId: 'plan-implement' });
  const selection = selectSessionWorkflow(workspace, sessionId);
  expect([...sessionEffortKeys(workspace, selection)].sort()).toEqual(['gpt-terra', 'grok']);
  const diagnosis = run(workspace, sessionId, {
    modelEffortChecks: { grok: { problem: 'Invalid agents.grok.effort: "x"' }, 'gpt-terra': { warning: 'Could not validate' } },
  });
  expect(diagnosis.ok).toBe(false);
  expect(allProblems(diagnosis)).toContain('plan-implement.implement: Invalid agents.grok.effort');
  expect(check(diagnosis, 'bindings').warnings).toEqual(['Could not validate']);
  const frozenId = createWorkflowSession(workspace, 'plan-implement', { task: 'go' });
  expect(sessionEffortKeys(workspace, selectSessionWorkflow(workspace, frozenId)).size).toBe(0);
});

test("model availability problems and warnings are scoped to the session's models", () => {
  const workspace = writeStageWorkspace();
  const sessionId = createPreparedSession(workspace, { title: 'wave', workflowId: 'plan-implement' });
  const diagnosis = run(workspace, sessionId, {
    modelEffortChecks: {
      grok: { problem: 'Invalid agents.grok.model: "grok-4x"\nUnknown model: grok-4x.' },
      'gpt-terra': { warning: 'Could not validate agents.gpt-terra.model: "gpt-5"' },
      unused: { problem: 'Invalid agents.unused.model: "x"' },
    },
  });
  expect(diagnosis.ok).toBe(false);
  expect(allProblems(diagnosis)).toContain('plan-implement.implement: Invalid agents.grok.model');
  expect(allProblems(diagnosis)).not.toContain('unused');
  expect(check(diagnosis, 'bindings').warnings).toEqual(['Could not validate agents.gpt-terra.model: "gpt-5"']);
  const warned = run(workspace, sessionId, { modelEffortChecks: { grok: { warning: 'Could not validate agents.grok.model: "grok-4"' } } });
  expect(warned.ok).toBe(true);
});

test('session diagnosis writes nothing', () => {
  const workspace = writeStageWorkspace();
  const draftId = createPreparedSession(workspace, { title: 'wave', workflowId: 'plan-implement' });
  const frozenId = createWorkflowSession(workspace, 'plan-implement', { task: 'go' });
  const legacyId = createWorkflowSession(workspace, 'plan-implement', { task: 'old' });
  rmSync(path.join(sessionDirectory(workspace, legacyId), WORKFLOW_FREEZE_FILE));
  const before = snapshot(path.join(workspace, '.migent'));
  for (const id of [draftId, frozenId, legacyId]) run(workspace, id);
  expect(snapshot(path.join(workspace, '.migent'))).toEqual(before);
});

test('a stale freeze on a prepared session does not hide a broken draft', () => {
  const workspace = writeStageWorkspace();
  const sessionId = createPreparedSession(workspace, { title: 'wave', workflowId: 'plan-implement' });
  const directory = sessionDirectory(workspace, sessionId);
  const draft = path.join(directory, 'workflow.yaml');
  // A freeze from an interrupted activation: the status is still prepared.
  const other = createWorkflowSession(workspace, 'plan-implement', { task: 'x' });
  writeFileSync(path.join(directory, WORKFLOW_FREEZE_FILE), readFileSync(path.join(sessionDirectory(workspace, other), WORKFLOW_FREEZE_FILE), 'utf8'), 'utf8');
  writeFileSync(draft, readFileSync(draft, 'utf8').replace('- implement', '- missing-stage'), 'utf8');
  const diagnosis = run(workspace, sessionId);
  expect(diagnosis.ok).toBe(false);
  expect(diagnosis.source?.kind).toBe('draft');
  expect(allProblems(diagnosis)).toContain('missing-stage');
  expect(check(diagnosis, 'session').warnings.join('\n')).toContain('interrupted start');
});

test('malformed pinned clients are diagnosed', () => {
  const workspace = writeStageWorkspace();
  const sessionId = createWorkflowSession(workspace, 'plan-implement', { task: 'do it' });
  editFreeze(workspace, sessionId, (body) => {
    body.targets.implement.client = 42;
  });
  const corrupt = run(workspace, sessionId);
  expect(corrupt.ok).toBe(false);
  expect(allProblems(corrupt)).toContain(WORKFLOW_FREEZE_FILE);
  expect(allProblems(corrupt)).toContain('targets.implement must name a client and model');
  for (const client of ['', '  ']) {
    editFreeze(workspace, sessionId, (body) => {
      body.targets.implement.client = client;
    });
    const diagnosis = run(workspace, sessionId);
    expect(diagnosis.ok).toBe(false);
    expect(allProblems(diagnosis)).toContain('targets.implement.client is required');
  }
});
