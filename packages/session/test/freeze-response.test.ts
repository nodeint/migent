import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ExtensionCatalog, TObject } from '@nodeint/migent-contracts';
import { parseWorkflowMapping } from '@nodeint/migent-workflow';
import { afterEach, describe, expect, test } from 'vitest';
import { parse, stringify } from 'yaml';

import type { PluginFreezeInput, PluginResponseResults } from '../src/index.ts';
import { readWorkflowFreeze, WORKFLOW_FREEZE_FILE, writeWorkflowFreeze } from '../src/session-freeze.ts';

const payload = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };
const catalog: ExtensionCatalog = [{
  plugin: 'judge',
  version: 2,
  // TypeBox schemas are plain JSON Schema objects.
  fields: { response: { type: 'object', properties: { judge: payload }, required: [] } as unknown as TObject },
}];
const results: PluginResponseResults = { a: { judge: { required: true, instructions: 'Say a verdict.' } } };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const stub = (responseContracts?: PluginFreezeInput['responseContracts']): PluginFreezeInput => ({
  classify: () => 'frozen',
  snapshot: () => [],
  ...(responseContracts === undefined ? {} : { responseContracts }),
});

function freeze(plugins: PluginFreezeInput, entries = catalog): { workspace: string; file: string } {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-freeze-response-'));
  dirs.push(workspace);
  mkdirSync(path.join(workspace, '.migent'));
  writeFileSync(path.join(workspace, '.migent/config.yaml'), 'roles:\n  developer:\n    agent: dev\nagents:\n  dev:\n    client: { type: fake }\n    model: fake-1\n');
  const workflow = parseWorkflowMapping({ schema_version: 8, id: 'flow', stages: [{ id: 'a', role: 'developer', depends_on: [] }] }, 'flow.yaml', { extensions: entries });
  writeWorkflowFreeze(workspace, { workspace, workflow, plugins, extensions: entries });
  return { workspace, file: path.join(workspace, WORKFLOW_FREEZE_FILE) };
}

const rewrite = (file: string, change: (body: Record<string, any>) => void): void => {
  const body = parse(readFileSync(file, 'utf8')) as Record<string, any>;
  change(body);
  writeFileSync(file, stringify(body));
};

describe('response contracts in the freeze', () => {
  test('an active result is frozen with its payload schema and the owner records its response key', () => {
    const { workspace, file } = freeze(stub(() => results));
    const written = parse(readFileSync(file, 'utf8')) as Record<string, any>;
    expect(written.response_contracts).toEqual({ a: { judge: { required: true, instructions: 'Say a verdict.', schema: payload } } });
    expect(written.extensions.judge.keys.response).toEqual(['judge']);
    expect(readWorkflowFreeze(workspace)?.responseContracts).toEqual(written.response_contracts);
  });

  test('the frozen schema is a copy, not a reference to the catalog object', () => {
    const { workspace } = freeze(stub(() => results));
    expect(readWorkflowFreeze(workspace)?.responseContracts.a.judge.schema).not.toBe(payload);
    expect(readWorkflowFreeze(workspace)?.responseContracts.a.judge.schema).toEqual(payload);
  });

  test('no active result writes no response_contracts and no response key', () => {
    const { workspace, file } = freeze(stub(() => ({})));
    const written = parse(readFileSync(file, 'utf8')) as Record<string, any>;
    expect(written).not.toHaveProperty('response_contracts');
    expect(written.extensions.judge.keys).not.toHaveProperty('response');
    expect(readWorkflowFreeze(workspace)?.responseContracts).toEqual({});
  });

  test('a host without the member freezes the same bytes as one that returns nothing', () => {
    const bare = readFileSync(freeze(stub()).file, 'utf8');
    expect(readFileSync(freeze(stub(() => ({}))).file, 'utf8')).toBe(bare);
  });

  test('an entry whose plugin has no recorded response key is corrupt', () => {
    const { workspace, file } = freeze(stub(() => results));
    rewrite(file, (body) => {
      body.extensions.judge.keys.response = [];
    });
    expect(() => readWorkflowFreeze(workspace)).toThrow(/corrupt.*no recorded response key/);
  });

  test('a malformed frozen schema is corrupt', () => {
    const { workspace, file } = freeze(stub(() => results));
    rewrite(file, (body) => {
      body.response_contracts.a.judge.schema = { type: 'nonsense' };
    });
    expect(() => readWorkflowFreeze(workspace)).toThrow(/corrupt.*well-formed/);
  });

  test('a contract for a stage the workflow lacks is corrupt', () => {
    const { workspace, file } = freeze(stub(() => results));
    rewrite(file, (body) => {
      body.response_contracts.ghost = body.response_contracts.a;
    });
    expect(() => readWorkflowFreeze(workspace)).toThrow(/corrupt.*ghost/);
  });

  test('a blank instruction or a non-boolean required is corrupt', () => {
    const { workspace, file } = freeze(stub(() => results));
    rewrite(file, (body) => {
      body.response_contracts.a.judge.instructions = ' ';
    });
    expect(() => readWorkflowFreeze(workspace)).toThrow(/instructions/);
    rewrite(file, (body) => {
      body.response_contracts.a.judge.instructions = 'ok';
      body.response_contracts.a.judge.required = 'yes';
    });
    expect(() => readWorkflowFreeze(workspace)).toThrow(/required/);
  });
});
