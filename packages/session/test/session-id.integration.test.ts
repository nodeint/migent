import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { expect, test } from 'vitest';

import { tempDir } from './support.ts';

function sessions(): string {
  return path.join(tempDir('migent-ids-'), 'sessions');
}

test('concurrent processes get distinct contiguous ids', async () => {
  const dir = sessions();
  mkdirSync(dir, { recursive: true });
  const start = path.join(path.dirname(dir), 'go');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const children = Array.from({ length: 6 }, () => {
    const child = spawn(
      process.execPath,
      ['--experimental-transform-types', '--import', pathToFileURL(path.join(here, 'ts-register.mjs')).href, path.join(here, 'session-id-worker.ts'), dir, start, '10'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return new Promise<string[]>((resolve, reject) => {
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
      child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out) as string[]) : reject(new Error(err))));
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  writeFileSync(start, '');
  const all = (await Promise.all(children)).flat().map(Number).sort((a, b) => a - b);
  expect(all).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
}, 60000);
