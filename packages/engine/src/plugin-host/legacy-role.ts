import { readdirSync } from 'node:fs';
import path from 'node:path';

import { readLegacyRoleStamp } from '@nodeint/migent-session';

import { readExecutionJson } from '../run-facts.js';

/**
 * The pre-#167 policy stamp of a role session that has no freeze: the newest execution that carries a
 * `resume_policy`. Read-only; null when no execution has one.
 */
export function legacyRoleStamp(sessionDirectory: string): ReturnType<typeof readLegacyRoleStamp> {
  const root = path.join(sessionDirectory, 'executions');
  let names: string[];
  try {
    names = readdirSync(root).sort().reverse();
  } catch {
    return null;
  }
  for (const name of names) {
    const stamp = readLegacyRoleStamp(readExecutionJson(path.join(root, name))?.resume_policy);
    if (stamp !== null) return stamp;
  }
  return null;
}
