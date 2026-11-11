import * as fs from 'node:fs';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import { appendLineSynced, isAtomicTempName, sealTornTail, writeFileAtomic } from '../src/atomic-file.js';

function temp(): string {
  return mkdtempSync(path.join(tmpdir(), 'migent-atomic-'));
}

test('writeFileAtomic replaces the file and leaves no temp file', () => {
  const dir = temp();
  try {
    const file = path.join(dir, 'status.json');
    writeFileAtomic(file, 'one');
    writeFileAtomic(file, 'two');
    expect(readFileSync(file, 'utf8')).toBe('two');
    expect(readdirSync(dir)).toEqual(['status.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a write that fails before rename keeps the old file', () => {
  const dir = temp();
  try {
    const file = path.join(dir, 'status.json');
    writeFileSync(file, 'old');
    const target = path.join(dir, 'missing', 'status.json');
    expect(() => writeFileAtomic(target, 'new')).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('old');
    expect(readdirSync(dir)).toEqual(['status.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('temp names are recognised so readers can ignore them', () => {
  expect(isAtomicTempName('.status.json.abc123.tmp')).toBe(true);
  expect(isAtomicTempName('status.json')).toBe(false);
});

test('appendLineSynced writes whole lines', () => {
  const dir = temp();
  try {
    const file = path.join(dir, 'events.jsonl');
    appendLineSynced(file, '{"a":1}');
    appendLineSynced(file, '{"b":2}\n');
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}\n{"b":2}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendLineSynced keeps a torn tail on its own line', () => {
  const dir = temp();
  try {
    const file = path.join(dir, 'events.jsonl');
    writeFileSync(file, '{"a":1}\n{"torn"', 'utf8');
    appendLineSynced(file, '{"b":2}');
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}\n{"torn"\n{"b":2}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sealTornTail closes the tail without rewriting the line', () => {
  const dir = temp();
  try {
    const file = path.join(dir, 'events.jsonl');
    writeFileSync(file, '{"a":1}', 'utf8');
    sealTornTail(file);
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}\n');
    sealTornTail(file);
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}\n');
    expect(sealTornTail(path.join(dir, 'missing.jsonl'))).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
