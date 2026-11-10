import { RenameResult } from "@nodeint/migent-contracts";
import { writeJson } from "../emit.js";
import { ConfigurationError, log, SessionStore } from "@nodeint/migent-kernel";
import { clientRegistry } from "../client.js";
import { printError } from "../display.js";
import { requireCurrentSchema } from "../migrate.js";

/** Change a session's display title without the session lock. Exit 2 for an unknown session or invalid title. */
export function renameSession(workspace: string, sessionId: string, title: string, asJson: boolean): number {
  requireCurrentSchema(workspace);
  let result;
  try {
    result = new SessionStore(workspace, undefined, clientRegistry()).rename(sessionId, title);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      printError(error.message);
      return 2;
    }
    throw error;
  }
  if (asJson) {
    writeJson(RenameResult, {
      session_id: result.sessionId,
      title: result.title,
      previous_title: result.previousTitle,
    });
    return 0;
  }
  log(`Session ${result.sessionId} renamed to: ${result.title}`);
  return 0;
}
