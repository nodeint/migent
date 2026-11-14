import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('built ./data entry', () => {
  it('maps the ./data export to dist/data', () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { exports: Record<string, { import: string }> };
    expect(manifest.exports['./data']?.import).toBe('./dist/data/index.js');
  });

  it('loads in a fresh process without typebox', () => {
    const entry = pathToFileURL(path.join(packageRoot, 'dist', 'data', 'index.js')).href;
    const script = `const mod = await import(${JSON.stringify(entry)}); console.log(Object.keys(mod).length);`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(Number(out)).toBeGreaterThan(0);
    // No emitted data module imports a package (typebox included) or a file outside data/.
    for (const file of ['index', 'exits', 'statuses', 'versions']) {
      const source = readFileSync(path.join(packageRoot, 'dist', 'data', `${file}.js`), 'utf8');
      const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
      for (const specifier of specifiers) expect(specifier, file).toMatch(/^\.\/(?!\.)/);
    }
  });
});
