import { ClaudeCodeClient, GrokClient } from '@nodeint/migent-adapters';
import type { CliModelCatalog } from '@nodeint/migent-kernel';
import { expect, test } from 'vitest';

import { clientCatalogSource, loadCatalog, loadOptionValues } from '../src/catalog.ts';

const CATALOG = JSON.stringify({
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: 'migent-models',
    response: {
      models: [
        { value: 'opus', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: ['low', 'high'] },
      ],
    },
  },
});

test("a client catalog source sends the client's own stdin and argv", async () => {
  const client = new ClaudeCodeClient();
  const source = clientCatalogSource(client);
  let seen: { argv: string[]; input?: string } | null = null;
  const catalog = await loadCatalog(source, () => '/bin/claude', (argv, input) => {
    seen = { argv, ...(input === undefined ? {} : { input }) };
    return CATALOG;
  });
  expect(catalog.ids).toContain('opus');
  expect(catalog.valuesFor('opus', 'effort')).toEqual(['low', 'high']);
  expect(seen?.argv).toEqual(client.modelsCommand().argv);
  expect(seen?.input).toContain('migent-models');
});

test('a client option-values command keeps the shared loader behavior', async () => {
  const client = new GrokClient();
  const catalog: CliModelCatalog = { ids: ['grok-4'], defaultId: null, optionValues: [], valuesFor: () => null };
  let seen: string[] | undefined;
  const values = await loadOptionValues(clientCatalogSource(client), 'reasoning-effort', 'grok-4', catalog, () => '/bin/grok', (argv) => {
    seen = argv;
    return 'use one of: low, high';
  });
  expect(values).toEqual(['low', 'high']);
  expect(seen).toEqual(client.optionValuesCommand('reasoning-effort', 'grok-4')?.argv);
});
