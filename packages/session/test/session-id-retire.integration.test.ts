import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { expect, test } from 'vitest';

import { readLastIdMark } from '../src/session-id.ts';
import { tempDir } from './support.ts';

function sessions(): string {
  return path.join(tempDir('migent-retire-'), 'sessions');
}

test('concurrent processes retiring up and down leave the highest mark', async () => {
  const dir = sessions();
  mkdirSync(dir, { recursive: true });
  const start = path.join(path.dirname(dir), 'go');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const run = (from: number, to: number) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--experimental-transform-types', '--import', pathToFileURL(path.join(here, 'ts-register.mjs')).href, path.join(here, 'session-id-retire-worker.ts'), dir, start, String(from), String(to)],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let err = '';
      child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err))));
    });
  const all = [run(1, 40), run(40, 1), run(20, 60)];
  await new Promise((resolve) => setTimeout(resolve, 1500));
  writeFileSync(start, '');
  await Promise.all(all);
  expect(readLastIdMark(dir)).toBe(60);
}, 60_000);
