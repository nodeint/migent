import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

test('the base hash covers raw bytes, even when they are not valid UTF-8', () => {
  const bytes = Buffer.from([0x61, 0xff, 0xfe, 0x0a]);
  writeFileSync(file, bytes);
  const result = writeFileConditional(file, 'new\n', { baseHash: sha256Hex(bytes) });
  expect(result.status).toBe('written');
  expect(readFileSync(file, 'utf8')).toBe('new\n');
});

test('a missing file never matches a base hash', () => {
  expect(writeFileConditional(file, 'x\n', { baseHash: '0'.repeat(64) })).toMatchObject({ status: 'stale-base', currentHash: null });
});

test('a filesystem without hard links writes nothing and reports create-unsupported', () => {
  const unsupported = () => { throw Object.assign(new Error('nope'), { code: 'EPERM' }); };
  const result = writeFileConditional(file, 'x\n', { link: unsupported });
  expect(result.status).toBe('create-unsupported');
  expect(readdirSync(dir)).toEqual([]);
});
