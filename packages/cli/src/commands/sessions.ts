import { listSealedMetrics, listSessionRows, readSealedMetrics, ConfigurationError } from "@nodeint/migent-kernel";
import { printError, printSessions } from "../display.js";
import { SESSION_COLUMN, sessionFields } from "../session-row.js";
import { optionalText } from "../text.js";
import { followSession } from "./watch.js";

const SESSION_STATUSES = new Set(["active", "prepared", "completed", "blocked", "cancelled", "corrupt"]);

export interface SessionListOptions {
  asJson?: boolean;
  workflow?: string | null;
  status?: string | null;
  limit?: number | null;
  latest?: boolean;
}

export function listSessions(workspace: string, options: SessionListOptions = {}): number {
  const rows = selectSessionRows(listSessionRows(workspace), options);
  if (options.latest) {
    const row = rows[0];
    if (options.asJson) {
      process.stdout.write(`${JSON.stringify(row === undefined ? null : sessionJson(row))}\n`);
      return 0;
    }
    printSessions(row === undefined ? [] : [row]);
    return 0;
  }
  if (options.asJson) {
    process.stdout.write(`${JSON.stringify(rows.map((row) => sessionJson(row)))}\n`);
    return 0;
  }
  printSessions(rows);
  return 0;
}

export function runSessionMetrics(
  workspace: string,
  session: string | undefined,
  options: { asJson: boolean; workflow: string | null; status: string | null; limit: string | null },
): number {
  if (!options.asJson) {
    printError("session metrics requires --json.");
    return 2;
  }
  const selection = parseListSelection({ ...options, latest: false });
  const sessionId = optionalText(session);
  if (sessionId !== null && hasListFilter(selection)) {
    printError("List filters cannot be combined with a session.");
    return 2;
  }
  if (sessionId === null) {
    const rows = listSealedMetrics(workspace, {
      workflow: selection.workflow ?? null,
      status: selection.status ?? null,
      limit: selection.limit ?? null,
    });
    for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
    return 0;
  }
  const sealed = readSealedMetrics(workspace, sessionId);
  if (sealed.state === "missing") {
    printError(`No metrics for session: ${sessionId}. Metrics are recorded when a workflow session completes.`);
    return 2;
  }
  if (sealed.state === "corrupt") {
    printError(`metrics.json for session ${sessionId} is not valid JSON.`);
    return 2;
  }
  process.stdout.write(`${JSON.stringify(sealed.metrics)}\n`);
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
    workflow: string | null;
    status: string | null;
    limit: string | null;
    latest: boolean;
  },
): Promise<number> {
  const selection = parseListSelection(options);
  const sessionId = optionalText(session);
  if (sessionId !== null && hasListFilter(selection)) {
    printError("List filters cannot be combined with a session.");
    return 2;
  }
  if (sessionId === null) return listOnly(workspace, options, selection);
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
  selection: SessionListOptions,
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
  return listSessions(workspace, { ...selection, asJson: options.asJson });
}

function selectSessionRows(rows: readonly string[][], options: SessionListOptions): string[][] {
  let selected = [...rows];
  if (options.workflow != null) {
    selected = selected.filter((row) => row[SESSION_COLUMN.workflow] === options.workflow);
  }
  if (options.status != null) {
    selected = selected.filter((row) => row[SESSION_COLUMN.status] === options.status);
  }
  const limit = options.latest ? 1 : (options.limit ?? null);
  if (limit !== null) return selected.slice(0, limit);
  return selected;
}

function sessionJson(row: readonly string[]): Omit<ReturnType<typeof sessionFields>, "task"> {
  const fields = sessionFields(row);
  return {
    session: fields.session,
    workflow: fields.workflow,
    status: fields.status,
    execution: fields.execution,
    decision: fields.decision,
    outputs: fields.outputs,
  };
}

function hasListFilter(selection: SessionListOptions): boolean {
  return selection.latest === true || selection.workflow != null || selection.status != null || selection.limit != null;
}

function parseListSelection(options: {
  workflow: string | null;
  status: string | null;
  limit: string | null;
  latest: boolean;
}): SessionListOptions {
  const workflow = optionalText(options.workflow);
  if (options.workflow !== null && workflow === null) throw new ConfigurationError("--workflow is empty.");
  const status = optionalText(options.status);
  if (options.status !== null && status === null) throw new ConfigurationError("--status is empty.");
  if (status !== null && !SESSION_STATUSES.has(status)) {
    throw new ConfigurationError("--status must be active, prepared, completed, blocked, cancelled, or corrupt.");
  }
  let limit: number | null = null;
  if (options.limit !== null) {
    if (!/^[0-9]+$/.test(options.limit)) throw new ConfigurationError("--limit must be an integer >= 1.");
    limit = Number(options.limit);
    if (limit < 1) throw new ConfigurationError("--limit must be an integer >= 1.");
  }
  if (options.latest && limit !== null) throw new ConfigurationError("--latest cannot be combined with --limit.");
  return { workflow, status, limit, latest: options.latest };
}

function parseCursor(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cursor = Number(raw);
  if (!Number.isInteger(cursor) || cursor < 0) throw new ConfigurationError("--cursor must be >= 0.");
  return cursor;
}
