import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/** Per-test timeout, in milliseconds. Windows runners start processes and touch files more slowly. */
const TEST_TIMEOUT_MS = 10_000;
const WINDOWS_TEST_TIMEOUT_MS = 30_000;

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@nodeint/migent-contracts': path.join(root, 'packages/contracts/src/index.ts'),
      '@nodeint/migent-workflow': path.join(root, 'packages/workflow/src/index.ts'),
      '@nodeint/migent-adapters': path.join(root, 'packages/adapters/src/index.ts'),
      '@nodeint/migent-prompts': path.join(root, 'packages/prompts/src/index.ts'),
      '@nodeint/migent-doctor': path.join(root, 'packages/doctor/src/index.ts'),
      '@nodeint/migent-kernel': path.join(root, 'packages/kernel/src/index.ts'),
      '@nodeint/migent-session': path.join(root, 'packages/session/src/index.ts'),
      '@nodeint/migent-engine': path.join(root, 'packages/engine/src/index.ts'),
      '@nodeint/migent-registry': path.join(root, 'packages/registry/src/index.ts'),
    },
  },
  test: {
    // Windows runners start processes and touch files more slowly.
    testTimeout: process.platform === 'win32' ? WINDOWS_TEST_TIMEOUT_MS : TEST_TIMEOUT_MS,
    reporters: [['dot', { summary: false }]],
    silent: true,
    setupFiles: ['scripts/vitest-quiet-setup.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/**/*.test.ts', 'integration/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
        },
      },
      {
        // Real child processes and sockets: run apart from the parallel unit pool.
        extends: true,
        test: {
          name: 'integration',
          include: ['packages/**/*.integration.test.ts', 'integration/**/*.integration.test.ts'],
          fileParallelism: false,
        },
      },
    ],
  },
});
