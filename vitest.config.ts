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
      '@nodeint/migent-plugins': path.join(root, 'packages/plugins/src/index.ts'),
      '@nodeint/migent-registry': path.join(root, 'packages/registry/src/index.ts'),
    },
  },
  test: {
    // Windows runners start processes and touch files more slowly.
    testTimeout: process.platform === 'win32' ? WINDOWS_TEST_TIMEOUT_MS : TEST_TIMEOUT_MS,
    // Print failures only: no per-test dots, no passing output.
    reporters: ['agent'],
    silent: true,
    setupFiles: ['scripts/vitest-quiet-setup.ts'],
    // Measured only with `--coverage` (`pnpm test:coverage`); the unit project is the measured suite.
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.d.ts', '**/dist/**'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/**/*.test.ts', 'integration/**/*.test.ts', 'scripts/**/*.test.mjs'],
          exclude: ['**/node_modules/**', '**/*.integration.test.ts', '**/*.integration.test.mjs'],
        },
      },
      {
        // Real child processes and sockets: run apart from the parallel unit pool.
        extends: true,
        test: {
          name: 'integration',
          include: [
            'packages/**/*.integration.test.ts',
            'integration/**/*.integration.test.ts',
            'scripts/**/*.integration.test.mjs',
          ],
          fileParallelism: false,
        },
      },
    ],
  },
});
