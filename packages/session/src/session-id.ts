import { lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync } from 'node:fs';
import path from 'node:path';

import { ConfigurationError, writeFileAtomic } from '@nodeint/migent-kernel';

import { withNumberingLock } from './session-lock.js';

const CANONICAL_NUMBER = /^[1-9][0-9]*$/u;

/** Largest numeric session id: every increment up to it is exact. */
export const MAX_SESSION_NUMBER = Number.MAX_SAFE_INTEGER;

/** A session id as a YAML double-quoted scalar, so numeric ids stay strings on disk. */
export function quotedSessionId(sessionId: string): string {
  return JSON.stringify(sessionId);
}

/** The number of a canonical numeric session id, or null for any other name. */
export function numericName(name: string): number | null {
  if (!CANONICAL_NUMBER.test(name) || name.length > String(MAX_SESSION_NUMBER).length) return null;
  const value = Number(name);
  return value <= MAX_SESSION_NUMBER ? value : null;
}

export const LAST_ID_FILENAME = '.last-id';

/**
 * Read the high-water mark. A missing, unparsable, or non-regular file counts as 0. Any other
 * read error (EACCES, EIO, ...) propagates: guessing 0 could reissue a retired number.
 */
export function readLastIdMark(sessionsDirectory: string): number {
  const file = path.join(sessionsDirectory, LAST_ID_FILENAME);
  try {
    if (!lstatSync(file).isFile()) return 0;
    return numericName(readFileSync(file, 'utf8').trim()) ?? 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

/**
 * Raise `.last-id` to max(current, n) under the numbering lock so a deleted number is never
 * issued again. Never lowers the mark.
 */
export function retireSessionNumber(sessionsDirectory: string, n: number, timing: { waitMs?: number } = {}): void {
  withNumberingLock(sessionsDirectory, () => {
    if (readLastIdMark(sessionsDirectory) >= n) return;
    writeFileAtomic(path.join(sessionsDirectory, LAST_ID_FILENAME), `${n}\n`);
  }, timing);
}

/** Null in production. A test runs between choosing a candidate and claiming it. */
let beforeNumericClaim: ((candidate: number) => void) | null = null;

export function setBeforeNumericClaim(observe: ((candidate: number) => void) | null): void {
  beforeNumericClaim = observe;
}

/** Null in production. A test runs right after a successful claim, before the mark is re-read. */
let afterNumericClaim: ((candidate: number, directory: string) => void) | null = null;

export function setAfterNumericClaim(observe: ((candidate: number, directory: string) => void) | null): void {
  afterNumericClaim = observe;
}

/**
 * Claim the next numeric session directory: max(highest numeric name, `.last-id`) + 1.
 * A non-recursive mkdir is the atomic claim; on EEXIST the next number is tried. After a claim the
 * mark is read again: a mark at or above the claim means the number was retired, so the empty
 * claim is dropped and allocation continues higher. Allocation never waits on the numbering lock.
 */
export function createNumericSessionDirectory(sessionsDirectory: string): [string, string] {
  mkdirSync(sessionsDirectory, { recursive: true });
  let max = readLastIdMark(sessionsDirectory);
  for (const name of readdirSync(sessionsDirectory)) {
    const value = numericName(name);
    if (value !== null && value > max) max = value;
  }
  for (let candidate = max + 1; ; candidate += 1) {
    if (candidate > MAX_SESSION_NUMBER) {
      throw new ConfigurationError(`Session ids are exhausted in ${sessionsDirectory}: the next id would exceed ${MAX_SESSION_NUMBER}.`);
    }
    const claimed = claimNumber(sessionsDirectory, candidate);
    if (typeof claimed !== 'number') return claimed;
    candidate = Math.max(candidate, claimed);
  }
}

/** The claimed [id, directory], or the mark (a number) when the claim was taken or retired. */
function claimNumber(sessionsDirectory: string, candidate: number): [string, string] | number {
  const sessionId = String(candidate);
  const sessionDirectory = path.join(sessionsDirectory, sessionId);
  beforeNumericClaim?.(candidate);
  try {
    mkdirSync(sessionDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return candidate;
  }
  afterNumericClaim?.(candidate, sessionDirectory);
  const mark = readLastIdMark(sessionsDirectory);
  if (mark < candidate) return [sessionId, sessionDirectory];
  try {
    rmdirSync(sessionDirectory);
  } catch {
    // An empty directory without status.json is invisible; allocation goes higher.
  }
  return mark;
}
