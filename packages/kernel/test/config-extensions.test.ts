import type { ExtensionCatalog, PluginExtension } from '@nodeint/migent-contracts';
import { expect, test } from 'vitest';

import {
  ConfigurationError,
  loadAgentDefinition,
  mergeConfigLayers,
  migrateConfig,
  migrateWorkflow,
  renderAuthoringYaml,
  resolveRoleCascade,
  resolveStageSpec,
  unknownRoleKeyEntries,
} from '../src/index.ts';

type Mapping = Record<string, unknown>;
type Fields = PluginExtension['fields'];

// TypeBox schemas are plain JSON Schema objects; the fixture builds them without the typebox dependency.
const object = (properties: Mapping, required: string[]): never => {
  const schema: Mapping = { type: 'object', properties, required };
  return schema as never;
};

const catalog: ExtensionCatalog = [
  {
    plugin: 'fixture',
    version: 1,
    fields: {
      workflow: object({ fixture_flow: { type: 'string' } }, []),
      stage: object({ fixture_stage: { type: 'string' } }, []),
      agent: object({ fixture_agent: object({ mode: { type: 'string' }, retries: { type: 'integer' } }, ['mode']) }, []),
      role: object({ fixture_role: object({ mode: { type: 'string' }, retries: { type: 'integer' } }, ['mode']) }, []),
    } as unknown as Fields,
  },
];
const extensions = { extensions: catalog };

const AGENT_VALUE = { mode: 'fast', retries: 2 };
const base = (): Mapping => ({
  schema_version: 7,
  agents: { named: { client: { type: 'codex' }, model: 'm', fixture_agent: AGENT_VALUE, unowned_extra: 'kept' } },
  roles: {
    dev: { agent: 'named', fixture_role: { mode: 'role' } },
    inline: { agent: { client: { type: 'codex' }, model: 'i', fixture_agent: { mode: 'inline' } } },
  },
});

test('unknown agent keys are accepted today', () => {
  const config = base();
  const target = loadAgentDefinition((config.agents as Mapping).named, 'agents.named');
  expect(target).toEqual({ client: 'codex', model: 'm', options: {} });
});

test('a claimed agent key is validated and carried on the target', () => {
  const config = base();
  expect(loadAgentDefinition((config.agents as Mapping).named, 'agents.named', extensions).extensions).toEqual({
    fixture: { fixture_agent: AGENT_VALUE },
  });
  const bad = { client: { type: 'codex' }, model: 'm', fixture_agent: { retries: 'x' } };
  expect(() => loadAgentDefinition(bad, 'agents.named', extensions)).toThrow(
    expect.objectContaining({ code: 'missing-or-invalid', path: ['agents', 'named', 'fixture_agent', 'mode'] }) as Error,
  );
});

test('an inline role agent and a role carry and validate claimed keys', () => {
  const config = base();
  const inline = resolveRoleCascade(config, 'inline', extensions);
  expect(inline.extensions).toEqual({ fixture: { fixture_agent: { mode: 'inline' } } });
  const named = resolveRoleCascade(config, 'dev', extensions);
  expect(named.roleExtensions).toEqual({ fixture: { fixture_role: { mode: 'role' } } });
  (config.roles as Mapping).dev = { agent: 'named', fixture_role: { mode: 4 } };
  expect(() => resolveRoleCascade(config, 'dev', extensions)).toThrow(
    expect.objectContaining({ path: ['roles', 'dev', 'fixture_role', 'mode'] }) as Error,
  );
});

test('an inline stage agent carries its claimed keys and replaces the role agent', () => {
  const stage = {
    id: 's', role: 'dev', depends_on: [], options: {},
    agent: { kind: 'inline', value: { client: { type: 'codex' }, model: 'x', fixture_agent: { mode: 'stage' } } },
  };
  const target = resolveStageSpec(base(), stage as never, extensions);
  expect(target.extensions).toEqual({ fixture: { fixture_agent: { mode: 'stage' } } });
  expect(target.roleExtensions).toEqual({ fixture: { fixture_role: { mode: 'role' } } });
});

test('a local layer overrides one field and keeps the others; an inline agent replaces wholesale', () => {
  const local = {
    agents: { named: { fixture_agent: { mode: 'slow' } } },
    roles: { inline: { agent: { client: { type: 'codex' }, model: 'j' } } },
  };
  const { config } = mergeConfigLayers(base(), local);
  const named = resolveRoleCascade(config, 'dev', extensions);
  expect(named.extensions).toEqual({ fixture: { fixture_agent: { mode: 'slow', retries: 2 } } });
  expect(resolveRoleCascade(config, 'inline', extensions).extensions).toBeUndefined();
});

test('a target without claimed keys has no extension fields', () => {
  expect(resolveRoleCascade(base(), 'dev')).toEqual({ client: 'codex', model: 'm', options: {} });
});

test('an unclaimed role key stays an unknown-key warning and a claimed one is known', () => {
  const config = { roles: { dev: { fixture_role: {}, other: 1 } } };
  expect(unknownRoleKeyEntries(config).map((entry) => entry.path)).toEqual([
    ['roles', 'dev', 'fixture_role'],
    ['roles', 'dev', 'other'],
  ]);
  expect(unknownRoleKeyEntries(config, catalog).map((entry) => entry.path)).toEqual([['roles', 'dev', 'other']]);
});

test('config draft rendering keeps claimed keys at every level', () => {
  const { text } = renderAuthoringYaml(base());
  expect(text).toContain('fixture_agent:');
  expect(text).toContain('fixture_role:');
  expect(text).toContain('unowned_extra: kept');
});

test('validation does not depend on the plugin being enabled', () => {
  const config = { ...base(), plugins: { fixture: { enabled: false } } };
  (config.roles as Mapping).dev = { agent: 'named', fixture_role: { mode: 1 } };
  expect(() => resolveRoleCascade(config, 'dev', extensions)).toThrow(ConfigurationError);
  (config.roles as Mapping).dev = { agent: 'named', fixture_role: { mode: 'ok' } };
  expect(resolveRoleCascade(config, 'dev', extensions).roleExtensions).toEqual({ fixture: { fixture_role: { mode: 'ok' } } });
});

test('migrate keeps unknown keys at the workflow, stage, agent and role levels from the oldest version', () => {
  const legacy: Mapping = {
    schema_version: 1,
    models: { grok: { provider: 'grok', model: 'g', options: { thinking: 'medium' }, fixture_agent: AGENT_VALUE } },
    roles: { dev: { default_model: 'grok', instructions: 'x', fixture_role: { mode: 'role' } } },
  };
  const config = migrateConfig(legacy).document;
  expect((config.agents as Mapping).grok).toMatchObject({ fixture_agent: AGENT_VALUE });
  expect((config.roles as Mapping).dev).toMatchObject({ fixture_role: { mode: 'role' } });
  const inline: Mapping = {
    schema_version: 1,
    roles: { dev: { default_model: { provider: 'grok', model: 'g', options: { a: 'b' }, fixture_agent: AGENT_VALUE } } },
  };
  const migrated = migrateConfig(inline).document;
  expect(((migrated.roles as Mapping).dev as Mapping).agent).toMatchObject({ fixture_agent: AGENT_VALUE });
  const workflow: Mapping = {
    schema_version: 1,
    id: 'flow',
    fixture_flow: 'x',
    stages: [{ id: 'a', role: 'dev', model: 'grok', fixture_stage: 'y', depends_on: [] }],
  };
  const out = migrateWorkflow(workflow, legacy).document;
  expect(out.fixture_flow).toBe('x');
  expect((out.stages as Mapping[])[0].fixture_stage).toBe('y');
});
