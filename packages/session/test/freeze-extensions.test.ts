import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ExtensionCatalog } from '@nodeint/migent-contracts';
import { parseWorkflowMapping } from '@nodeint/migent-workflow';
import { afterEach, describe, expect, test } from 'vitest';
import { parse, stringify } from 'yaml';

import { readWorkflowFreeze, renderWorkflowSource, WORKFLOW_FREEZE_FILE, writeWorkflowFreeze } from '../src/session-freeze.ts';

// TypeBox schemas are plain JSON Schema objects.
const object = (properties: Record<string, unknown>): never => {
  const schema: Record<string, unknown> = { type: 'object', properties, required: [] };
  return schema as never;
};
const catalog: ExtensionCatalog = [{
  plugin: 'fixture',
  version: 1,
  fields: { workflow: object({ fixture_flow: { type: 'string' } }), stage: object({ fixture_stage: { type: 'object' } }) },
}];

test('renderWorkflowSource writes claimed keys flat and they round-trip', () => {
  const source = {
    schema_version: 8,
    id: 'flow',
    fixture_flow: 'x',
    stages: [{ id: 'a', role: 'dev', depends_on: [], fixture_stage: { mode: 'fast' } }],
  };
  const text = renderWorkflowSource(parseWorkflowMapping(source, 'flow.yaml', { extensions: catalog }));
  const written = parse(text) as Record<string, unknown> & { stages: Record<string, unknown>[] };
  expect(written.fixture_flow).toBe('x');
  expect(written.stages[0].fixture_stage).toEqual({ mode: 'fast' });
  expect(Object.keys(written).slice(-1)).toEqual(['fixture_flow']);
  const back = parseWorkflowMapping(written, 'frozen.yaml', { extensions: catalog });
  expect(back.extensions).toEqual({ fixture: { fixture_flow: 'x' } });
  expect(back.stages.a.extensions).toEqual({ fixture: { fixture_stage: { mode: 'fast' } } });
});

describe('freeze extensions', () => {
  const full: ExtensionCatalog = [{
    plugin: 'fixture',
    version: 3,
    fields: {
      workflow: object({ fixture_flow: { type: 'string' } }),
      stage: object({ fixture_stage: { type: 'object' } }),
      agent: object({ fixture_agent: { type: 'object' } }),
      role: object({ fixture_role: { type: 'string' } }),
    },
  }];
  const idle: ExtensionCatalog = [{ plugin: 'idle', version: 2, fields: { stage: object({ idle_stage: { type: 'string' } }) } }];
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const CONFIG = `agents:
  grok:
    client:
      type: grok
    model: grok-4
    fixture_agent: { speed: fast }
roles:
  developer:
    agent: grok
    fixture_role: careful
`;

  const BARE_CONFIG = CONFIG.split('\n')
    .filter((line) => !line.includes('fixture_agent') && !line.includes('fixture_role'))
    .join('\n');

  function freeze(catalog: ExtensionCatalog, config = CONFIG): { workspace: string; file: string } {
    const workspace = mkdtempSync(path.join(tmpdir(), 'migent-freeze-ext-'));
    dirs.push(workspace);
    mkdirSync(path.join(workspace, '.migent'));
    writeFileSync(path.join(workspace, '.migent/config.yaml'), config);
    const workflow = parseWorkflowMapping(
      {
        schema_version: 8,
        id: 'flow',
        ...(catalog.length > 0 && catalog[0].plugin === 'fixture' ? { fixture_flow: 'x' } : {}),
        stages: [{ id: 'a', role: 'developer', depends_on: [], ...(catalog[0]?.plugin === 'fixture' ? { fixture_stage: { mode: 'fast' } } : {}) }],
      },
      'flow.yaml',
      { extensions: catalog },
    );
    writeWorkflowFreeze(workspace, { workspace, workflow, extensions: catalog });
    return { workspace, file: path.join(workspace, WORKFLOW_FREEZE_FILE) };
  }

  const rewrite = (file: string, change: (body: Record<string, unknown>) => void): void => {
    const body = parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    change(body);
    writeFileSync(file, stringify(body));
  };

  test('a write and read round trip keeps keys at every level', () => {
    const { workspace, file } = freeze(full);
    const written = parse(readFileSync(file, 'utf8')) as Record<string, any>;
    expect(written.extensions).toEqual({
      fixture: { version: 3, keys: { workflow: ['fixture_flow'], stage: ['fixture_stage'], agent: ['fixture_agent'], role: ['fixture_role'] } },
    });
    const read = readWorkflowFreeze(workspace);
    expect(read?.workflow.extensions).toEqual({ fixture: { fixture_flow: 'x' } });
    expect(read?.workflow.stages.a.extensions).toEqual({ fixture: { fixture_stage: { mode: 'fast' } } });
    expect(read?.extensions.targets).toEqual({ a: { fixture: { fixture_agent: { speed: 'fast' } } } });
    expect(read?.extensions.roles).toEqual({ developer: { fixture: { fixture_role: 'careful' } } });
  });

  test('a plugin with a catalog entry and no keys gets a record with empty lists', () => {
    const { file } = freeze(idle, CONFIG.replace(/ {4}fixture_agent.*\n/, '').replace(/ {4}fixture_role.*\n/, ''));
    const written = parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const keys = { workflow: [], stage: [], agent: [], role: [] };
    expect(written.extensions).toEqual({ idle: { version: 2, keys } });
    expect(written).not.toHaveProperty('role_extensions');
  });

  test('a freeze reads without the current catalog, schema, or plugin', () => {
    const { workspace, file } = freeze(full);
    rewrite(file, (body) => {
      (body.workflow as Record<string, unknown>).fixture_flow = 42;
    });
    expect(readWorkflowFreeze(workspace)?.workflow.extensions).toEqual({ fixture: { fixture_flow: 42 } });
  });

  test('an unlisted non-core body key is corrupt', () => {
    const { workspace, file } = freeze(full);
    rewrite(file, (body) => {
      (body.workflow as Record<string, unknown>).stray_key = 1;
    });
    expect(() => readWorkflowFreeze(workspace)).toThrow(/corrupt/);
  });

  test.each([4, 7])('an unlisted workflow or stage key is corrupt at workflow schema_version %i', (version) => {
    const { workspace, file } = freeze(idle, BARE_CONFIG);
    const reads = (): void => expect(() => readWorkflowFreeze(workspace)).toThrow(/corrupt/);
    rewrite(file, (body) => {
      const workflow = body.workflow as Record<string, any>;
      workflow.schema_version = version;
      workflow.stray_key = 1;
    });
    reads();
    rewrite(file, (body) => {
      const workflow = body.workflow as Record<string, any>;
      delete workflow.stray_key;
      workflow.stages[0].stray_key = 1;
    });
    reads();
  });

  test('a valid pre-version-5 freeze with a recorded stage key reads', () => {
    const { workspace, file } = freeze(full);
    rewrite(file, (body) => {
      (body.workflow as Record<string, unknown>).schema_version = 4;
    });
    expect(readWorkflowFreeze(workspace)?.workflow.stages.a.extensions).toEqual({ fixture: { fixture_stage: { mode: 'fast' } } });
  });

  test.each([
    ['extensions', (body: Record<string, any>) => { body.extensions = 'x'; }],
    ['record version', (body: Record<string, any>) => { body.extensions.fixture.version = 0; }],
    ['record keys list', (body: Record<string, any>) => { body.extensions.fixture.keys.stage = 'x'; }],
    ['targets extensions', (body: Record<string, any>) => { body.targets.a.extensions = ['x']; }],
    ['role_extensions', (body: Record<string, any>) => { body.role_extensions = { developer: { fixture: 'x' } }; }],
  ])('a malformed %s mapping is corrupt', (_name, change) => {
    const { workspace, file } = freeze(full);
    rewrite(file, change as (body: Record<string, unknown>) => void);
    expect(() => readWorkflowFreeze(workspace)).toThrow(/corrupt/);
  });

  test('a freeze written without extensions reads with no extension data', () => {
    const { workspace } = freeze([]);
    expect(readWorkflowFreeze(workspace)?.extensions).toEqual({ records: {}, targets: {}, roles: {} });
  });
});
