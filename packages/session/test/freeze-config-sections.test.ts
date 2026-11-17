import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CONFIG_SECTIONS, type ConfigSection, type TSchema } from '@nodeint/migent-contracts';
import { loadWorkspaceConfig } from '@nodeint/migent-kernel';
import { parseWorkflowMapping } from '@nodeint/migent-workflow';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { parse, stringify } from 'yaml';

import { effectiveConfigSection as resolveSection } from '../src/freeze-config-sections.ts';
import { readWorkflowFreeze, WORKFLOW_FREEZE_FILE, writeWorkflowFreeze } from '../src/session-freeze.ts';

const registered = CONFIG_SECTIONS as ConfigSection[];
const production = [...CONFIG_SECTIONS];
const restoreProduction = (): void => { registered.splice(0, registered.length, ...production); };
const schema = (value: object): TSchema => value as TSchema;
const Entry = schema({ type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] });
type Frozen = Parameters<typeof resolveSection>[0];
const effectiveConfigSection = (freeze: Frozen, live: Record<string, unknown>, key: string, withClassifiers: Record<string, (id: string, value: unknown) => 'frozen' | 'live'>) =>
  resolveSection(freeze, live, { key, classifiers: withClassifiers });
const classifiers = { items: (id: string) => (id.startsWith('live') ? 'live' as const : 'frozen' as const) };

beforeEach(() => {
  registered.push(
    { key: 'pinned', merge: 'deep', freeze: 'frozen', schema: schema({ type: 'object', properties: { level: { type: 'number' } }, required: ['level'] }) },
    { key: 'floating', merge: 'deep', freeze: 'live', schema: schema({ type: 'object', properties: { mode: { type: 'string' } }, required: ['mode'] }) },
    { key: 'items', merge: 'deep', freeze: 'per_entry', schema: schema({ type: 'object', additionalProperties: Entry }), entrySchema: Entry },
  );
});
const dirs: string[] = [];
afterEach(() => {
  restoreProduction();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BASE = `roles:
  developer:
    agent: dev
agents:
  dev:
    client: { type: fake }
    model: fake-1
`;

function workspaceWith(extra: string): string {
  const workspace = mkdtempSync(path.join(tmpdir(), 'migent-freeze-sections-'));
  dirs.push(workspace);
  mkdirSync(path.join(workspace, '.migent'));
  writeFileSync(path.join(workspace, '.migent/config.yaml'), BASE + extra);
  return workspace;
}

function freeze(workspace: string, withClassifiers: Record<string, (id: string, value: unknown) => 'frozen' | 'live'> = classifiers): void {
  const workflow = parseWorkflowMapping(
    { schema_version: 7, id: 'flow', stages: [{ id: 'a', role: 'developer', depends_on: [] }] },
    'flow.yaml',
  );
  writeWorkflowFreeze(workspace, { workspace, workflow, classifiers: withClassifiers });
}

const fileOf = (workspace: string): string => path.join(workspace, WORKFLOW_FREEZE_FILE);
const rewrite = (workspace: string, change: (mapping: Record<string, unknown>) => void): void => {
  const mapping = parse(readFileSync(fileOf(workspace), 'utf8')) as Record<string, unknown>;
  change(mapping);
  writeFileSync(fileOf(workspace), stringify(mapping));
};

const ITEMS = 'items:\n  keep: { enabled: true }\n  live1: { enabled: false }\n';

test('a frozen section round-trips; a live section is not written; schema_version stays 2', () => {
  const workspace = workspaceWith('pinned: { level: 3 }\nfloating: { mode: fast }\n');
  freeze(workspace);
  const written = parse(readFileSync(fileOf(workspace), 'utf8')) as Record<string, unknown>;
  expect(written.schema_version).toBe(2);
  expect(written.config).toEqual({ pinned: { level: 3 } });
  expect(readWorkflowFreeze(workspace)?.config).toEqual({ pinned: { kind: 'frozen', value: { level: 3 } } });
});

test('a per_entry section writes the frozen subset and the sorted live ids', () => {
  const workspace = workspaceWith(`${ITEMS}  live0: { enabled: true }\n`);
  freeze(workspace);
  const written = parse(readFileSync(fileOf(workspace), 'utf8')) as { config: Record<string, unknown> };
  expect(written.config.items).toEqual({ entries: { keep: { enabled: true } }, live_entries: ['live0', 'live1'] });
});

test('an all-live per_entry section is written with entries {}', () => {
  const workspace = workspaceWith('items:\n  live1: { enabled: true }\n');
  freeze(workspace);
  const written = parse(readFileSync(fileOf(workspace), 'utf8')) as { config: Record<string, unknown> };
  expect(written.config.items).toEqual({ entries: {}, live_entries: ['live1'] });
});

test('no config key is written when no section is present', () => {
  const workspace = workspaceWith('');
  freeze(workspace);
  expect(readFileSync(fileOf(workspace), 'utf8')).not.toContain('config:');
  expect(readWorkflowFreeze(workspace)?.config).toEqual({});
});

test('a per_entry section without a classifier fails at the call', () => {
  const workspace = workspaceWith(ITEMS);
  expect(() => { freeze(workspace, {}); }).toThrow(/needs an entry classifier/);
});

test('an invalid merged section is refused at freeze time', () => {
  const workspace = workspaceWith('pinned: { level: high }\n');
  expect(() => { freeze(workspace); }).toThrow(/pinned/);
});

test('an unregistered top-level key and an unregistered config entry are ignored', () => {
  const workspace = workspaceWith('future_section: { a: 1 }\npinned: { level: 1 }\n');
  freeze(workspace);
  rewrite(workspace, (mapping) => { (mapping.config as Record<string, unknown>).unknown_section = 5; });
  expect(Object.keys(readWorkflowFreeze(workspace)?.config ?? {})).toEqual(['pinned']);
  expect(readFileSync(fileOf(workspace), 'utf8')).not.toContain('future_section');
});

test('an old freeze without config reads as no sections', () => {
  const workspace = workspaceWith('');
  freeze(workspace);
  const read = readWorkflowFreeze(workspace);
  expect(read?.config).toEqual({});
  const live = loadWorkspaceConfig(workspace);
  expect(effectiveConfigSection(read ?? { config: {} }, live, 'pinned', classifiers)).toBeNull();
  expect(effectiveConfigSection(read ?? { config: {} }, { floating: { mode: 'x' } }, 'floating', classifiers)).toEqual({ kind: 'live', value: { mode: 'x' } });
  expect(effectiveConfigSection(read ?? { config: {} }, { items: { live9: { enabled: true } } }, 'items', classifiers))
    .toEqual({ kind: 'per_entry', entries: {}, live: [{ id: 'live9', value: { enabled: true }, since: 'added' }], addedAfterFreeze: [] });
});

const corrupt: [string, (mapping: Record<string, unknown>) => void][] = [
  ['config is not a mapping', (m) => { m.config = 5; }],
  ['config is null', (m) => { m.config = null; }],
  ['a frozen value fails its schema', (m) => { m.config = { pinned: { level: 'x' } }; }],
  ['a per_entry value is not a mapping', (m) => { m.config = { items: 5 }; }],
  ['entries is not a mapping', (m) => { m.config = { items: { entries: [], live_entries: [] } }; }],
  ['an entry fails entrySchema', (m) => { m.config = { items: { entries: { a: { enabled: 'x' } }, live_entries: [] } }; }],
  ['live_entries is not an array', (m) => { m.config = { items: { entries: {}, live_entries: 'a' } }; }],
  ['live_entries has a blank id', (m) => { m.config = { items: { entries: {}, live_entries: [' '] } }; }],
  ['live_entries has a duplicate', (m) => { m.config = { items: { entries: {}, live_entries: ['a', 'a'] } }; }],
  ['an id is in both lists', (m) => { m.config = { items: { entries: { a: { enabled: true } }, live_entries: ['a'] } }; }],
];

test.each(corrupt)('corrupt freeze: %s', (_name, change) => {
  const workspace = workspaceWith('');
  freeze(workspace);
  rewrite(workspace, change);
  expect(() => readWorkflowFreeze(workspace)).toThrow(new RegExp(`Workflow freeze is corrupt: .*${WORKFLOW_FREEZE_FILE}`));
});

test('unknown keys beside entries and live_entries are ignored', () => {
  const workspace = workspaceWith('');
  freeze(workspace);
  rewrite(workspace, (m) => { m.config = { items: { entries: {}, live_entries: [], future: 1 } }; });
  expect(readWorkflowFreeze(workspace)?.config.items).toEqual({ kind: 'per_entry', entries: {}, liveEntries: [] });
});

test('resume: frozen entries ignore live edits, live entries follow them, new frozen ids are reported', () => {
  const workspace = workspaceWith('pinned: { level: 1 }\nitems:\n  keep: { enabled: true }\n  live1: { enabled: true }\n  gone: { enabled: true }\n');
  freeze(workspace);
  const frozen = readWorkflowFreeze(workspace);
  if (frozen === null) throw new Error('freeze missing');
  // Edit after the freeze: change both entries, drop `gone`, and add one live and one frozen id.
  const edited = {
    pinned: { level: 9 },
    items: {
      keep: { enabled: false },
      live1: { enabled: false },
      live2: { enabled: true },
      fresh: { enabled: true },
    },
  };
  expect(effectiveConfigSection(frozen, edited, 'pinned', classifiers)).toEqual({ kind: 'frozen', value: { level: 1 } });
  expect(effectiveConfigSection(frozen, edited, 'items', classifiers)).toEqual({
    kind: 'per_entry',
    // `keep` and `gone` stay frozen even though live config changed or dropped them.
    entries: { keep: { enabled: true }, gone: { enabled: true } },
    live: [
      { id: 'live1', value: { enabled: false }, since: 'freeze' },
      { id: 'live2', value: { enabled: true }, since: 'added' },
    ],
    addedAfterFreeze: ['fresh'],
  });
});

test('a removed live entry is absent, and a live id the classifier now freezes is reported', () => {
  const workspace = workspaceWith('items:\n  live1: { enabled: true }\n  live3: { enabled: true }\n');
  freeze(workspace);
  const frozen = readWorkflowFreeze(workspace);
  if (frozen === null) throw new Error('freeze missing');
  const live = { items: { live3: { enabled: true } } };
  expect(effectiveConfigSection(frozen, live, 'items', classifiers)).toMatchObject({ live: [{ id: 'live3', since: 'freeze' }] });
  const strict = { items: () => 'frozen' as const };
  expect(effectiveConfigSection(frozen, live, 'items', strict)).toMatchObject({ live: [], addedAfterFreeze: ['live3'] });
});

test('a live section is validated on read, and a per_entry section needs a classifier', () => {
  const frozen = { config: {} };
  expect(() => effectiveConfigSection(frozen, { floating: { mode: 1 } }, 'floating', {})).toThrow(/floating/);
  expect(() => effectiveConfigSection(frozen, { items: {} }, 'items', {})).toThrow(/needs an entry classifier/);
  expect(() => effectiveConfigSection(frozen, {}, 'nope', {})).toThrow(/not registered/);
});

test('an entry id named __proto__ is frozen and read back like any other', () => {
  const workspace = workspaceWith('');
  writeFileSync(path.join(workspace, '.migent/config.yaml'), `${BASE}items: {"__proto__": {enabled: true}, normal: {enabled: false}, live1: {enabled: true}}\n`);
  freeze(workspace);
  const read = readWorkflowFreeze(workspace)?.config.items;
  if (read?.kind !== 'per_entry') throw new Error('items not frozen');
  expect(Object.keys(read.entries).sort()).toEqual(['__proto__', 'normal']);
  expect(Object.getOwnPropertyDescriptor(read.entries, '__proto__')?.value).toEqual({ enabled: true });
  expect(read.liveEntries).toEqual(['live1']);
});

describe('a section keyed like an inherited property', () => {
  const classify = { constructor: (id: string) => (id.startsWith('live') ? 'live' as const : 'frozen' as const) };
  const config = (freezeKind: 'per_entry' | 'live'): ConfigSection => ({
    key: 'constructor', merge: 'deep', freeze: freezeKind,
    schema: schema({ type: 'object', additionalProperties: Entry }), entrySchema: Entry,
  });

  test('a missing classifier still fails at freeze and at resume', () => {
    registered.push(config('per_entry'));
    const workspace = workspaceWith('constructor:\n  one: { enabled: true }\n');
    expect(() => { freeze(workspace, {}); }).toThrow(/needs an entry classifier/);
    expect(() => resolveSection({ config: {} }, {}, { key: 'constructor', classifiers: {} })).toThrow(/needs an entry classifier/);
  });

  test('an absent per_entry section resolves as empty with an own classifier', () => {
    registered.push(config('per_entry'));
    expect(resolveSection({ config: {} }, {}, { key: 'constructor', classifiers: classify }))
      .toEqual({ kind: 'per_entry', entries: {}, live: [], addedAfterFreeze: [] });
  });

  test('an absent live section resolves as absent, and an own value is read', () => {
    registered.push(config('live'));
    expect(resolveSection({ config: {} }, {}, { key: 'constructor', classifiers: {} })).toBeNull();
    expect(resolveSection({ config: {} }, { constructor: { a: { enabled: true } } }, { key: 'constructor', classifiers: {} }))
      .toEqual({ kind: 'live', value: { a: { enabled: true } } });
  });

  test('a per_entry section round-trips through the freeze with an own classifier', () => {
    registered.push(config('per_entry'));
    const workspace = workspaceWith('constructor:\n  one: { enabled: true }\n  live1: { enabled: false }\n');
    freeze(workspace, classify);
    const read = readWorkflowFreeze(workspace);
    expect(read?.config.constructor).toEqual({ kind: 'per_entry', entries: { one: { enabled: true } }, liveEntries: ['live1'] });
    expect(resolveSection(read ?? { config: {} }, { constructor: { one: { enabled: false }, live1: { enabled: false } } }, { key: 'constructor', classifiers: classify }))
      .toMatchObject({ entries: { one: { enabled: true } }, live: [{ id: 'live1', since: 'freeze' }] });
  });
});
