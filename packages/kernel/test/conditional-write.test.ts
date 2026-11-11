import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { sha256Hex } from '../src/authoring.ts';
import { writeFileConditional } from '../src/conditional-write.ts';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'migent-cw-'));
  file = path.join(dir, 'x.yaml');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Starts `count` processes that all write at the same moment, and returns what each reported. */
async function race(base: string | null, count: number): Promise<{ tag: string; status: string }[]> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const start = path.join(dir, 'go');
  const children = Array.from({ length: count }, (_, i) => {
    const child = spawn(
      process.execPath,
      ['--experimental-transform-types', '--import', pathToFileURL(path.join(here, 'ts-register.mjs')).href, path.join(here, 'conditional-write-worker.ts'), file, start, base ?? '-', `w${i}`],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return new Promise<{ tag: string; status: string }>((resolve, reject) => {
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
      child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  writeFileSync(start, '');
  return Promise.all(children);
}

function expectWholeFileFrom(winner: string): void {
  expect(readFileSync(file, 'utf8')).toBe(`${winner}\n`.repeat(20_000));
  expect(readdirSync(dir).filter((name) => name !== 'go')).toEqual(['x.yaml']);
}

test('racing creates across processes: one winner, the rest conflict, the file is whole', async () => {
  const results = await race(null, 6);
  const winners = results.filter((r) => r.status === 'written');
  expect(winners).toHaveLength(1);
  expect(results.filter((r) => r.status === 'already-exists')).toHaveLength(5);
  expectWholeFileFrom(winners[0]!.tag);
}, 30_000);

test('racing updates from one base across processes: one winner, the rest are stale', async () => {
  writeFileSync(file, 'base\n');
  const results = await race(sha256Hex('base\n'), 6);
  const winners = results.filter((r) => r.status === 'written');
  expect(winners).toHaveLength(1);
  expect(results.filter((r) => r.status === 'stale-base')).toHaveLength(5);
  expectWholeFileFrom(winners[0]!.tag);
}, 30_000);

test('the base hash covers raw bytes, even when they are not valid UTF-8', () => {
  const bytes = Buffer.from([0x61, 0xff, 0xfe, 0x0a]);
  writeFileSync(file, bytes);
  const result = writeFileConditional(file, 'new\n', sha256Hex(bytes));
  expect(result.status).toBe('written');
  expect(readFileSync(file, 'utf8')).toBe('new\n');
});

test('a missing file never matches a base hash', () => {
  expect(writeFileConditional(file, 'x\n', '0'.repeat(64))).toMatchObject({ status: 'stale-base', currentHash: null });
});

test('a filesystem without hard links writes nothing and reports create-unsupported', () => {
  const unsupported = () => { throw Object.assign(new Error('nope'), { code: 'EPERM' }); };
  const result = writeFileConditional(file, 'x\n', null, { link: unsupported });
  expect(result.status).toBe('create-unsupported');
  expect(readdirSync(dir)).toEqual([]);
});
