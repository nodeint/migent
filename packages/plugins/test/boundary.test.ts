import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NAME = '@nodeint/migent-plugins';

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (entry === 'node_modules' || entry === 'dist') return [];
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

test('packages/plugins imports only contracts', () => {
  const imports = files(path.join(repo, 'packages', 'plugins', 'src'))
    .filter((file) => file.endsWith('.ts'))
    .flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/from '(@nodeint\/[^']+)'/g)].map((match) => match[1]));
  expect(imports.every((name) => name === '@nodeint/migent-contracts')).toBe(true);
  const manifest = JSON.parse(readFileSync(path.join(repo, 'packages', 'plugins', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  expect(Object.keys(manifest.dependencies).filter((name) => name.startsWith('@nodeint/'))).toEqual(['@nodeint/migent-contracts']);
});

test('only cli depends on the plugins package', () => {
  const owners = readdirSync(path.join(repo, 'packages')).filter((name) => {
    const text = readFileSync(path.join(repo, 'packages', name, 'package.json'), 'utf8');
    const manifest = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
    const groups = [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies];
    return groups.some((group) => group && NAME in group);
  });
  expect(owners).toEqual(['cli']);
});

test('no other package source imports the plugins package', () => {
  const offenders = readdirSync(path.join(repo, 'packages'))
    .filter((name) => !['cli', 'plugins'].includes(name))
    .flatMap((name) => files(path.join(repo, 'packages', name, 'src')))
    .filter((file) => file.endsWith('.ts') && readFileSync(file, 'utf8').includes(NAME));
  expect(offenders).toEqual([]);
});
