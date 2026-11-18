/**
 * Integration test runner with scoped selection.
 *
 * Wraps `vitest run --project integration`:
 *   --file <suite>  Run only test files whose path contains <suite>; repeatable.
 *   --case <name>   Run only tests whose full name matches <name> (`vitest -t`); once.
 *   other args      Pass through to vitest unchanged.
 *
 * Usage:
 *   node scripts/wrappers/run-integration.mjs
 *   node scripts/wrappers/run-integration.mjs --file cancel
 *   node scripts/wrappers/run-integration.mjs --file cancel --case "stops the run"
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT } from '../lib/repo.mjs';

/**
 * Read the value of a flag given as `--name value` or `--name=value`.
 *
 * @param {string[]} argv
 * @param {number} index
 * @param {string} name
 * @returns {{ value: string, next: number } | null} `null` when `argv[index]` is not this flag.
 */
function readFlagValue(argv, index, name) {
  const arg = argv[index];
  if (arg.startsWith(`${name}=`)) {
    const value = arg.slice(name.length + 1);
    if (value === '') throw new Error(`${name} requires a value`);
    return { value, next: index };
  }
  if (arg !== name) return null;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`);
  return { value, next: index + 1 };
}

/**
 * Translate wrapper arguments into vitest arguments.
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
export function buildVitestArgs(argv) {
  /** @type {string[]} */
  const files = [];
  /** @type {string | undefined} */
  let testCase;
  /** @type {string[]} */
  const passthrough = [];
  for (let index = 0; index < argv.length; index += 1) {
    const file = readFlagValue(argv, index, '--file');
    if (file) {
      files.push(file.value);
      index = file.next;
      continue;
    }
    const selected = readFlagValue(argv, index, '--case');
    if (selected) {
      if (testCase !== undefined) throw new Error('--case may be given only once');
      testCase = selected.value;
      index = selected.next;
      continue;
    }
    if (argv[index] !== '--') passthrough.push(argv[index]);
  }
  if (testCase !== undefined && files.length === 0) {
    throw new Error('--case requires --file so the case is looked up in a known suite');
  }
  return [
    'run',
    '--project',
    'integration',
    ...files,
    ...(testCase === undefined ? [] : ['-t', testCase]),
    ...passthrough,
  ];
}

function main() {
  /** @type {string[]} */
  let vitestArgs;
  try {
    vitestArgs = buildVitestArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`run-integration: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  const require = createRequire(import.meta.url);
  const packageDir = dirname(require.resolve('vitest/package.json'));
  const { bin } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const vitestBin = join(packageDir, typeof bin === 'string' ? bin : bin.vitest);

  const selected = vitestArgs.some((arg, index) => index >= 3 && !arg.startsWith('-'));
  const reportDir = selected ? mkdtempSync(join(tmpdir(), 'migent-integration-')) : undefined;
  const reportFile = reportDir && join(reportDir, 'report.json');
  // A selection must run at least one test: vitest exits 0 when -t skips everything.
  const reporterArgs = reportFile
    ? ['--reporter=agent', '--reporter=json', `--outputFile.json=${reportFile}`]
    : [];

  try {
    const result = spawnSync(process.execPath, [vitestBin, ...vitestArgs, ...reporterArgs], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: process.env,
    });
    if (result.error) {
      console.error(result.error);
      process.exit(1);
    }
    const status = result.status === null ? 1 : result.status;
    if (status === 0 && reportFile && executedTests(reportFile) === 0) {
      console.error('run-integration: the selection ran no tests (all skipped or none matched)');
      process.exit(1);
    }
    process.exit(status);
  } finally {
    if (reportDir) rmSync(reportDir, { recursive: true, force: true });
  }
}

/**
 * Count the tests that actually ran, from a vitest JSON report.
 *
 * @param {string} reportFile
 * @returns {number}
 */
function executedTests(reportFile) {
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  return report.numPassedTests + report.numFailedTests;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
