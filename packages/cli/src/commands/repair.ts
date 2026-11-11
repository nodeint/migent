import { RepairResult, type Static } from '@nodeint/migent-contracts';
import { isSessionLockLost, repairSession, SessionLockHeldError } from '@nodeint/migent-session';

import { printError } from '../display.js';
import { writeJson } from '../emit.js';
import { EXIT_CONFIG } from '../exits.js';
import { requireCurrentSchema } from '../migrate.js';

export function repairWorkflowSession(workspace: string, sessionId: string, acceptTask: boolean): number {
  requireCurrentSchema(workspace);
  try {
    const status = repairSession(workspace, sessionId, { acceptTask });
    const payload: Static<typeof RepairResult> = {
      session_id: sessionId,
      status: typeof status.status === 'string' ? status.status : null,
    };
    writeJson(RepairResult, payload);
    return 0;
  } catch (error) {
    if (error instanceof SessionLockHeldError || isSessionLockLost(error)) {
      printError(error.message);
      return EXIT_CONFIG;
    }
    throw error;
  }
}
