import { existsSync } from 'node:fs';
import path from 'node:path';

import { CancelResult } from '@nodeint/migent-contracts';
import { MS_PER_SECOND } from '@nodeint/migent-kernel';
import { requestSessionCancel, sessionLockAlive,SessionStore } from '@nodeint/migent-session';

import { printError, printNotice } from '../display.js';
import { writeJson } from '../emit.js';
import { EXIT_CONFIG } from '../exits.js';
import { requireCurrentSchema } from '../migrate.js';

const POLL_MS = 250;

export async function cancelSession(
  workspace: string,
  sessionId: string,
  args: { waitSeconds: number; asJson: boolean },
): Promise<number> {
  requireCurrentSchema(workspace);
  const directory = path.join(workspace, '.migent', 'sessions', sessionId);
  if (!existsSync(directory)) {
    printError(`Session ${sessionId} does not exist.`);
    return EXIT_CONFIG;
  }
  const refusal = cancelRefusal(sessionId, requestSessionCancel(directory));
  if (refusal !== null) {
    printError(refusal);
    return EXIT_CONFIG;
  }
  const stopped = await waitForStop(directory, args.waitSeconds);
  if (args.asJson) {
    const current = new SessionStore(workspace).readSessionStatus(sessionId);
    const status = typeof current.status === 'string' ? current.status : null;
    writeJson(CancelResult, { session_id: sessionId, cancelled: stopped, status });
  } else if (stopped) {
    printNotice(`Session ${sessionId} cancelled.`);
  } else {
    printError(`Cancel requested, but session ${sessionId} is still running after ${args.waitSeconds} s.`);
  }
  return stopped ? 0 : 1;
}

function cancelRefusal(sessionId: string, outcome: ReturnType<typeof requestSessionCancel>): string | null {
  if (outcome === 'foreign-host') return `Session ${sessionId} is running on another machine. Cancel it there.`;
  if (outcome === 'not-running') {
    return `Session ${sessionId} is not running. Resume it with: migent session continue ${sessionId}, or fix it with: migent session repair ${sessionId}`;
  }
  return null;
}

/** Polls until the session lock is released or the wait elapses; true when it stopped. */
async function waitForStop(directory: string, waitSeconds: number): Promise<boolean> {
  const deadline = Date.now() + waitSeconds * MS_PER_SECOND;
  while (sessionLockAlive(directory) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return !sessionLockAlive(directory);
}
