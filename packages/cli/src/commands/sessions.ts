import { SealedMetrics, SealedMetricsLine, SessionRow, SessionRowOrNull, SessionRows, type Static } from '@nodeint/migent-contracts';
import { ConfigurationError } from '@nodeint/migent-kernel';
import { listSealedMetrics, listSessionRows, readSealedMetrics } from '@nodeint/migent-session';
import { Command, type OptionValues } from 'commander';

import { printError, printSessions } from '../display.js';
import { writeJson } from '../emit.js';
import { EXIT_CONFIG, exitText } from '../exits.js';
import { SESSION_COLUMN, sessionFields } from '../session-row.js';
import { optionalText } from '../text.js';
import { findWorkspace, invocationCwdPath } from '../workspace.js';
import { cancelSession } from './cancel.js';
import { completeSession } from './complete.js';
import { renameSession } from './rename.js';
import { repairWorkflowSession } from './repair.js';
import { followSession } from './watch.js';

const SESSION_STATUSES = new Set(['active', 'prepared', 'completed', 'blocked', 'question', 'cancelled', 'corrupt']);

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
    const [row] = rows;
    if (options.asJson) {
      writeJson(SessionRowOrNull, row === undefined ? null : sessionJson(row));
      return 0;
    }
    printSessions(row === undefined ? [] : [row]);
    return 0;
  }
  if (options.asJson) {
    writeJson(SessionRows, rows.map((row) => sessionJson(row)));
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
    printError('session metrics requires --json.');
    return EXIT_CONFIG;
  }
  const selection = parseListSelection({ ...options, latest: false });
  const sessionId = optionalText(session);
  if (sessionId !== null && hasListFilter(selection)) {
    printError('List filters cannot be combined with a session.');
    return EXIT_CONFIG;
  }
  if (sessionId === null) {
    const rows = listSealedMetrics(workspace, {
      workflow: selection.workflow ?? null,
      status: selection.status ?? null,
      limit: selection.limit ?? null,
    });
    for (const row of rows) writeJson(SealedMetricsLine, row);
    return 0;
  }
  const sealed = readSealedMetrics(workspace, sessionId);
  if (sealed.state === 'missing') {
    printError(`No metrics for session: ${sessionId}. Metrics are recorded when a workflow session completes.`);
    return EXIT_CONFIG;
  }
  if (sealed.state === 'corrupt') {
    printError(`metrics.json for session ${sessionId} is not valid JSON.`);
    return EXIT_CONFIG;
  }
  writeJson(SealedMetrics, sealed.metrics);
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
    printError('List filters cannot be combined with a session.');
    return EXIT_CONFIG;
  }
  if (sessionId === null) return listOnly(workspace, options, selection);
  if (options.until && !options.follow) {
    printError('--until requires --follow.');
    return EXIT_CONFIG;
  }
  if (options.cursor !== undefined && !options.follow) {
    printError('--cursor requires --follow.');
    return EXIT_CONFIG;
  }
  if (options.exitWhenDone && !options.follow) {
    printError('--exit-when-done requires --follow.');
    return EXIT_CONFIG;
  }
  if (options.until && options.execution === null) {
    printError('--until requires --execution.');
    return EXIT_CONFIG;
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
    printError('--follow requires a session.');
    return EXIT_CONFIG;
  }
  if (options.until) {
    printError('--until requires --follow.');
    return EXIT_CONFIG;
  }
  if (options.cursor !== undefined) {
    printError('--cursor requires --follow.');
    return EXIT_CONFIG;
  }
  if (options.exitWhenDone) {
    printError('--exit-when-done requires --follow.');
    return EXIT_CONFIG;
  }
  if (options.execution !== null) {
    printError('--execution requires a session.');
    return EXIT_CONFIG;
  }
  return listSessions(workspace, { ...selection, asJson: options.asJson });
}

function selectSessionRows(rows: readonly string[][], options: SessionListOptions): string[][] {
  let selected = [...rows];
  if ((options.workflow !== null && options.workflow !== undefined)) {
    selected = selected.filter((row) => row[SESSION_COLUMN.workflow] === options.workflow);
  }
  if ((options.status !== null && options.status !== undefined)) {
    selected = selected.filter((row) => row[SESSION_COLUMN.status] === options.status);
  }
  const limit = options.latest ? 1 : (options.limit ?? null);
  if (limit !== null) return selected.slice(0, limit);
  return selected;
}

function sessionJson(row: readonly string[]): Static<typeof SessionRow> {
  const fields = sessionFields(row);
  return {
    session: fields.session,
    title: fields.title,
    workflow: fields.workflow,
    status: fields.status,
    execution: fields.execution,
    decision: fields.decision,
    outputs: fields.outputs,
  };
}

function hasListFilter(selection: SessionListOptions): boolean {
  return selection.latest === true ||
    (selection.workflow !== null && selection.workflow !== undefined) ||
    (selection.status !== null && selection.status !== undefined) ||
    (selection.limit !== null && selection.limit !== undefined);
}

function parseListSelection(options: {
  workflow: string | null;
  status: string | null;
  limit: string | null;
  latest: boolean;
}): SessionListOptions {
  const workflow = optionalText(options.workflow);
  if (options.workflow !== null && workflow === null) throw new ConfigurationError('--workflow is empty.');
  const status = optionalText(options.status);
  if (options.status !== null && status === null) throw new ConfigurationError('--status is empty.');
  if (status !== null && !SESSION_STATUSES.has(status)) {
    throw new ConfigurationError('--status must be active, prepared, completed, blocked, question, cancelled, or corrupt.');
  }
  let limit: number | null = null;
  if (options.limit !== null) {
    if (!/^[0-9]+$/.test(options.limit)) throw new ConfigurationError('--limit must be an integer >= 1.');
    limit = Number(options.limit);
    if (limit < 1) throw new ConfigurationError('--limit must be an integer >= 1.');
  }
  if (options.latest && limit !== null) throw new ConfigurationError('--latest cannot be combined with --limit.');
  return { workflow, status, limit, latest: options.latest };
}

function parseCursor(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cursor = Number(raw);
  if (!Number.isInteger(cursor) || cursor < 0) throw new ConfigurationError('--cursor must be >= 0.');
  return cursor;
}

/** Runs a command action and records its exit code; supplied by the program. */
export type Settle = (action: () => number | Promise<number>) => Promise<void>;

/** cancel, complete, rename, and repair. */
export function registerSessionLifecycleCommands(session: Command, settle: Settle): void {
  session
    .command('cancel')
    .description('Ask the process running a session to stop. Works on Windows, where signals cannot reach it.')
    .argument('<session>', 'Session to cancel.')
    .option('--wait <seconds>', 'Seconds to wait for the process to stop.', '15')
    .option('--json', 'Print {session_id, cancelled, status}.')
    .addHelpText(
      'after',
      `${exitText([
        'Exit 0 when the session stopped.',
        'Exit 1 when the cancel was requested but the process is still running after --wait.',
        'Exit 2 when the session does not exist, is not running, or runs on another machine.',
      ])}Examples:\n  migent session cancel <session>\n  migent session cancel <session> --wait 60 --json\n`,
    )
    .action((id: string, options: OptionValues) =>
      settle(() => {
        const wait = Number(options.wait);
        if (!Number.isFinite(wait) || wait < 0) {
          printError('--wait must be a number of seconds, 0 or more.');
          return EXIT_CONFIG;
        }
        const cancelOptions = { waitSeconds: wait, asJson: options.json === true };
        return cancelSession(findWorkspace(invocationCwdPath()), id, cancelOptions);
      }),
    );

  session
    .command('complete')
    .description('Mark a stopped workflow session completed without running another stage.')
    .argument('<session>', 'Session to complete.')
    .option('--json', 'Print {session_id, status, already_completed, outputs, missing_outputs, next} on stdout.')
    .addHelpText(
      'after',
      `${exitText([
        'Exit 0 when the session is completed, or already was.',
        'Exit 2 when the session does not exist, is a role session, is prepared, or is running (run migent session cancel first).',
      ])}Completion is terminal. Examples:
  migent session complete <session>
  migent session complete <session> --json
`,
    )
    .action((id: string, options: OptionValues) =>
      settle(() => completeSession(findWorkspace(invocationCwdPath()), id, options.json === true)),
    );

  session
    .command('rename')
    .description("Change a session's display title. The task and the session state stay unchanged.")
    .argument('<session>', 'Session to rename.')
    .argument('<title>', 'New one-line title.')
    .option('--json', 'Print {session_id, title, previous_title} on stdout.')
    .addHelpText(
      'after',
      `${exitText([
        'Exit 0 when the session is renamed.',
        'Exit 2 when the session does not exist or the title is empty or has a line break.',
      ])}Works while the session is running. Examples:
  migent session rename <session> "New title"
  migent session rename <session> "New title" --json
`,
    )
    .action((id: string, title: string, options: OptionValues) =>
      settle(() => renameSession(findWorkspace(invocationCwdPath()), { sessionId: id, title }, options.json === true)),
    );

  session
    .command('repair')
    .description('Rebuild status.json from the session directory.')
    .argument('<session>', 'Session to repair.')
    .option('--accept-task', 'Store the hash of the current task.md when status.json does not parse.')
    .addHelpText(
      'after',
      `${exitText([
        'Exit 0 after status.json is rebuilt.',
        'Exit 2 when the session cannot be repaired, or another process holds the session lock.',
      ])}Examples:\n  migent session repair <session>\n  migent session repair <session> --accept-task\n`,
    )
    .action((id: string, options: OptionValues) =>
      settle(() =>
        repairWorkflowSession(findWorkspace(invocationCwdPath()), id, options.acceptTask === true),
      ),
    );
}

/** list, show, metrics, and follow. */
export function registerSessionQueryCommands(session: Command, settle: Settle): void {
  session
    .command('list')
    .description('List sessions, newest first.')
    .option('--json', 'Print a JSON array without the task. With --latest, print one object, or null.')
    .option('--workflow <id>', 'List sessions for this workflow id.')
    .option('--status <status>', 'List sessions with this status: active, prepared, completed, blocked, question, cancelled, or corrupt.')
    .option('--limit <n>', 'List the newest n sessions. At least 1. Cannot be combined with --latest.')
    .option('--latest', 'Print the newest matching session. Cannot be combined with --limit.')
    .addHelpText(
      'after',
      `${exitText(['Exit 0 after a list, including an empty list.', 'Exit 2 on a configuration error.'])}Examples:\n  migent session list\n  migent session list --latest --json\n  migent session list --workflow <id> --status completed --json\n`,
    )
    .action((options: OptionValues) =>
      settle(() =>
        runSessions(findWorkspace(invocationCwdPath()), undefined, {
          asJson: options.json === true,
          follow: false,
          execution: null,
          until: false,
          cursor: undefined,
          exitWhenDone: false,
          workflow: typeof options.workflow === 'string' ? options.workflow : null,
          status: typeof options.status === 'string' ? options.status : null,
          limit: options.limit === undefined ? null : String(options.limit),
          latest: options.latest === true,
        }),
      ),
    );

  session
    .command('show')
    .description('Print one session snapshot.')
    .argument('<session>', 'Session to inspect.')
    .option('--json', 'Print one JSON object without the task.')
    .addHelpText(
      'after',
      `${exitText(['Exit 0 after a snapshot, including a blocked session.', 'Exit 2 on a configuration error.'])}Examples:\n  migent session show <session>\n  migent session show <session> --json\n`,
    )
    .action((id: string, options: OptionValues) =>
      settle(() =>
        runSessions(findWorkspace(invocationCwdPath()), id, {
          asJson: options.json === true,
          follow: false,
          execution: null,
          until: false,
          cursor: undefined,
          exitWhenDone: false,
          workflow: null,
          status: null,
          limit: null,
          latest: false,
        }),
      ),
    );

  session
    .command('metrics')
    .description('Print usage, time, and revision counts recorded for a completed workflow session.')
    .argument('[session]', 'Workflow session to read. Omit to list sessions that have metrics.')
    .option('--json', 'Print one JSON object, or one object per line for a list.')
    .option('--workflow <id>', 'With a list, keep sessions for this workflow.')
    .option('--status <status>', 'With a list, keep sessions in this status.')
    .option('--limit <n>', 'With a list, keep the newest n sessions.')
    .addHelpText(
      'after',
      `${exitText([
        'Exit 0 after one session object, or one object per line. An empty list prints nothing.',
        'Exit 2 when --json is missing, the session has no metrics.json, that file is corrupt, or a list flag is invalid.',
      ])}Examples:\n  migent session metrics <session> --json\n  migent session metrics --json --workflow <id> --status completed --limit 10\n`,
    )
    .action((id: string | undefined, options: OptionValues) =>
      settle(() =>
        runSessionMetrics(findWorkspace(invocationCwdPath()), id, {
          asJson: options.json === true,
          workflow: typeof options.workflow === 'string' ? options.workflow : null,
          status: typeof options.status === 'string' ? options.status : null,
          limit: options.limit === undefined ? null : String(options.limit),
        }),
      ),
    );

  session
    .command('follow')
    .description("Follow a session's events until a signal.")
    .argument('<session>', 'Session to follow.')
    .option('--json', 'Print a snapshot object, then JSON lines. With --cursor, only JSON lines.')
    .option('--execution <execution>', 'Limit followed events and --until to this execution.')
    .option(
      '--cursor <offset>',
      'Byte offset in events.jsonl. 0 replays the whole log and every execution stream. Any other offset replays events from that byte, and stream lines whose timestamp is at or after the first event there. Skips the snapshot.',
    )
    .option('--until', 'Exit when --execution reaches completed, failed, or cancelled. Requires --execution.')
    .option('--exit-when-done', 'Exit when the session is completed (0), blocked (1), waiting for a reply (9), or cancelled (130).')
    .addHelpText(
      'after',
      `${exitText([
        'Exit 0 when --exit-when-done and the session is completed.',
        'Exit 1 when --exit-when-done and the session is blocked.',
        'Exit 130 when --exit-when-done and the session is cancelled, or the follow is cancelled.',
        'Exit 2 on a configuration error.',
      ])}Examples:\n  migent session follow <session>\n  migent session follow <session> --exit-when-done\n`,
    )
    .action((id: string, options: OptionValues) =>
      settle(() =>
        runSessions(findWorkspace(invocationCwdPath()), id, {
          asJson: options.json === true,
          follow: true,
          execution: optionalText(options.execution),
          until: options.until === true,
          cursor: options.cursor === undefined ? undefined : String(options.cursor),
          exitWhenDone: options.exitWhenDone === true,
          workflow: null,
          status: null,
          limit: null,
          latest: false,
        }),
      ),
    );
}
