import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

import { childInvocation } from '../src/child.ts';
import { RegistryBusy } from '../src/locks.ts';
import { RegistryStore } from '../src/store.ts';
import { makeWorkspace, TOOL } from './support.ts';

const locksModule = new URL('../src/locks.ts', import.meta.url);

test('cross process lock returns busy', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'registry-store-'));
  const directory = path.join(root, 'registry');
  mkdirSync(directory);
  const lockPath = path.join(directory, 'registry.lock');
  const script = `
    const { interprocessLock, registryBusy } = await import(${JSON.stringify(locksModule.href)});
    await interprocessLock(process.argv[1], { shared: false, timeoutSec: 2, busyError: registryBusy }, async () => {
      process.stdout.write("locked\\n");
      await new Promise(() => setInterval(() => undefined, 1000));
    });
  `;
  // Strip types and map .js imports to .ts, as the registry child does when run from source.
  const invocation = childInvocation(fileURLToPath(locksModule));
  const proc = spawn(process.execPath, [...invocation.args, '--input-type=module', '-e', script, lockPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  try {
    const line = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error(`lock helper silent: ${stderr}`)), 3000);
      proc.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        if (buffer.includes('\n')) {
          clearTimeout(timer);
          resolve(buffer);
        }
      });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`lock helper exited ${code}: ${stderr}`));
      });
    });
    expect(line.trim()).toBe('locked');
    const workspace = makeWorkspace(root, 'demo');
    const store = new RegistryStore(directory, 0.2);
    await expect(store.register(workspace, null, TOOL)).rejects.toBeInstanceOf(RegistryBusy);
  } finally {
    proc.kill('SIGKILL');
    await new Promise((resolve) => proc.once('exit', resolve));
  }
});
