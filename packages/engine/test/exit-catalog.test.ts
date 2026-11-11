import { EXIT_CATALOG } from '@nodeint/migent-contracts';
import { expect, test } from 'vitest';

import { EXECUTE_EXIT_CODES } from '../src/execute.ts';

test('every kernel stop reason maps to the catalog code of the same name', () => {
  const byName = new Map<string, number>(EXIT_CATALOG.map((entry) => [entry.name, entry.code]));
  for (const [reason, code] of Object.entries(EXECUTE_EXIT_CODES)) {
    if (reason === 'stage') {
      expect(code).toBe(0);
      continue;
    }
    expect(byName.get(reason), reason).toBe(code);
  }
  for (const entry of EXIT_CATALOG) {
    if (entry.name !== 'config') expect(EXECUTE_EXIT_CODES[entry.name], entry.name).toBe(entry.code);
  }
});
