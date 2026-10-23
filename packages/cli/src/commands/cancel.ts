import { existsSync } from "node:fs";
import path from "node:path";
import { requestSessionCancel, SessionStore, sessionLockAlive } from "@nodeint/migent-kernel";
import { printError, printNotice } from "../display.js";
import { requireCurrentSchema } from "../migrate.js";

const POLL_MS = 250;

export async function cancelSession(
  workspace: string,
  sessionId: string,
  args: { waitSeconds: number; asJson: boolean },
): Promise<number> {
  requireCurrentSchema(workspace);
  const directory = path.join(workspace, ".migent", "sessions", sessionId);
  if (!existsSync(directory)) {
    printError(`Session ${sessionId} does not exist.`);
    return 2;
  }
  const outcome = requestSessionCancel(directory);
  if (outcome === "foreign-host") {
    printError(`Session ${sessionId} is running on another machine. Cancel it there.`);
    return 2;
  }
  if (outcome === "not-running") {
    printError(
      `Session ${sessionId} is not running. Resume it with: migent session continue ${sessionId}, or fix it with: migent session repair ${sessionId}`,
    );
    return 2;
  }
  const deadline = Date.now() + args.waitSeconds * 1000;
  while (sessionLockAlive(directory) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  const stopped = !sessionLockAlive(directory);
  if (args.asJson) {
    const current = new SessionStore(workspace).readSessionStatus(sessionId);
    const status = typeof current.status === "string" ? current.status : null;
    process.stdout.write(`${JSON.stringify({ session_id: sessionId, cancelled: stopped, status })}\n`);
  } else if (stopped) {
    printNotice(`Session ${sessionId} cancelled.`);
  } else {
    printError(`Cancel requested, but session ${sessionId} is still running after ${args.waitSeconds} s.`);
  }
  return stopped ? 0 : 1;
}
