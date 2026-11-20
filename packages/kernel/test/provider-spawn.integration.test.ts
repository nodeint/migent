import { expect, test } from 'vitest';

import { spawnProviderSync } from '../src/provider-spawn.ts';

test('sync spawn runs a command and reports a missing one', () => {
  const ok = spawnProviderSync(process.execPath, ['-e', "process.stdout.write('hi')"], { encoding: 'utf8' });
  expect(ok.status).toBe(0);
  expect(ok.stdout).toBe('hi');
  const missing = spawnProviderSync('migent-no-such-binary', [], { encoding: 'utf8' });
  expect((missing.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOENT');
});
