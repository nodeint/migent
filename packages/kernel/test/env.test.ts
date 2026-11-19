import { ENV_CATALOG } from '@nodeint/migent-contracts';
import { afterEach, describe, expect, test } from 'vitest';

import { debugEnabled, inheritedEnv, migentHomeOverride, noInputRequested, platformHome, skillsChildEnv } from '../src/env.js';

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

const readers: Record<string, () => boolean> = { MIGENT_DEBUG: debugEnabled, MIGENT_NO_INPUT: noInputRequested };

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
