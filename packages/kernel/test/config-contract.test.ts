import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ConfigLayer, EffectiveConfig, isValid } from '@nodeint/migent-contracts';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

import {
  buildStructuralIndex,
  ConfigurationError,
  loadAgentDefinition,
  loadRoleDescription,
  loadRoleResponsibilities,
  mergeConfigLayers,
  resolveRoleCascade,
} from '../src/index.js';

const read = (relative: string): unknown => parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'));

describe('config layer contract', () => {
  test.each(['../../../.migent/config.yaml', '../../../templates/config.yaml', '../../../templates/config.local.yaml'])(
    '%s is a valid layer',
    (file) => {
      const doc = read(file) ?? {};
      expect(isValid(ConfigLayer, doc)).toBe(true);
    },
  );

  test('a partial named agent is a valid layer and merges into a valid effective config', () => {
    const project = { schema_version: 7, agents: { a: { client: { type: 'codex' } } }, roles: { r: { agent: 'a' } } };
    const local = { agents: { a: { model: 'm' } } };
    expect(isValid(ConfigLayer, project)).toBe(true);
    expect(isValid(EffectiveConfig, project)).toBe(false);
    expect(isValid(EffectiveConfig, mergeConfigLayers(project, local).config)).toBe(true);
  });

  test('an inline role agent without model is invalid as a layer and as an effective config', () => {
    const doc = { roles: { r: { agent: { client: { type: 'codex' } } } } };
    expect(isValid(ConfigLayer, doc)).toBe(false);
    expect(isValid(EffectiveConfig, doc)).toBe(false);
  });

  test('an empty named agent is a valid placeholder', () => {
    expect(isValid(EffectiveConfig, { agents: { x: {} }, roles: { r: { agent: 'x' } } })).toBe(true);
  });

  test('a closed client rejects unknown keys', () => {
    expect(isValid(ConfigLayer, { agents: { a: { model: 'm', client: { type: 'codex', extra: 'x' } } } })).toBe(false);
  });
});

describe('lazy runtime validation', () => {
  const config = {
    agents: { good: { model: 'm', client: { type: 'codex' } }, bad: { model: 3 }, x: {} },
    roles: {
      usesBad: { agent: 'bad', responsibilities: ['a'], description: 'd' },
      placeholder: { agent: 'x' },
      noAgent: { responsibilities: ['a'], description: 'd' },
      stage: { agent: { client: 'oops' } },
    },
  };

  test('selecting an unresolved placeholder fails at agents.x.model', () => {
    try {
      resolveRoleCascade(config, 'placeholder');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).code).toBe('missing-or-invalid');
      expect((error as ConfigurationError).path).toEqual(['agents', 'x', 'model']);
    }
  });

  test('an invalid unused named agent does not stop another role', () => {
    const target = resolveRoleCascade({ ...config, roles: { ok: { agent: 'good' } } }, 'ok');
    expect(target.model).toBe('m');
  });

  test('a malformed role agent is replaced by a stage override', () => {
    const target = resolveRoleCascade(
      config,
      'stage',
      { agent: { kind: 'named', name: 'good' }, agentField: 'stages.s.agent' },
    );
    expect(target.client).toBe('codex');
  });

  test('responsibilities and description do not require a valid agent', () => {
    expect(loadRoleResponsibilities(config, 'usesBad')).toEqual(['a']);
    expect(loadRoleDescription(config, 'usesBad')).toBe('d');
    expect(loadRoleResponsibilities(config, 'noAgent')).toEqual(['a']);
  });

  test('agent definitions report the structural code and path', () => {
    expect(() => loadAgentDefinition({ model: 'm', client: { type: 'codex', options: { '1a': 'x' } } }, 'agents.a'))
      .toThrowError(expect.objectContaining({ code: 'option-key-invalid', path: ['agents', 'a', 'client', 'options', '1a'] }));
    expect(() => loadAgentDefinition({ model: 'm', client: { type: 'codex', options: { a: ' ' } } }, 'agents.a'))
      .toThrowError(expect.objectContaining({ code: 'option-invalid' }));
    expect(() => loadAgentDefinition({ model: 'm', client: 'codex' }, 'agents.a'))
      .toThrowError(expect.objectContaining({ code: 'client-not-mapping' }));
  });
});

describe('option diagnostics after valid entries', () => {
  const load = (options: Record<string, unknown>, index?: ReturnType<typeof buildStructuralIndex>) =>
    loadAgentDefinition({ model: 'm', client: { type: 'codex', options } }, 'agents.a', { index });

  test.each([
    [{ good: 'x', bad: ' ' }, 'option-invalid', ['agents', 'a', 'client', 'options', 'bad']],
    [{ good: 'x', n: 3 }, 'option-invalid', ['agents', 'a', 'client', 'options', 'n']],
    [{ good: 'x', '1a': 'y' }, 'option-key-invalid', ['agents', 'a', 'client', 'options', '1a']],
    [{ '1a': 'y', bad: ' ' }, 'option-key-invalid', ['agents', 'a', 'client', 'options', '1a']],
  ])('%j', (options, code, path) => {
    expect(() => load(options)).toThrowError(expect.objectContaining({ code, path }));
    const index = buildStructuralIndex({ agents: { a: { model: 'm', client: { type: 'codex', options } } }, roles: {} });
    expect(() => load(options, index)).toThrowError(expect.objectContaining({ code, path }));
  });
});

describe('entries named like contract fields', () => {
  const code = (fn: () => unknown): unknown => {
    try { fn(); } catch (error) { return [(error as ConfigurationError).code, (error as ConfigurationError).path]; }
    return null;
  };

  test('an agent named client is not a client field', () => {
    const config = { agents: { client: 'oops' }, roles: { r: { agent: 'client' } } };
    const index = buildStructuralIndex(config);
    const lazy = code(() => resolveRoleCascade(config, 'r'));
    expect(lazy).toEqual(['missing-or-invalid', ['agents', 'client']]);
    expect(code(() => resolveRoleCascade(config, 'r', { index }))).toEqual(lazy);
  });

  test('a role named client with a malformed agent', () => {
    const config = { roles: { client: { agent: 'oops' } } };
    const index = buildStructuralIndex(config);
    const lazy = code(() => resolveRoleCascade(config, 'client'));
    expect(code(() => resolveRoleCascade(config, 'client', { index }))).toEqual(lazy);
  });

  test('a real string client still reports client-not-mapping, indexed and lazy', () => {
    const config = { roles: { client: { agent: { model: 'm', client: 'codex' } } } };
    const index = buildStructuralIndex(config);
    const expected = ['client-not-mapping', ['roles', 'client', 'agent', 'client']];
    expect(code(() => resolveRoleCascade(config, 'client'))).toEqual(expected);
    expect(code(() => resolveRoleCascade(config, 'client', { index }))).toEqual(expected);
  });

  test('an option named client is an option', () => {
    const config = { agents: { a: { model: 'm', client: { type: 'codex', options: { client: ' ' } } } }, roles: {} };
    const index = buildStructuralIndex(config);
    expect(index.get(JSON.stringify(['agents', 'a', 'client', 'options', 'client']))?.code).toBe('option-invalid');
  });
});

describe('whole-document structural index', () => {
  test('a bad responsibilities does not hide the verdict on agent', () => {
    const index = buildStructuralIndex({ roles: { r: { agent: { client: { type: 'codex' } }, responsibilities: 3 } } });
    expect(index.get(JSON.stringify(['roles', 'r', 'agent', 'model']))?.code).toBe('missing-or-invalid');
    expect(index.get(JSON.stringify(['roles', 'r', 'responsibilities']))?.code).toBe('not-a-list');
  });

  test('a placeholder produces no issue, a non-mapping container does', async () => {
    const { containerIssues } = await import('../src/index.js');
    expect(containerIssues({ agents: { x: {} }, roles: { r: {} } })).toEqual([]);
    expect(containerIssues({ agents: 3, roles: 3 }).map((e) => e.code)).toEqual(['agents-invalid', 'roles-invalid']);
    expect(containerIssues({}).map((e) => e.code)).toEqual(['roles-invalid']);
  });

  test('per-node verdicts agree with the whole-document index for the baseline drafts', async () => {
    const bad = { roles: { r: { agent: { model: 'm', client: { type: 'codex', extra: 1 } } } } };
    expect([...buildStructuralIndex(bad).keys()].some((key) => key.startsWith('["roles","r","agent","client"'))).toBe(true);
    expect(() => resolveRoleCascade(bad, 'r')).toThrowError(expect.objectContaining({ code: 'unknown-key' }));
  });
});
