import { describe, expect, it } from 'vitest';

import * as data from '../src/data/index.js';
import * as root from '../src/index.js';

describe('./data layer', () => {
  it('exports the same references as the root entry', () => {
    for (const name of ['EXIT_CATALOG', 'EXIT_FAMILIES', 'EXIT_FAMILY_TITLES', 'exitCode', 'exitLines', 'HANDOFF_SCHEMA_VERSION', 'LIFECYCLE_EVENT_VERSION', 'EXECUTION_SCHEMA_VERSION', 'DIAGNOSTICS_SCHEMA_VERSION', 'MANIFEST_SCHEMA_VERSION', 'QUESTIONS_SCHEMA_VERSION', 'NEXT_SCHEMA_VERSION'] as const) {
      expect(root[name], name).toBe(data[name]);
    }
  });
});
