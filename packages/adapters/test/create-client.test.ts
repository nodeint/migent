import { loadAgentTarget } from '@nodeint/migent-kernel';
import { expect, test } from 'vitest';

import { clientIds, createClient, GrokClient, OpencodeClient } from '../src/index.ts';

const registry = { ids: () => clientIds(), get: (id: string) => createClient(id) };

test('model effort follows the bound client through to Grok command arguments', () => {
  const target = loadAgentTarget({ agents: { fast: { client: { type: 'grok' }, model: 'test', effort: 'high' } } }, 'fast', { registry });
  const client = new GrokClient();
  const command = client.runCommand({
    model: target.model, options: target.options, workspace: '.', prompt: 'test',
    agentId: null, newAgentId: null, promptFile: 'prompt.md', lastMessageFile: 'last.md',
  });
  const index = command.argv.indexOf('--reasoning-effort');
  expect(index).toBeGreaterThan(0);
  expect(command.argv[index + 1]).toBe('high');
  expect(command.argv).not.toContain('--effort');
  expect(new OpencodeClient().effortOption).toBe('variant');
});
