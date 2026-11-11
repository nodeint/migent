import { expect, test } from 'vitest';

import { type CatalogSource,ClientCommandFailed, clientsListingModel, loadCatalog, loadCatalogSync } from '../src/index.ts';

const source: CatalogSource = {
  command: 'fake',
  modelCatalogCommand: () => ['fake', 'models'],
  parseModelCatalog: (stdout) => ({ ids: stdout.split('\n').filter(Boolean), valuesFor: () => null }),
} as unknown as CatalogSource;

test('sync and async loaders agree on results and messages', async () => {
  const cases: [() => string | null, (argv: string[]) => string][] = [
    [() => '/bin/fake', () => 'a\nb\n'],
    [() => null, () => 'a'],
    [() => '/bin/fake', () => ''],
    [() => '/bin/fake', () => { throw new Error('boom'); }],
  ];
  for (const [which, run] of cases) {
    const sync = (() => { try { return loadCatalogSync(source, which, run).ids; } catch (e) { return (e as Error).message; } })();
    const asyncIds = await loadCatalog(source, which, run).then((c) => c.ids, (e) => (e as Error).message);
    expect(sync).toEqual(asyncIds);
  }
  expect(() => loadCatalogSync(source, () => null, () => '')).toThrow(ClientCommandFailed);
});

test('model lookup policy strips opencode variants and reports skipped and failed clients', () => {
  const result = clientsListingModel('p/m#high', [
    { id: 'opencode', command: 'opencode', outcome: { status: 'loaded', ids: ['p/m'] } },
    { id: 'codex', command: 'codex', outcome: { status: 'skipped' } },
    { id: 'grok', command: 'grok', outcome: { status: 'failed', reason: 'x' } },
    { id: 'agy', command: 'agy', outcome: { status: 'loaded', ids: ['other'] } },
  ]);
  expect(result).toEqual({ matches: ['opencode'], searched: ['opencode', 'agy'], skipped: ['codex'], failed: [{ client: 'grok', reason: 'x' }] });
});
