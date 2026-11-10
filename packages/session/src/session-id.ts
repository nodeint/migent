import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { ConfigurationError } from "@nodeint/migent-kernel";

const CANONICAL_NUMBER = /^[1-9][0-9]*$/u;

/** Largest numeric session id: every increment up to it is exact. */
export const MAX_SESSION_NUMBER = Number.MAX_SAFE_INTEGER;

/** A session id as a YAML double-quoted scalar, so numeric ids stay strings on disk. */
export function quotedSessionId(sessionId: string): string {
  return JSON.stringify(sessionId);
}

function numericName(name: string): number | null {
  if (!CANONICAL_NUMBER.test(name) || name.length > String(MAX_SESSION_NUMBER).length) return null;
  const value = Number(name);
  return value <= MAX_SESSION_NUMBER ? value : null;
}

/**
 * Claim the next numeric session directory: max existing numeric name + 1 (1 when none).
 * A non-recursive mkdir is the atomic claim; on EEXIST the next number is tried.
 */
export function createNumericSessionDirectory(sessionsDirectory: string): [string, string] {
  mkdirSync(sessionsDirectory, { recursive: true });
  let max = 0;
  for (const name of readdirSync(sessionsDirectory)) {
    const value = numericName(name);
    if (value !== null && value > max) max = value;
  }
  for (let candidate = max + 1; ; candidate += 1) {
    if (candidate > MAX_SESSION_NUMBER) {
      throw new ConfigurationError(`Session ids are exhausted in ${sessionsDirectory}: the next id would exceed ${MAX_SESSION_NUMBER}.`);
    }
    const sessionId = String(candidate);
    const sessionDirectory = path.join(sessionsDirectory, sessionId);
    try {
      mkdirSync(sessionDirectory);
      return [sessionId, sessionDirectory];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}
