import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { migentHomeOverride } from '@nodeint/migent-kernel';

import { DIRECTORY_MODE } from './constants.js';

export const homeOs = {
  homedir(): string {
    return homedir();
  },
};

export function migentHomePath(): string {
  const override = migentHomeOverride();
  if (override) return override;
  return path.join(homeOs.homedir(), '.migent');
}

export function registryHomePath(): string {
  return path.join(migentHomePath(), 'registry');
}

export function ensureRegistryHome(directory?: string): string {
  const target = directory ?? registryHomePath();
  mkdirSync(target, { recursive: true, mode: DIRECTORY_MODE });
  chmodSync(target, DIRECTORY_MODE);
  return target;
}
