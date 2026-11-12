import { ClaudeCodeClient, ModelCatalog } from '@nodeint/migent-adapters';
import { expect, test } from 'vitest';

import { acceptedOptions } from '../src/client.ts';

const catalog = new ModelCatalog(['opus'], null, []);
const found = (command: string): string => `/bin/${command}`;

test('options accepted without help verification are reported, not blocked', async () => {
  for (const failure of ['unreadable', 'No headless options found in help.']) {
    const warnings: string[] = [];
    const stored = await acceptedOptions(new ClaudeCodeClient(), {
      model: 'opus',
      catalog,
      which: found,
      runCommand: () => '',
      helpCommand: () => { throw new Error(failure); },
      warn: (message) => warnings.push(message),
      options: { nonexistent_thing: '1' },
    });
    expect(stored).toEqual({ nonexistent_thing: '1' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Could not verify claude-code options');
  }
});

test('a command that is not on PATH warns too', async () => {
  const warnings: string[] = [];
  await acceptedOptions(new ClaudeCodeClient(), {
    model: 'opus', catalog, which: () => null, runCommand: () => '', warn: (m) => warnings.push(m), options: { a: '1' },
  });
  expect(warnings[0]).toContain('is not on PATH');
});
