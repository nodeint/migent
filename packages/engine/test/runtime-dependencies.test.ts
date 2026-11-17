import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const runtimeDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'runtime');
const sources = readdirSync(runtimeDir)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => ({ name, text: readFileSync(path.join(runtimeDir, name), 'utf8') }));

function importSpecifiers(text: string): string[] {
  return [...text.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
}

describe('operation runtime dependencies', () => {
  it('has runtime modules to inspect', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it('imports only its own modules and the kernel debug channel', () => {
    for (const { name, text } of sources) {
      for (const specifier of importSpecifiers(text)) {
        const allowed = specifier.startsWith('./') || specifier === '@nodeint/migent-kernel';
        expect(allowed, `${name} imports ${specifier}`).toBe(true);
      }
    }
  });

  it('never imports execution, session, or prompts', () => {
    for (const { name, text } of sources) {
      expect(text, name).not.toMatch(/\.\.\/execution|migent-session|migent-prompts/);
    }
  });

  it('names no execution operation and branches on no scenario', () => {
    for (const { name, text } of sources) {
      expect(text, name).not.toMatch(/agent\.turn|reply\.gate|verify\.run|run\.verify|verify-only|role execution/i);
    }
  });
});
