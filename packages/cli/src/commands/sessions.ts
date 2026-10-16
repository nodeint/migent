import { listSessionRows, ConfigurationError } from "@nodeint/migent-kernel";
import { printError, printSessions } from "../display.js";
import { sessionFields } from "../session-row.js";
import { optionalText } from "../text.js";
import { followSession } from "./watch.js";

export function listSessions(workspace: string, options: { asJson?: boolean } = {}): number {
  const rows = listSessionRows(workspace);
  if (options.asJson) {
    const payload = rows.map((row) => sessionFields(row));
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return 0;
  }
  printSessions(rows);
  return 0;
}

export async function runSessions(
  workspace: string,
  session: string | undefined,
  options: {
    asJson: boolean;
    follow: boolean;
    execution: string | null;
    until: boolean;
    cursor: string | undefined;
    exitWhenDone: boolean;
  },
): Promise<number> {
  const sessionId = optionalText(session);
  if (sessionId === null) return listOnly(workspace, options);
  if (options.until && !options.follow) {
    printError("--until requires --follow.");
    return 2;
  }
  if (options.cursor !== undefined && !options.follow) {
    printError("--cursor requires --follow.");
    return 2;
  }
  if (options.exitWhenDone && !options.follow) {
    printError("--exit-when-done requires --follow.");
    return 2;
  }
  if (options.until && options.execution === null) {
    printError("--until requires --execution.");
    return 2;
  }
  const cursor = parseCursor(options.cursor);
  return followSession(workspace, sessionId, {
    once: !options.follow,
    executionId: options.execution,
    untilTerminal: options.until,
    jsonLines: options.asJson,
    cursor,
    exitWhenDone: options.exitWhenDone,
  });
}

function listOnly(
  workspace: string,
  options: {
    asJson: boolean;
    follow: boolean;
    execution: string | null;
    until: boolean;
    cursor: string | undefined;
    exitWhenDone: boolean;
  },
): number {
  if (options.follow) {
    printError("--follow requires a session.");
    return 2;
  }
  if (options.until) {
    printError("--until requires --follow.");
    return 2;
  }
  if (options.cursor !== undefined) {
    printError("--cursor requires --follow.");
    return 2;
  }
  if (options.exitWhenDone) {
    printError("--exit-when-done requires --follow.");
    return 2;
  }
  if (options.execution !== null) {
    printError("--execution requires a session.");
    return 2;
  }
  return listSessions(workspace, { asJson: options.asJson });
}

function parseCursor(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cursor = Number(raw);
  if (!Number.isInteger(cursor) || cursor < 0) throw new ConfigurationError("--cursor must be >= 0.");
  return cursor;
}
