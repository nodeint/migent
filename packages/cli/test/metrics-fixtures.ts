import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const created: string[] = [];

/** A temporary directory that `removeTempDirs` deletes. Call it from `afterEach`. */
export function tempDir(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  created.push(directory);
  return directory;
}

export function removeTempDirs(): void {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true });
}
