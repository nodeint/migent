/**
 * Cross-platform eslint runner with a larger V8 heap.
 * Avoids Unix-only `NODE_OPTIONS=… cmd` which fails on Windows cmd.exe.
 *
 * With no path arguments, lints the repository (`.`).
 * Pass paths to lint those files only.
 *
 * Usage:
 *   node scripts/wrappers/run-eslint.mjs [--max-warnings 0] [--fix]
 *   node scripts/wrappers/run-eslint.mjs [--max-warnings 0] <paths...>
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
// `eslint/bin/eslint.js` is not on package "exports" — resolve via package root.
const eslintBin = join(dirname(require.resolve('eslint/package.json')), 'bin', 'eslint.js');
const heapMb = process.env.ESLINT_MAX_OLD_SPACE_SIZE ?? '4096';

const VALUE_FLAGS = new Set(['--max-warnings']);

/**
 * @param {string[]} argv
 * @returns {{ flags: string[], paths: string[] }}
 */
function splitArgv(argv) {
  /** @type {string[]} */
  const flags = [];
  /** @type {string[]} */
  const paths = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg.startsWith('-')) {
      flags.push(arg);
      const value = argv[index + 1];
      const takesValue = VALUE_FLAGS.has(arg) && value && !value.startsWith('-');
      if (takesValue) {
        flags.push(value);
        index += 1;
      }
      continue;
    }
    paths.push(arg);
  }
  return { flags, paths };
}

const { flags, paths } = splitArgv(process.argv.slice(2));
const targets = paths.length > 0 ? paths : ['.'];
if (paths.length > 0) flags.push('--no-warn-ignored');

const result = spawnSync(
  process.execPath,
  [`--max-old-space-size=${heapMb}`, eslintBin, ...flags, ...targets],
  {
    stdio: 'inherit',
    env: process.env,
  },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
