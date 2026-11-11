import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';

import { tempPathFor, writeFileAtomic } from './atomic-file.js';
import { sha256Hex } from './authoring.js';
import { withFileLockSync } from './file-lock.js';

export type ConditionalWrite =
  | { status: 'written'; hash: string; replaced: boolean; previous: string | null }
  | { status: 'stale-base'; currentHash: string | null }
  | { status: 'already-exists' }
  | { status: 'create-unsupported'; reason: string };

const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK']);

function readIfExists(file: string): Buffer | null {
  try {
    return readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Hashes cover raw bytes. Writes `data` to `destination` under a lock.
 * With `baseHash` the file must exist and hash to it; it is then replaced atomically.
 * Without it the file is created with an exclusive hard link, so an existing file is never replaced
 * and there is no check-then-rename fallback.
 */
export function writeFileConditional(
  destination: string,
  data: string,
  options: { baseHash?: string | null; link?: (existing: string, created: string) => void } = {},
): ConditionalWrite {
  const { baseHash = null, link = linkSync } = options;
  mkdirSync(path.dirname(destination), { recursive: true });
  return withFileLockSync(destination, (): ConditionalWrite => {
    const current = readIfExists(destination);
    if (baseHash !== null) {
      const currentHash = current === null ? null : sha256Hex(current);
      if (currentHash !== baseHash) return { status: 'stale-base', currentHash };
      writeFileAtomic(destination, data);
      return { status: 'written', hash: sha256Hex(data), replaced: true, previous: current === null ? null : current.toString('utf8') };
    }
    return createExclusive(destination, data, link);
  });
}

/** Creates `destination` only if it does not exist, by hard-linking a fully written temp file. */
function createExclusive(
  destination: string,
  data: string,
  link: (existing: string, created: string) => void,
): ConditionalWrite {
  const tmp = tempPathFor(destination);
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      link(tmp, destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (code === 'EEXIST') return { status: 'already-exists' };
      if (LINK_UNSUPPORTED.has(code)) {
        return { status: 'create-unsupported', reason: `${code}: this filesystem cannot create hard links` };
      }
      throw error;
    }
    return { status: 'written', hash: sha256Hex(data), replaced: false, previous: null };
  } finally {
    rmSync(tmp, { force: true });
  }
}
