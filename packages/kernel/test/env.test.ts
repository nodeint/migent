import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENV_CATALOG } from '@nodeint/migent-contracts';
import { afterEach, describe, expect, test } from 'vitest';

import { debugEnabled, inheritedEnv, migentHomeOverride, noInputRequested, platformHome, skillsChildEnv } from '../src/env.js';

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

const readers: Record<string, () => boolean> = { MIGENT_DEBUG: debugEnabled, MIGENT_NO_INPUT: noInputRequested };

// Names come from the actual `process.env.NAME` accesses in env.ts, not from a hand-kept list.
// Platform `HOME` and `ComSpec` are not Migent contracts. Computed access (`process.env[...]`) is not allowed there.
const PLATFORM_VARIABLES = new Set(['HOME', 'ComSpec']);
test('the catalog names exactly the Migent variables env.ts accesses', () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'env.ts'), 'utf8');
  expect(source).not.toMatch(/process\.env\s*\[/);
  const accessed = [...new Set([...source.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!))]
    .filter((name) => !PLATFORM_VARIABLES.has(name));
  expect(ENV_CATALOG.map((entry) => entry.name).sort()).toEqual(accessed.sort());
});

describe('catalog kinds match readers', () => {
  for (const entry of ENV_CATALOG) {
    test(entry.name, () => {
      if (entry.kind === 'flag') {
        const read = readers[entry.name]!;
        for (const value of entry.enabling_values) {
          process.env[entry.name] = value;
          expect(read()).toBe(true);
        }
        delete process.env[entry.name];
        expect(read()).toBe(false);
        for (const value of ['', '0', 'TRUE', 'yes', ' 1'].filter((v) => !(entry.enabling_values as readonly string[]).includes(v))) {
          process.env[entry.name] = value;
          expect(read()).toBe(false);
        }
      } else if (entry.kind === 'path') {
        process.env[entry.name] = '  /x y ';
        expect(migentHomeOverride()).toBe('  /x y ');
        process.env[entry.name] = '';
        expect(migentHomeOverride()).toBeUndefined();
        delete process.env[entry.name];
        expect(migentHomeOverride()).toBeUndefined();
      } else {
        process.env.KEEP_ME = 'yes';
        process.env[entry.name] = '';
        expect(skillsChildEnv()[entry.name]).toBe('');
        process.env[entry.name] = '0';
        expect(skillsChildEnv()[entry.name]).toBe('0');
        delete process.env[entry.name];
        const env = skillsChildEnv();
        expect(env[entry.name]).toBe(entry.default_value);
        expect(env.KEEP_ME).toBe('yes');
      }
    });
  }
});

test('passthrough accessors', () => {
  expect(inheritedEnv()).toBe(process.env);
  process.env.HOME = '/h';
  expect(platformHome()).toBe('/h');
});

// `process.env` is read in one module, so the environment contract has one owner.
test('no production source touches process.env outside the kernel env module', () => {
  const packages = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return name === 'dist' || name === 'node_modules' ? [] : walk(full);
      return full.endsWith('.ts') ? [full] : [];
    });
  const offenders = readdirSync(packages)
    .map((name) => path.join(packages, name, 'src'))
    .filter((dir) => { try { return statSync(dir).isDirectory(); } catch { return false; } })
    .flatMap(walk)
    .filter((file) => path.relative(packages, file) !== path.join('kernel', 'src', 'env.ts'))
    .filter((file) => /process\.env\b/.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(packages, file));
  expect(offenders).toEqual([]);
});
