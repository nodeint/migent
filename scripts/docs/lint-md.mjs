/**
 * Markdown lint for the repository, or for explicit paths.
 *
 * `markdownlint-cli2` also applies globs from `.markdownlint-cli2.jsonc`.
 * Pass `--no-globs` when paths are listed so those globs do not expand
 * the run to the rest of the repo.
 *
 * Usage:
 *   node scripts/docs/lint-md.mjs
 *   node scripts/docs/lint-md.mjs <paths...>
 *   node scripts/docs/lint-md.mjs --fix [paths...]
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { REPO_ROOT } from '../lib/repo.mjs';

const require = createRequire(import.meta.url);
const cliBin = join(dirname(require.resolve('markdownlint-cli2')), 'markdownlint-cli2-bin.mjs');

const argv = process.argv.slice(2);
const fix = argv.includes('--fix');
const paths = argv.filter((arg) => arg !== '--fix' && arg !== '--');

/** @type {string[]} */
const args = [];
if (fix) args.push('--fix');
if (paths.length > 0) args.push('--no-globs', ...paths);

const result = spawnSync(process.execPath, [cliBin, ...args], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
