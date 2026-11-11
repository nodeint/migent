import { documentVersion, loadWorkflowDocument,SCHEMA_VERSION } from '@nodeint/migent-workflow';
import { parseWorkflowMapping } from '@nodeint/migent-workflow';
import { parseYamlDocument } from '@nodeint/migent-workflow';
import { expect, test } from 'vitest';

import { assertConfigClientEquivalence, ConfigurationError, loadYamlMapping, mergeConfigLayers, migrateConfig, migrateWorkflow, patchConfigText, patchWorkflowText } from '../src/index.ts';
import { applyLegacyMigration } from '../src/migration-legacy.ts';
import { writeConfig } from './support.ts';

const LEGACY = `\
# project
project: "Local Multi-Model Agent System"
version: "1.0"

models:
  grok:
    provider: grok
    model: grok-4.6
    options:
      thinking: medium
  gpt-terra:
    provider: codex
    model: gpt-5.6-terra
    options:
      thinking: medium
      temperature: "0.2"

roles:
  planner:
    role: "System Architect & Planner"
    description: "Break the task down."
    default_model: grok
    thinking: high
  reviewer:
    role: "Reviewer"
    default_model: gpt-terra
`;

const WORKFLOW = `\
# review flow
id: plan
stages:
  - id: plan
    role: planner
    depends_on: []
    instructions:
      - Keep the word thinking in the prose.
    thinking: high
  - id: review
    role: reviewer
    model: gpt-terra
    depends_on:
      - plan
    options:
      thinking: low
completion:
  stage: review
`;

function mapping(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected a mapping');
  }
  return value as Record<string, unknown>;
}

test('v0 thinking follows the legacy provider and the document version advances', () => {
  const { document: config, notes } = migrateConfig(loadYamlMapping(writeConfig(LEGACY)));
  expect(notes[0]).toBe('schema_version -> 7');
  expect(mapping(mapping(mapping(config.agents).grok).client).options).toEqual({ 'reasoning-effort': 'medium' });
  expect(mapping(mapping(mapping(config.agents)['gpt-terra']).client).options).toEqual({
    model_reasoning_effort: 'medium',
    temperature: '0.2',
  });
  expect(mapping(mapping(config.roles).planner).options).toEqual({ 'reasoning-effort': 'high' });
  expect(config.schema_version).toBe(7);
});

test('current version is left alone', () => {
  const config = { schema_version: '7', agents: {}, roles: {} };
  expect(migrateConfig(config).notes).toEqual([]);
  expect(documentVersion(config)).toBe(SCHEMA_VERSION);
});

test('an unknown provider without a client fails and names the field', () => {
  const config = {
    schema_version: 5,
    agents: { custom: { provider: 'other', model: 'x' } },
    roles: {},
  };
  expect(() =>
    migrateConfig(config, SCHEMA_VERSION, config, { clientIds: ['agy', 'claude-code', 'codex', 'grok', 'opencode'] }),
  ).toThrow(
    'agents.custom: provider other has no default client; add agents.custom.client.type (one of: agy, claude-code, codex, grok, opencode) and rerun migrate.',
  );
});

test('newer version is rejected', () => {
  expect(() => migrateConfig({ schema_version: 8 })).toThrow(
    new ConfigurationError('config schema_version 8 is newer than this Migent (7).'),
  );
});

test('thinking moves to the provider option and keeps the file', () => {
  const { document: config, notes } = migrateConfig(loadYamlMapping(writeConfig(LEGACY)));
  expect(notes).toContain('models.grok.options.thinking -> reasoning-effort');
  expect(notes).toContain('models.gpt-terra.options.thinking -> model_reasoning_effort');
  expect(notes).toContain('roles.planner.thinking -> options.reasoning-effort');
  expect(config).not.toHaveProperty('models');
  expect(mapping(mapping(mapping(config.agents).grok).client).options).toEqual({ 'reasoning-effort': 'medium' });
  expect(mapping(mapping(mapping(config.agents)['gpt-terra']).client).options).toEqual({
    model_reasoning_effort: 'medium',
    temperature: '0.2',
  });
  const planner = mapping(mapping(config.roles).planner);
  expect(planner.options).toEqual({ 'reasoning-effort': 'high' });
  expect(planner).not.toHaveProperty('thinking');
  expect(planner.description).toBe('Break the task down.');
  const rewritten = patchConfigText(LEGACY, config);
  const parsed = loadYamlMapping(writeConfig(rewritten));
  expect(parsed.version).toBe('1.0');
  expect(parsed.schema_version).toBe(7);
  expect(mapping(mapping(mapping(mapping(parsed.agents).grok).client).options)['reasoning-effort']).toBe('medium');
  expect(mapping(mapping(parsed.roles).reviewer).agent).toBe('gpt-terra');
  expect(rewritten).not.toContain('thinking');
  expect(rewritten).toContain('# project');
  expect(rewritten).toContain('role: "System Architect & Planner"');
});

test('workflow stage keeps instructions and records its version', () => {
  const { document: config } = migrateConfig(loadYamlMapping(writeConfig(LEGACY)));
  const { document: parsed, notes } = migrateWorkflow(mapping(parseYamlDocument(WORKFLOW)), config);
  expect(notes).toContain('stages.review.model -> agent');
  expect(notes).toContain('stages.review.options.thinking removed');
  const rewritten = patchWorkflowText(WORKFLOW, parsed);
  expect(rewritten).toContain('Keep the word thinking in the prose.');
  expect(rewritten).toContain('# review flow');
  const document = loadWorkflowDocument(writeConfig(rewritten));
  // Version 5 has no stage options: the migrated stages drop them and keep the agent selection.
  expect(document.stages.plan?.options).toEqual({});
  expect(document.stages.review?.options).toEqual({});
  expect(document.stages.review).toMatchObject({ agent: { kind: 'named', name: 'gpt-terra' } });
  expect(rewritten).not.toContain('options:');
  expect(rewritten).not.toContain('model: gpt-terra');
  expect(rewritten).toContain('agent: gpt-terra');
  expect(rewritten).toContain('schema_version: 7');
  expect(document.schemaVersion).toBe(7);
  expect(document.completion).toBeNull();
});

test('a version 0 upgrade applies the legacy thinking step and the v5 lifts in one pass', () => {
  const { document: config, notes } = migrateConfig({
    schema_version: 0,
    models: { m: { provider: 'grok', model: 'x', options: { thinking: 'high' } } },
    roles: { dev: { default_model: 'm' } },
  });
  expect(config.schema_version).toBe(7);
  expect(mapping(mapping(mapping(config.agents).m).client).options).toEqual({ 'reasoning-effort': 'high' });
  expect(mapping(mapping(config.roles).dev).agent).toBe('m');
  expect(notes).toContain('models.m.options.thinking -> reasoning-effort');
  expect(notes).toContain('agents.m.provider grok -> client.type grok');
});

test('an existing option wins over thinking', () => {
  const body: Record<string, unknown> = {
    options: { thinking: 'medium', 'reasoning-effort': 'low' },
    thinking: 'high',
  };
  expect(applyLegacyMigration('model', 'grok', 0, body)).toEqual({ options: { 'reasoning-effort': 'low' } });
});

const PLAN_V1 = `schema_version: 1
id: plan
constraints:
  - Do not write implementation code.
  - Do not edit repository files. Write only the stage artifact.
  - Only the decision header routes this workflow. Review prose is feedback, not a route.
stages:
  - id: plan
    role: planner
    depends_on: []
    max_revisions: 3
    instructions:
      - Read task.md and the code it depends on, then write plan.md in this execution's artifacts directory.
      - Write the plan in English. Include scope and paths, current behavior with path:line evidence, decisions the task already fixed, ordered tasks, tests to add or run, and what is out of scope.
      - Each task names the file to change and the behavior to add or keep. Do not mark a task done unless it is already merged.
      - When a review routes back, start from the previous plan.md and write the updated file in this execution's artifacts directory. Address every review point and keep the sections the review did not reject.
    produces:
      artifact: plan.md
  - id: review-plan
    role: reviewer
    depends_on:
      - plan
    options:
      reasoning-effort: high
    instructions:
      - Read plan.md and open the code behind each path:line claim.
      - Check correctness, missing risks, unnecessary scope, and any step an implementer would have to guess.
      - Approve only when the plan can be implemented as written. Otherwise decide revise and list each required edit once.
    decision:
      values:
        - approved
        - revise
      routes:
        approved: complete
        revise: plan
completion:
  stage: review-plan
  decision: approved
  outputs:
    - name: plan
      from_stage: plan
      artifact: plan.md
`;
const IMPLEMENT_V1 = `schema_version: 1
id: implement
requires:
  workflow: plan
  decision: approved
constraints:
  - Implement the approved plan. Do not redesign it.
  - Do not commit or push.
  - Do not edit files the plan does not name.
stages:
  - id: implement
    role: developer
    depends_on: []
    max_revisions: 3
    instructions:
      - Read task.md and the prior session output named plan, then implement that plan.
      - If the plan and the code disagree, stop and name the disagreement. Do not invent a design.
      - Run the tests the plan names. Fix failures your change caused before you report complete.
      - Write implementation.md in English. Record what changed, which tests ran and their results, and any deviation with its reason.
    produces:
      artifact: implementation.md
  - id: review-work
    role: reviewer
    depends_on:
      - implement
    instructions:
      - Read the prior plan, implementation.md, and the diff.
      - Check for missing plan items, extra scope, and tests that skip a case the plan requires.
      - Approve only when the code matches the plan and the named tests passed. Otherwise decide revise and list the files and changes still required.
    decision:
      values:
        - approved
        - revise
      routes:
        approved: complete
        revise: implement
completion:
  stage: review-work
  decision: approved
  outputs:
    - name: implementation
      from_stage: implement
      artifact: implementation.md
`;
const CONFIG_V1 = `schema_version: 1
models:
  opus:
    provider: claude
    model: opus

  grok:
    provider: grok
    model: grok-4.7
    options:
      reasoning-effort: high

  sonnet:
    provider: claude
    model: sonnet

roles:
  planner:
    default_model: opus
    instructions:
      - Read the task and the code it depends on before you write. Cite path:line for every claim about current behavior, and mark anything you did not check as "(verify)".
      - Stay inside the task. Do not add scope, product ideas, or refactors the task did not ask for.
      - Do not edit the repository and do not write implementation code. When a stage asks for an artifact, that file is the only one you write.
      - Leave a result another agent can carry out. Name the files, the behavior change, the tests, and what is out of scope. Do not leave a decision for the implementer to invent.
  reviewer:
    default_model: grok
    instructions:
      - Check the work against the code and the task. Cite path:line for each finding. Do not approve a claim you did not open.
      - Report every gap of the same kind in one response. For each problem, name the evidence and the concrete change required.
      - Do not edit the repository unless the task tells you to. Do not rewrite the document or the diff you are reviewing.
      - Approve only when the work matches the task and the next agent can carry it out without guessing. A missing test, an unchecked claim, or extra scope is revise.
  developer:
    default_model: sonnet
    instructions:
      - Implement only what the task or the approved plan asks. Do not redesign it. If the plan and the code disagree, stop and name the disagreement.
      - Change only the files that work names. Match the style of the code around the edit.
      - Follow CONTRIBUTING.md. Never call a real provider CLI from a test, use a fresh temporary directory per test, import workspace packages by name, and do not add native dependencies.
      - Do not commit or push. Run the tests that work names and fix failures your change caused before you report complete.
`;

test('repo plan and implement workflows migrate to version 7', () => {
  const planBefore = loadWorkflowDocument(writeConfig(PLAN_V1));
  const { document: planParsed, notes: planNotes } = migrateWorkflow(
    mapping(parseYamlDocument(PLAN_V1)),
    { models: {}, roles: {} },
  );
  expect(planNotes).toContain('schema_version -> 7');
  expect(planNotes).toContain('completion removed');
  const planText = patchWorkflowText(PLAN_V1, planParsed);
  const planAfter = loadWorkflowDocument(writeConfig(planText));
  expect(planAfter.schemaVersion).toBe(7);
  expect(planAfter.completion).toBeNull();
  expect(planAfter.concurrency).toBe(1);
  expect(planAfter.requires).toBeNull();
  expect(planAfter.artifacts?.map((item) => [item.id, item.file, item.required])).toEqual([['plan', 'plan.md', true]]);
  expect(planAfter.stages.plan?.artifacts.map((item) => item.id)).toEqual(['plan']);
  expect(planText).not.toContain('produces:');
  expect(planText).not.toContain('outputs:');
  expect(planAfter.stages.plan?.instructions).toEqual(planBefore.stages.plan?.instructions);
  expect(planAfter.stages['review-plan']?.instructions).toEqual(planBefore.stages['review-plan']?.instructions);
  expect(planAfter.stages['review-plan']?.options).toEqual({});
  expect(planNotes).toContain('stages.review-plan.options.reasoning-effort removed');

  const implementBefore = loadWorkflowDocument(writeConfig(IMPLEMENT_V1));
  const { document: implementParsed, notes: implementNotes } = migrateWorkflow(
    mapping(parseYamlDocument(IMPLEMENT_V1)),
    { models: {}, roles: {} },
  );
  expect(implementNotes).toContain('requires.decision removed');
  const implementText = patchWorkflowText(IMPLEMENT_V1, implementParsed);
  const implementAfter = loadWorkflowDocument(writeConfig(implementText));
  expect(implementAfter.schemaVersion).toBe(7);
  expect(implementAfter.completion).toBeNull();
  expect(implementAfter.requires).toBeNull();
  expect(implementAfter.artifacts?.map((item) => [item.id, item.file])).toEqual([['implementation', 'implementation.md']]);
  expect(implementAfter.stages.implement?.instructions).toEqual(implementBefore.stages.implement?.instructions);
  expect(implementAfter.stages['review-work']?.instructions).toEqual(
    implementBefore.stages['review-work']?.instructions,
  );
});

test('a version 1 config upgrades to version 7 and keeps its layout', () => {
  const { document: parsed, notes } = migrateConfig(loadYamlMapping(writeConfig(CONFIG_V1)));
  expect(notes).toEqual([
    'schema_version -> 7',
    'models -> agents',
    'agents.grok.options -> client.options',
    'roles.planner.default_model -> agent',
    'roles.planner.instructions -> responsibilities',
    'roles.reviewer.default_model -> agent',
    'roles.reviewer.instructions -> responsibilities',
    'roles.developer.default_model -> agent',
    'roles.developer.instructions -> responsibilities',
    'agents.opus.provider claude -> client.type claude-code',
    'agents.grok.provider grok -> client.type grok',
    'agents.sonnet.provider claude -> client.type claude-code',
  ]);
  const expected = CONFIG_V1.replace('schema_version: 1\n', 'schema_version: 7\n')
    .replace('models:\n', 'agents:\n')
    .replace(
      '  opus:\n    provider: claude\n    model: opus\n',
      '  opus:\n    model: opus\n\n    client:\n      type: claude-code',
    )
    .replace(
      '  grok:\n    provider: grok\n    model: grok-4.7\n    options:\n      reasoning-effort: high\n',
      '  grok:\n    model: grok-4.7\n    client:\n      type: grok\n      options:\n        reasoning-effort: high\n',
    )
    .replace(
      '  sonnet:\n    provider: claude\n    model: sonnet\n',
      '  sonnet:\n    model: sonnet\n\n    client:\n      type: claude-code',
    )
    .replaceAll('default_model:', 'agent:')
    .replaceAll('    instructions:\n', '    responsibilities:\n');
  expect(patchConfigText(CONFIG_V1, parsed)).toBe(expected);
});

const CONFIG_V4 = `\
schema_version: 4
# agents live here
models:
  grok: # main
    provider: grok
    model: grok-4.6
    client: opencode # cli
    options:
      reasoning-effort: high # keep

  plain:
    provider: codex
    model: gpt-5
roles:
  dev:
    default_model: grok
    instructions:
      - Do it. # c
  rev:
    default_model:
      provider: codex
      model: gpt-5
      options:
        temperature: "0.2"
`;

test('a version 4 config moves models, client and options with comments intact', () => {
  const { document: parsed, notes } = migrateConfig(loadYamlMapping(writeConfig(CONFIG_V4)));
  expect(notes).toEqual([
    'schema_version -> 7',
    'models -> agents',
    'agents.grok.client -> client.type',
    'agents.grok.options -> client.options',
    'roles.dev.default_model -> agent',
    'roles.dev.instructions -> responsibilities',
    'roles.rev.agent.options -> client.options',
    'roles.rev.default_model -> agent',
    'agents.grok.provider dropped (explicit client opencode)',
    'agents.plain.provider codex -> client.type codex',
    'roles.rev.agent.provider codex -> client.type codex',
  ]);
  const text = patchConfigText(CONFIG_V4, parsed);
  expect(text).toBe(`\
schema_version: 7
# agents live here
agents:
  grok: # main
    model: grok-4.6
    client:
      type: opencode # cli
      options:
        reasoning-effort: high # keep

  plain:
    model: gpt-5
    client:
      type: codex
roles:
  dev:
    agent: grok
    responsibilities:
      - Do it. # c
  rev:
    agent:
      model: gpt-5
      client:
        type: codex
        options:
          temperature: "0.2"
`);
  expect(parseYamlDocument(text)).toEqual(parsed);
});

test('a config that cannot be edited line by line falls back to the canonical rendering', () => {
  const text = 'schema_version: 4\nmodels: { fast: { provider: codex, model: gpt-5, options: { a: b } } }\nroles: {}\n';
  const { document: parsed } = migrateConfig(loadYamlMapping(writeConfig(text)));
  const rewritten = patchConfigText(text, parsed);
  expect(parseYamlDocument(rewritten)).toEqual({
    schema_version: 7,
    agents: { fast: { model: 'gpt-5', client: { type: 'codex', options: { a: 'b' } } } },
    roles: {},
  });
});

test('a local config with only roles and models migrates on its own', () => {
  const text = 'schema_version: 4\nmodels: {}\nroles:\n  dev:\n    default_model: shared # local pick\n';
  const { document: parsed } = migrateConfig(loadYamlMapping(writeConfig(text)));
  expect(patchConfigText(text, parsed)).toBe('schema_version: 7\nagents: {}\nroles:\n  dev:\n    agent: shared # local pick\n');
});

const WORKFLOW_V4 = `\
schema_version: 4
id: p
stages:
  - id: a
    role: dev
    model: plain # pick
    options:
      effort: high
    depends_on: []
  - id: b
    role: dev
    options: { effort: low }
    depends_on: [a]
  - id: c
    role: dev
    depends_on: [b]
`;

test('a version 4 workflow renames model to agent and drops stage options with a note', () => {
  const { document: parsed, notes } = migrateWorkflow(mapping(parseYamlDocument(WORKFLOW_V4)), {
    models: { plain: { provider: 'codex', model: 'gpt-5' } },
    roles: {},
  });
  expect(notes).toEqual([
    'schema_version -> 7',
    'stages.a.options.effort removed',
    'stages.a.options removed in schema_version 5; set options on an inline stages.a.agent if the stage still needs them',
    'stages.a.model -> agent',
    'stages.b.options.effort removed',
    'stages.b.options removed in schema_version 5; set options on an inline stages.b.agent if the stage still needs them',
  ]);
  expect(patchWorkflowText(WORKFLOW_V4, parsed)).toBe(`\
schema_version: 7
id: p
stages:
  - id: a
    role: dev
    agent: plain # pick
    depends_on: []
  - id: b
    role: dev
    depends_on: [a]
  - id: c
    role: dev
    depends_on: [b]
`);
});

test('a route to complete from another stage or decision is refused', () => {
  const otherStage = `\
schema_version: 1
id: bad
stages:
  - id: draft
    role: writer
    depends_on: []
    decision:
      values:
        - go
      routes:
        go: complete
completion:
  stage: review
`;
  expect(() => migrateWorkflow(mapping(parseYamlDocument(otherStage)), { models: {}, roles: {} })).toThrow(
    new ConfigurationError(
      'stages.draft.decision.routes.go routes to complete, but completion.stage is review.',
    ),
  );
  const otherDecision = `\
schema_version: 1
id: bad
stages:
  - id: review
    role: reviewer
    depends_on: []
    decision:
      values:
        - approved
        - revise
      routes:
        approved: stay
        revise: complete
  - id: stay
    role: reviewer
    depends_on: []
completion:
  stage: review
  decision: approved
`;
  expect(() => migrateWorkflow(mapping(parseYamlDocument(otherDecision)), { models: {}, roles: {} })).toThrow(
    new ConfigurationError(
      'stages.review.decision.routes.revise routes to complete, but completion.decision is approved.',
    ),
  );
});

test('folded, flow, and quoted requires.decision migrate to version 4', () => {
  const folded = `\
schema_version: 1
id: check
requires:
  workflow: plan
  decision: >
    approved
stages:
  - id: draft
    role: planner
`;
  const flow = `\
schema_version: 1
id: check
requires: { workflow: plan, decision: approved }
stages:
  - id: draft
    role: planner
`;
  const quoted = `\
schema_version: 1
id: check
requires:
  workflow: plan
  "decision": approved
stages:
  - id: draft
    role: planner
`;
  for (const original of [folded, flow, quoted]) {
    const { document: updated } = migrateWorkflow(mapping(parseYamlDocument(original)), { models: {}, roles: {} });
    const text = patchWorkflowText(original, updated);
    const parsed = mapping(parseYamlDocument(text));
    const document = parseWorkflowMapping(parsed, 'check.yaml');
    expect(document.requires).toBeNull();
    expect(document.completion).toBeNull();
    expect(parsed).not.toHaveProperty('completion');
    expect(parsed).not.toHaveProperty('requires');
  }
});

test('a blank or comment inside requires.decision is removed with that key', () => {
  const empty = `\
schema_version: 1
id: check
requires:
  workflow: plan
  decision:

    approved
stages:
  - id: draft
    role: planner
`;
  const plain = `\
schema_version: 1
id: check
requires:
  workflow: plan
  decision: approved

    still
stages:
  - id: draft
    role: planner
`;
  const noted = `\
schema_version: 1
id: check
requires:
  workflow: plan
  decision: # note

    approved
stages:
  - id: draft
    role: planner
`;
  const nested = `\
schema_version: 1
id: check
requires:
  workflow: plan
  decision:

    approved: yes
    note: still
stages:
  - id: draft
    role: planner
`;
  for (const original of [empty, plain, noted, nested]) {
    const { document: updated } = migrateWorkflow(mapping(parseYamlDocument(original)), { models: {}, roles: {} });
    const text = patchWorkflowText(original, updated);
    const parsed = mapping(parseYamlDocument(text));
    const document = parseWorkflowMapping(parsed, 'check.yaml');
    expect(document.requires).toBeNull();
    expect(parsed).not.toHaveProperty('requires');

  }
});

test('a version 2 patch that still has completion or requires.decision is refused', () => {
  const completion = `\
schema_version: 1
id: check
completion:
  stage: draft
stages:
  - id: draft
    role: planner
`;
  const keptCompletion = mapping(parseYamlDocument(completion));
  keptCompletion.schema_version = 2;
  expect(() => patchWorkflowText(completion, keptCompletion)).toThrow(
    new ConfigurationError('migration left completion in the workflow.'),
  );
  const decision = `\
schema_version: 2
id: check
requires: { workflow: plan, decision: approved }
stages:
  - id: draft
    role: planner
`;
  expect(() => patchWorkflowText(decision, mapping(parseYamlDocument(decision)))).toThrow(
    new ConfigurationError('migration left requires.decision in the workflow.'),
  );
});

const CLIENT_IDS = ['agy', 'claude-code', 'codex', 'grok', 'opencode'];

function v5Layer(agents: Record<string, unknown>, roles: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema_version: 5, project: 'Test', agents, roles };
}

/**
 * Mirrors `packages/cli/src/migrate.ts`: both layers are migrated against the original v5 merged
 * context, then the equivalence guard checks the project-alone and merged views.
 */
function migrateLayers(
  projectDocument: Record<string, unknown>,
  localDocument: Record<string, unknown> | null,
  clientIds: readonly string[] = CLIENT_IDS,
): {
  project: Record<string, unknown>;
  local: Record<string, unknown> | null;
  effective: Record<string, unknown>;
  notes: { project: string[]; local: string[] };
} {
  // The v5 merged view, read before either layer is rewritten.
  const merged = mergeConfigLayers(projectDocument, localDocument).config;
  const { document: project, notes: projectNotes } = migrateConfig(projectDocument, SCHEMA_VERSION, merged, {
    layer: 'project',
    project: projectDocument,
    local: localDocument,
    merged,
    clientIds,
  });
  const migratedLocal =
    localDocument === null
      ? null
      : migrateConfig(localDocument, SCHEMA_VERSION, merged, {
          layer: 'local',
          project: projectDocument,
          local: localDocument,
          merged,
          clientIds,
        });
  const local = migratedLocal?.document ?? null;
  const localNotes = migratedLocal?.notes ?? [];
  const effective = local === null ? project : mergeConfigLayers(project, local).config;
  assertConfigClientEquivalence({
    originalProject: projectDocument,
    originalMerged: merged,
    updatedProject: project,
    updatedMerged: effective,
  });
  return { project, local, effective, notes: { project: projectNotes, local: localNotes } };
}

test('a shared placeholder stays empty while the local provider selects the client', () => {
  const migrated = migrateLayers(
    v5Layer({ shared: {} }),
    v5Layer({ shared: { provider: 'codex', model: 'gpt-5' } }),
  );
  expect(mapping(migrated.project.agents).shared).toEqual({});
  expect(mapping(migrated.local?.agents).shared).toEqual({ model: 'gpt-5', client: { type: 'codex' } });
  expect(mapping(migrated.effective.agents).shared).toEqual({ model: 'gpt-5', client: { type: 'codex' } });
  expect(migrated.notes.project).toEqual(['schema_version -> 7']);
  expect(migrated.notes.local).toContain('agents.shared.provider codex -> client.type codex');
});

test("a client.options-only local entry leaves the shared provider's client in place", () => {
  const migrated = migrateLayers(
    v5Layer({ shared: { provider: 'claude', model: 'opus' } }),
    v5Layer({ shared: { client: { options: { temperature: '0.2' } } } }),
  );
  expect(mapping(migrated.project.agents).shared).toEqual({ model: 'opus', client: { type: 'claude-code' } });
  expect(mapping(migrated.local?.agents).shared).toEqual({ client: { options: { temperature: '0.2' } } });
  expect(mapping(migrated.effective.agents).shared).toEqual({
    model: 'opus',
    client: { type: 'claude-code', options: { temperature: '0.2' } },
  });
  expect(migrated.notes.local).toEqual(['schema_version -> 7']);
});

test('both layers naming a provider keep their own client and the local one wins the merge', () => {
  const migrated = migrateLayers(
    v5Layer({ shared: { provider: 'claude' } }),
    v5Layer({ shared: { provider: 'codex' } }),
  );
  expect(mapping(migrated.project.agents).shared).toEqual({ client: { type: 'claude-code' } });
  expect(mapping(migrated.local?.agents).shared).toEqual({ client: { type: 'codex' } });
  expect(mapping(migrated.effective.agents).shared).toEqual({ client: { type: 'codex' } });
  expect(migrated.notes.project).toContain('agents.shared.provider claude -> client.type claude-code');
  expect(migrated.notes.local).toContain('agents.shared.provider codex -> client.type codex');
});

test("a local explicit client preserves the shared provider's standalone default", () => {
  const migrated = migrateLayers(
    v5Layer({ shared: { provider: 'claude', model: 'opus' } }),
    v5Layer({ shared: { client: { type: 'opencode' } } }),
  );
  expect(mapping(migrated.project.agents).shared).toEqual({ model: 'opus', client: { type: 'claude-code' } });
  expect(mapping(migrated.effective.agents).shared).toEqual({ model: 'opus', client: { type: 'opencode' } });
});

test("a local role replacement preserves the shared role's standalone default", () => {
  const migrated = migrateLayers(
    { schema_version: 5, roles: { developer: { agent: { provider: 'claude', model: 'opus' } } } },
    { schema_version: 5, roles: { developer: { agent: { model: 'router/alias', client: { type: 'opencode' } } } } },
  );
  expect(mapping(mapping(migrated.project.roles).developer).agent).toEqual({ model: 'opus', client: { type: 'claude-code' } });
  expect(mapping(mapping(migrated.effective.roles).developer).agent).toEqual({ model: 'router/alias', client: { type: 'opencode' } });
});

test('an explicit client in the shared layer wins over the local provider', () => {
  const migrated = migrateLayers(
    v5Layer({ shared: { provider: 'claude', client: { type: 'opencode' } } }),
    v5Layer({ shared: { provider: 'codex' } }),
  );
  expect(mapping(migrated.project.agents).shared).toEqual({ client: { type: 'opencode' } });
  expect(mapping(migrated.local?.agents).shared).toEqual({});
  expect(mapping(migrated.effective.agents).shared).toEqual({ client: { type: 'opencode' } });
  expect(migrated.notes.project).toContain('agents.shared.provider dropped (explicit client opencode)');
  expect(migrated.notes.local).toContain('agents.shared.provider dropped (client from config.yaml)');
});

test('a byteplus provider in the shared layer stays partial when the local client supplies the choice', () => {
  const migrated = migrateLayers(
    v5Layer({ shared: { provider: 'byteplus', model: 'gpt-5' } }),
    v5Layer({ shared: { client: { type: 'opencode' } } }),
  );
  expect(mapping(migrated.project.agents).shared).toEqual({ model: 'gpt-5' });
  expect(mapping(migrated.local?.agents).shared).toEqual({ client: { type: 'opencode' } });
  expect(mapping(migrated.effective.agents).shared).toEqual({
    model: 'gpt-5',
    client: { type: 'opencode' },
  });
  expect(migrated.notes.project).toContain('agents.shared.provider dropped (client from config.local.yaml)');
});

test('an unresolvable provider fails and names the field and the client list', () => {
  expect(() => migrateLayers(v5Layer({ shared: { provider: 'byteplus' } }), v5Layer({}))).toThrow(
    new ConfigurationError(
      `agents.shared: provider byteplus has no default client; add agents.shared.client.type (one of: ${CLIENT_IDS.join(', ')}) and rerun migrate.`,
    ),
  );
});

test('an unknown provider fails in the layer that names it', () => {
  expect(() =>
    migrateLayers(
      v5Layer({ shared: { model: 'gpt-5' } }),
      v5Layer({ shared: { provider: 'mystery' } }),
    ),
  ).toThrow(
    new ConfigurationError(
      `agents.shared: provider mystery has no default client; add agents.shared.client.type (one of: ${CLIENT_IDS.join(', ')}) and rerun migrate.`,
    ),
  );
});

test('locations with no provider or client in any layer are left unchanged', () => {
  const migrated = migrateLayers(
    v5Layer({ placeholder: {}, model_only: { model: 'gpt-5' }, options_only: { client: { options: { a: 'b' } } } }),
    v5Layer({ placeholder: { effort: 'high' } }),
  );
  expect(mapping(migrated.project.agents)).toEqual({
    placeholder: {},
    model_only: { model: 'gpt-5' },
    options_only: { client: { options: { a: 'b' } } },
  });
  expect(mapping(migrated.local?.agents)).toEqual({ placeholder: { effort: 'high' } });
  expect(migrated.notes.project).toEqual(['schema_version -> 7']);
  expect(migrated.notes.local).toEqual(['schema_version -> 7']);
});

test('the equivalence guard aborts when a rewrite would change a client', () => {
  expect(() =>
    assertConfigClientEquivalence({
      originalProject: { agents: { x: { provider: 'claude' } } },
      originalMerged: { agents: { x: { provider: 'claude' } } },
      updatedProject: { agents: { x: { client: { type: 'codex' } } } },
      updatedMerged: { agents: { x: { client: { type: 'codex' } } } },
    }),
  ).toThrow(
    new ConfigurationError(
      'migration would change config.yaml agents.x from client claude-code to codex; nothing was written.',
    ),
  );
});

test("a layered rewrite keeps comments, key order, and the text patcher's shape", () => {
  const projectText = `\
schema_version: 5
# shared agents
agents:
  shared: # main
    provider: claude
    model: opus
`;
  const localText = `\
schema_version: 5
agents:
  shared:
    client:
      options:
        temperature: "0.2"
`;
  const projectDocument = loadYamlMapping(writeConfig(projectText));
  const localDocument = loadYamlMapping(writeConfig(localText));
  const migrated = migrateLayers(projectDocument, localDocument);
  const rewritten = patchConfigText(projectText, migrated.project);
  expect(rewritten).toBe(`\
schema_version: 7
# shared agents
agents:
  shared: # main
    model: opus
    client:
      type: claude-code
`);
  expect(parseYamlDocument(rewritten)).toEqual(migrated.project);
});

test('a second layered migration at version 6 changes nothing', () => {
  const project = v5Layer({ shared: { provider: 'claude', model: 'opus' } });
  const local = v5Layer({ shared: { provider: 'codex' } });
  const first = migrateLayers(project, local);
  const second = migrateLayers(first.project, first.local);
  expect(second.project).toEqual(first.project);
  expect(second.local).toEqual(first.local);
  expect(second.notes.project).toEqual([]);
  expect(second.notes.local).toEqual([]);
  expect(documentVersion(second.project)).toBe(SCHEMA_VERSION);
  expect(documentVersion(second.local)).toBe(SCHEMA_VERSION);
});

test('migrateConfig and migrateWorkflow return a copy and leave their input unchanged', () => {
  const config = loadYamlMapping(writeConfig(LEGACY));
  const configBefore = structuredClone(config);
  const migratedConfig = migrateConfig(config);
  expect(config).toEqual(configBefore);
  expect(migratedConfig.document).not.toBe(config);
  expect(migratedConfig.document.schema_version).toBe(7);

  const workflow = mapping(parseYamlDocument(WORKFLOW));
  const workflowBefore = structuredClone(workflow);
  const migratedWorkflow = migrateWorkflow(workflow, migratedConfig.document);
  expect(workflow).toEqual(workflowBefore);
  expect(migratedWorkflow.document).not.toBe(workflow);
  expect(migratedWorkflow.document.schema_version).toBe(7);
});
