import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { diagnose, validateConfigLayers } from '../src/index.ts';
import { defaultClients, STAGE_CONFIG, STAGE_WORKFLOW, tempDir, whichFound } from './support.ts';

test('reports roles, workflows, and client paths', () => {
  const workspace = tempDir('migent-doctor-');
  writeStageProject(workspace);
  const [config, workflows, clients] = diagnose(workspace, {
    clients: defaultClients(),
    which: whichFound(new Set(['codex', 'grok'])),
  });
  expect(config.ok).toBe(true);
  expect(config.items).toEqual(['developer', 'reviewer']);
  expect(workflows.ok).toBe(true);
  expect(workflows.items).toEqual(['plan-implement']);
  expect(clients.ok).toBe(true);
  expect(clients.items).toEqual(['codex  /bin/codex', 'grok  /bin/grok']);
});

test('rejects an unsupported client without checking its command', () => {
  const calls: string[] = [];
  const which = (command: string): string | null => {
    calls.push(command);
    return `/bin/${command}`;
  };
  const workspace = tempDir('migent-doctor-');
  writeStageProject(workspace);
  const configPath = path.join(workspace, '.migent', 'config.yaml');
  writeFileSync(
    configPath,
    readFileSync(configPath, 'utf8').replace('      type: grok\n', '      type: claude\n'),
    'utf8',
  );
  const [config, , clients] = diagnose(workspace, {
    clients: defaultClients(),
    which,
  });
  expect(config.ok).toBe(false);
  expect(config.problems).toContain('agents.grok.client.type is not supported: Unknown CLI client: claude');
  expect(calls).toEqual(['codex']);
  expect(clients.ok).toBe(true);
  expect(clients.items).toEqual(['codex  /bin/codex']);
});

test('rejects role instructions that are not a list', () => {
  const workspace = tempDir('migent-doctor-');
  writeStageProject(workspace);
  const configPath = path.join(workspace, '.migent', 'config.yaml');
  writeFileSync(
    configPath,
    readFileSync(configPath, 'utf8').replace(
      '  developer:\n    agent: grok\n',
      '  developer:\n    agent: grok\n    responsibilities: nope\n',
    ),
  );
  const [config] = diagnose(workspace, {
    clients: defaultClients(),
    which: whichFound(new Set(['codex', 'grok'])),
  });
  expect(config.ok).toBe(false);
  expect(config.problems).toContain('roles.developer.responsibilities must be a list.');
});

test('reports a missing client command', () => {
  const workspace = tempDir('migent-doctor-');
  writeStageProject(workspace);
  const [, , clients] = diagnose(workspace, {
    clients: defaultClients(),
    which: whichFound(new Set(['codex'])),
  });
  expect(clients.ok).toBe(false);
  expect(clients.problems).toEqual(['grok is not on PATH']);
  expect(clients.items).toEqual(['codex  /bin/codex']);
});

test('reports a workflow role and a requires mismatch', () => {
  const workspace = tempDir('migent-doctor-');
  writeStageProject(workspace);
  const workflowsDir = path.join(workspace, '.migent', 'workflows');
  writeFileSync(
    path.join(workflowsDir, 'plan.yaml'),
    'id: plan\n' +
      'stages:\n' +
      '  - id: plan\n' +
      '    role: missing-role\n' +
      'completion:\n' +
      '  stage: plan\n' +
      '  decision: revise\n',
    'utf8',
  );
  writeFileSync(
    path.join(workflowsDir, 'follow-on.yaml'),
    'id: follow-on\n' +
      'requires:\n' +
      '  workflow: plan\n' +
      '  decision: approved\n' +
      'stages:\n' +
      '  - id: implement\n' +
      '    role: developer\n',
    'utf8',
  );
  writeFileSync(path.join(workflowsDir, 'notes.txt'), 'ignore', 'utf8');
  const [config, workflows] = diagnose(workspace, {
    clients: defaultClients(),
    which: whichFound(new Set(['codex', 'grok'])),
  });
  expect(config.ok).toBe(true);
  expect(workflows.ok).toBe(false);
  expect(workflows.items).toContain('plan-implement');
  expect(workflows.items).not.toContain('plan');
  expect(workflows.items).not.toContain('follow-on');
  expect(workflows.problems).toContain('plan.plan: Missing or invalid roles.missing-role.');
  expect(workflows.problems).toContain(
    'follow-on: requires plan to complete with approved, but it completes with revise.',
  );
});

test('accepts a file whose id differs from its name', () => {
  const workspace = tempDir('migent-doctor-');
  writeStageProject(workspace);
  writeFileSync(
    path.join(workspace, '.migent', 'workflows', 'plan-implement.yaml'),
    'id: other\nstages:\n  - id: implement\n    role: developer\n',
    'utf8',
  );
  const [, workflows] = diagnose(workspace, {
    clients: defaultClients(),
    which: whichFound(new Set(['codex', 'grok'])),
  });
  expect(workflows.ok).toBe(true);
  expect(workflows.problems).toEqual([]);
  expect(workflows.items).toEqual(['other']);
});

test('reports invalid config and an unreadable workflow together', () => {
  const workspace = tempDir('migent-doctor-');
  const workflows = path.join(workspace, '.migent', 'workflows');
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), '- not-a-map\n', 'utf8');
  writeFileSync(path.join(workflows, 'broken.yaml'), 'stages: [\n', 'utf8');
  const [config, workflowCheck, clients] = diagnose(workspace, {
    clients: defaultClients(),
    which: whichFound(new Set(['grok'])),
  });
  expect(config.ok).toBe(false);
  expect(config.problems).toContain('Invalid configuration: expected a mapping.');
  expect(workflowCheck.ok).toBe(false);
  expect(workflowCheck.problems.length).toBeGreaterThan(0);
  expect(clients.ok).toBe(false);
  expect(clients.problems).toEqual(['No clients could be resolved from config.']);
});

test('reports an option the client rejects', () => {
  const workspace = tempDir('migent-doctor-');
  writeStageProject(workspace);
  const configPath = path.join(workspace, '.migent', 'config.yaml');
  writeFileSync(
    configPath,
    readFileSync(configPath, 'utf8').replace(
      '        reasoning-effort: high\n',
      '        reasoning-effort: high\n        nope: "1"\n',
    ),
    'utf8',
  );
  const [config, workflows] = diagnose(workspace, {
    clients: defaultClients(),
    which: whichFound(new Set(['codex', 'grok'])),
  });
  expect(config.ok).toBe(false);
  expect(config.problems).toContain('agents.grok.client.options: nope is not a grok option.');
  expect(config.problems).toContain('roles.developer: nope is not a grok option.');
  expect(workflows.ok).toBe(true);
});

test('does not reject an unlisted effort value', () => {
  const workspace = tempDir('migent-doctor-');
  writeStageProject(workspace);
  const workflow = path.join(workspace, '.migent', 'workflows', 'plan-implement.yaml');
  writeFileSync(
    workflow,
    STAGE_WORKFLOW.replace(
      '  - id: review-work\n    role: reviewer\n    agent: gpt-terra\n',
      '  - id: review-work\n    role: reviewer\n    agent:\n      client:\n        type: codex\n      model: gpt-5.6-terra\n      effort: banana\n',
    ),
    'utf8',
  );
  const [config, workflows] = diagnose(workspace, {
    clients: defaultClients(),
    which: whichFound(new Set(['codex', 'grok'])),
  });
  expect(config.ok).toBe(true);
  expect(workflows.ok).toBe(true);
});

test('reports a missing workflows directory', () => {
  const workspace = tempDir('migent-doctor-');
  mkdirSync(path.join(workspace, '.migent'));
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), STAGE_CONFIG, 'utf8');
  const [, workflows] = diagnose(workspace, {
    clients: defaultClients(),
    which: whichFound(new Set(['codex', 'grok'])),
  });
  expect(workflows.ok).toBe(false);
  expect(workflows.problems).toEqual(['Workflows directory not found: .migent/workflows']);
});

function writeStageProject(workspace: string): void {
  const workflows = path.join(workspace, '.migent', 'workflows');
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), STAGE_CONFIG, 'utf8');
  writeFileSync(path.join(workflows, 'plan-implement.yaml'), STAGE_WORKFLOW, 'utf8');
}

test('reports a verify stage that is not on every path to complete', () => {
  const workspace = tempDir('migent-doctor-');
  const workflows = path.join(workspace, '.migent', 'workflows');
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workspace, '.migent', 'config.yaml'), STAGE_CONFIG, 'utf8');
  writeFileSync(
    path.join(workflows, 'skip.yaml'),
    'id: skip\nstages:\n  - id: a\n    role: developer\n    verify: x\n  - id: b\n    role: developer\ncompletion:\n  stage: b\n',
    'utf8',
  );
  const [, report] = diagnose(workspace, {
    clients: defaultClients(),
    which: whichFound(new Set(['codex', 'grok'])),
  });
  expect(report.ok).toBe(false);
  expect(report.problems.join('\n')).toContain('stages.a.verify is not on every path to complete');
});

test('warns when config.local.yaml is tracked by git, without failing', () => {
  const workspace = tempDir('migent-doctor-');
  writeStageProject(workspace);
  const local = path.join(workspace, '.migent', 'config.local.yaml');
  writeFileSync(local, 'agents:\n  grok:\n    model: grok-local\n', 'utf8');
  const options = { clients: defaultClients(), which: whichFound(new Set(['codex', 'grok'])) };

  const [outside] = diagnose(workspace, options);
  expect(outside.warnings).toEqual([]);

  execFileSync('git', ['init', '-q'], { cwd: workspace });
  expect(diagnose(workspace, options)[0].warnings).toEqual([]);

  execFileSync('git', ['add', '.migent/config.local.yaml'], { cwd: workspace });
  const [tracked] = diagnose(workspace, options);
  expect(tracked.ok).toBe(true);
  expect(tracked.warnings).toEqual([
    '.migent/config.local.yaml is tracked by git; run git rm --cached .migent/config.local.yaml and keep it ignored.',
  ]);
});

test('validates the merged config', () => {
  const workspace = tempDir('migent-doctor-');
  writeStageProject(workspace);
  writeFileSync(
    path.join(workspace, '.migent', 'config.local.yaml'),
    'agents:\n  grok:\n    client:\n      type: nope\n',
    'utf8',
  );
  const [config] = diagnose(workspace, {
    clients: defaultClients(),
    which: whichFound(new Set(['codex', 'grok'])),
  });
  expect(config.ok).toBe(false);
  expect(config.problems).toContain('agents.grok.client.type is not supported: Unknown CLI client: nope');
});

test('names each alias that has no local mapping and how to add it', () => {
  const workspace = tempDir('migent-doctor-');
  writeStageProject(workspace);
  const configPath = path.join(workspace, '.migent', 'config.yaml');
  writeFileSync(
    configPath,
    readFileSync(configPath, 'utf8').replace(/agents:[\s\S]*?\nroles:/, 'agents:\n  grok: {}\n  gpt-terra: {}\nroles:'),
    'utf8',
  );
  const [config, workflows] = diagnose(workspace, {
    clients: defaultClients(),
    which: whichFound(new Set(['codex', 'grok'])),
  });
  expect(config.ok).toBe(false);
  expect(config.problems).toHaveLength(1);
  expect(config.problems[0]).toContain('agents.gpt-terra, agents.grok have no client and model on this machine.');
  expect(config.problems[0]).toContain('.migent/config.local.yaml');
  expect(config.problems[0]).toContain('  gpt-terra:\n    client:\n      type: <client>\n    model: <model>');
  expect(workflows.problems).toEqual([]);

  writeFileSync(
    path.join(workspace, '.migent', 'config.local.yaml'),
    'agents:\n  grok:\n    client:\n      type: grok\n    model: grok-4\n  gpt-terra:\n    client:\n      type: codex\n    model: gpt-5\n',
    'utf8',
  );
  const [fixed] = diagnose(workspace, {
    clients: defaultClients(),
    which: whichFound(new Set(['codex', 'grok'])),
  });
  expect(fixed.ok).toBe(true);
});

test('warns about unused workflow keys without warning on decision guidance', () => {
  const workspace = tempDir('migent-doctor-');
  writeStageProject(workspace);
  writeFileSync(path.join(workspace, '.migent', 'workflows', 'plan-implement.yaml'), [
    'schema_version: 4',
    'id: plan-implement',
    'stages:',
    '  - id: build',
    '    role: developer',
    '    depends_on: []',
    '    instrutions:',
    '      - Build it.',
    '    produces:',
    '      artifact: build.md',
    '      description: What the build contains.',
    '  - id: review',
    '    role: reviewer',
    '    depends_on: [build]',
    '    decision:',
    '      - approved:',
    '          when: Choose approved according to the stage instructions.',
    '          navigate: complete',
    '      - revise:',
    '          when: A required fix remains.',
    '          navigate: build',
    '',
  ].join('\n'), 'utf8');
  const [, workflows] = diagnose(workspace, { clients: defaultClients(), which: whichFound(new Set(['codex', 'grok'])) });
  expect(workflows.ok).toBe(true);
  const text = workflows.warnings.join('\n');
  expect(text).toContain('plan-implement.yaml: stages.build.instrutions is not used by Migent. Did you mean stages.build.instructions?');
  expect(text).toContain('stages.build.produces.description is not used by Migent.');
  expect(text).not.toContain('decision.approved');
  expect(text).not.toContain('decision.revise');
});

test('a model availability problem fails doctor and a warning does not', () => {
  const workspace = tempDir('migent-doctor-');
  writeStageProject(workspace);
  const options = { clients: defaultClients(), which: whichFound(new Set(['codex', 'grok'])) };
  const problem = 'Invalid agents.grok.model: "grok-4x"\nUnknown model: grok-4x.\nDid you mean: grok-4';
  const [failed] = diagnose(workspace, { ...options, modelEffortChecks: { grok: { problem } } });
  expect(failed.ok).toBe(false);
  expect(failed.problems).toContain(problem);
  const warning = 'Could not validate agents.grok.model: "grok-4"\ngrok is not on PATH';
  const [warned] = diagnose(workspace, { ...options, modelEffortChecks: { 'gpt-terra': { warning } } });
  expect(warned.ok).toBe(true);
  expect(warned.warnings).toContain(warning);
});

test('an unmapped alias reports only the no-mapping message, not a model check', () => {
  const workspace = tempDir('migent-doctor-');
  writeStageProject(workspace);
  const configPath = path.join(workspace, '.migent', 'config.yaml');
  writeFileSync(
    configPath,
    readFileSync(configPath, 'utf8').replace(/agents:[\s\S]*?\nroles:/, 'agents:\n  grok: {}\n  gpt-terra: {}\nroles:'),
    'utf8',
  );
  const [config] = diagnose(workspace, {
    clients: defaultClients(),
    which: whichFound(new Set(['codex', 'grok'])),
    modelEffortChecks: { grok: { problem: 'Invalid agents.grok.model: "x"', warning: 'Could not validate agents.grok.model: "x"' } },
  });
  expect(config.problems).toHaveLength(1);
  expect(config.problems[0]).toContain('have no client and model on this machine.');
  expect(config.warnings.join('\n')).not.toContain('Could not validate');
});

test('static validation merges layers like the runtime and reports every problem', () => {
  const clients = defaultClients();
  const diagnostics = validateConfigLayers(
    {
      project: { agents: { x: {} }, roles: { dev: { agent: 'x' }, qa: { agent: 'missing', extra: 1 } } },
      local: { agents: { x: { client: { type: 'nope' }, model: 'm' } } },
    },
    clients,
  );
  const errors = diagnostics.filter((item) => item.severity === 'error');
  expect(errors.map((item) => item.message)).toEqual([
    'agents.x.client.type is not supported: Unknown CLI client: nope',
    'roles.dev.client.type is not supported: Unknown CLI client: nope',
    'roles.qa.agent: unknown agent "missing" in agents.',
  ]);
  expect(errors[0]!.source).toEqual({ layer: 'local' });
  expect(errors[1]!.source).toEqual({ layer: 'project' });
  expect(errors[2]!.source).toEqual({ layer: 'project' });
  expect(diagnostics.some((item) => item.severity === 'warning' && item.path?.join('.') === 'roles.qa.extra')).toBe(true);
});

test('static validation accepts a project that only needs a local mapping', () => {
  const diagnostics = validateConfigLayers(
    { project: { agents: { x: {} }, roles: { dev: { agent: 'x' } } } },
    defaultClients(),
  );
  expect(diagnostics.filter((item) => item.code !== 'agent-unmapped')).toEqual([]);
});

test('an invalid model option is reported once, however many roles use the model', () => {
  const diagnostics = validateConfigLayers(
    {
      project: {
        agents: { x: { client: { type: 'codex', options: { a: { deep: 1 } } }, model: 'm' } },
        roles: { dev: { agent: 'x' }, qa: { agent: 'x' } },
      },
    },
    defaultClients(),
  );
  const errors = diagnostics.filter((item) => item.severity === 'error');
  expect(errors.map((item) => item.message)).toEqual(['Missing or invalid agents.x.client.options.a: expected a non-blank string, a number or a boolean.']);
  expect(errors[0]!.path).toEqual(['agents', 'x', 'client', 'options', 'a']);
});

test('a project-owned bad client on a dotted alias is not attributed to the merge', () => {
  const diagnostics = validateConfigLayers(
    { project: { agents: { 'gpt.5': { client: { type: 'nope' } } }, roles: { dev: { agent: 'gpt.5' } } }, local: { agents: { 'gpt.5': { model: 'm' } } } },
    defaultClients(),
  );
  const error = diagnostics.find((item) => item.code === 'client-unsupported');
  expect(error?.path).toEqual(['agents', 'gpt.5', 'client', 'type']);
  expect(error?.source).toEqual({ layer: 'project' });
});

test('an unknown role key containing a dot keeps its whole name in the path', () => {
  const diagnostics = validateConfigLayers(
    { project: { agents: { x: { client: { type: 'codex' }, model: 'm' } }, roles: { dev: { agent: 'x', 'a.b': 1 } } } },
    defaultClients(),
  );
  expect(diagnostics.find((item) => item.code === 'unknown-key')?.path).toEqual(['roles', 'dev', 'a.b']);
});
