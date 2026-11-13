import { confirm as clackConfirm, isCancel } from '@clack/prompts';
import { DeleteResult, SESSION_STATUS_CATALOG, type Static } from '@nodeint/migent-contracts';
import { ConfigurationError, MS_PER_SECOND, noInputRequested } from '@nodeint/migent-kernel';
import {
  assertSessionId,
  deletePlannedSession,
  type PlannedSession,
  planSessionDeletion,
  type Refusal,
  sweepDeletionLeftovers,
} from '@nodeint/migent-session';

import { printError, printNotice } from '../display.js';
import { writeJson } from '../emit.js';
import { PromptCancelled } from '../errors.js';
import { EXIT_CONFIG } from '../exits.js';
import { cliHooks } from '../hooks.js';
import { requireCurrentSchema } from '../migrate.js';

const EXIT_FAILED = 1;
const DURATION = /^([1-9][0-9]*)(m|h|d|w)$/u;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;
const MINUTE_MS = SECONDS_PER_MINUTE * MS_PER_SECOND;
const HOUR_MS = MINUTES_PER_HOUR * MINUTE_MS;
const DAY_MS = HOURS_PER_DAY * HOUR_MS;
const UNIT_MS: Record<string, number> = { m: MINUTE_MS, h: HOUR_MS, d: DAY_MS, w: DAYS_PER_WEEK * DAY_MS };
const KB = 1024;
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];

export interface DeleteArgs {
  ids: readonly string[];
  olderThan: string | null;
  statuses: readonly string[];
  dryRun: boolean;
  yes: boolean;
  asJson: boolean;
}

type Result = Static<typeof DeleteResult>;

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= KB && unit < SIZE_UNITS.length - 1) {
    value /= KB;
    unit += 1;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

function validStatuses(): string[] {
  return SESSION_STATUS_CATALOG.map((entry) => entry.name).filter((name) => name !== 'corrupt');
}

/** Returns the selection, or an error message for exit 2. */
function parseSelection(args: DeleteArgs): { ids: string[] } | { olderThanMs?: number; statuses?: string[] } | string {
  const filtered = args.olderThan !== null || args.statuses.length > 0;
  if (args.ids.length > 0 && filtered) return 'Session IDs cannot be combined with --older-than or --status.';
  if (args.ids.length === 0 && !filtered) {
    return 'Name sessions to delete, or pass --older-than or --status.\nUsage: migent session delete <session>... | --older-than <duration> | --status <status>';
  }
  if (args.ids.length > 0) {
    for (const id of args.ids) assertSessionId(id);
    return { ids: [...args.ids] };
  }
  const selection: { olderThanMs?: number; statuses?: string[] } = {};
  if (args.olderThan !== null) {
    const match = DURATION.exec(args.olderThan);
    if (match === null) return `Invalid --older-than ${args.olderThan}. Use a positive integer and m, h, d, or w, such as 90m, 12h, 30d, 2w.`;
    selection.olderThanMs = Number(match[1]) * (UNIT_MS[match[2] as string] as number);
  }
  if (args.statuses.length > 0) {
    const valid = validStatuses();
    const bad = args.statuses.find((status) => !valid.includes(status));
    if (bad !== undefined) return `Invalid --status ${bad}. Valid values: ${valid.join(', ')}.`;
    selection.statuses = [...args.statuses];
  }
  return selection;
}

function plural(count: number): string {
  return `${count} session${count === 1 ? '' : 's'}`;
}

function printRefusal(item: Refusal): void {
  if (item.reason === 'not-found') printError(`Session ${item.session_id} does not exist.`);
  else if (item.reason === 'running') printError(`Session ${item.session_id} is running. Stop it first: migent session cancel ${item.session_id}`);
  else printError(`Session ${item.session_id} is running on another machine.`);
}

function printPlan(planned: readonly PlannedSession[], refused: readonly Refusal[], asJson: boolean): void {
  if (!asJson) {
    for (const entry of planned) {
      const label = entry.title === null ? entry.session_id : `${entry.session_id}  ${entry.title}`;
      out(`${label}  ${entry.status ?? '-'}  ${entry.updated_at ?? '-'}  ${formatBytes(entry.bytes)}`);
    }
    if (planned.length > 0) out(`${plural(planned.length)}, ${formatBytes(sum(planned))}.`);
  }
  refused.forEach(printRefusal);
}

function sum(planned: readonly PlannedSession[]): number {
  return planned.reduce((total, entry) => total + entry.bytes, 0);
}

function publicPlanned(planned: readonly PlannedSession[]): Result['planned'] {
  return planned.map(({ leftover: _leftover, ...rest }) => rest);
}

async function confirmDeletion(message: string, asJson: boolean): Promise<boolean> {
  if (cliHooks.confirm !== null) return cliHooks.confirm(message);
  const answer = await clackConfirm({ message, initialValue: false, ...(asJson ? { output: process.stderr } : {}) });
  if (isCancel(answer)) throw new PromptCancelled();
  return answer;
}

function emit(args: DeleteArgs, result: Result): void {
  if (args.asJson) writeJson(DeleteResult, result);
}

/** Validate, check the schema, and plan. Returns the plan, or an exit code. */
function resolvePlan(workspace: string, args: DeleteArgs): ReturnType<typeof planSessionDeletion> | number {
  try {
    requireCurrentSchema(workspace);
    const selection = parseSelection(args);
    if (typeof selection === 'string') {
      printError(selection);
      return EXIT_CONFIG;
    }
    return planSessionDeletion(workspace, selection, Date.now());
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    printError(error.message);
    return EXIT_CONFIG;
  }
}

/** The prompt step: null to continue, otherwise the result and exit code of the stop. */
async function confirmStep(args: DeleteArgs, plan: PlanView): Promise<{ outcome: Result['outcome']; exit: number } | null> {
  if (args.yes) return null;
  const interactive = cliHooks.interactive ?? process.stdin.isTTY === true;
  if (!interactive || noInputRequested()) {
    printError('Pass --yes to delete without confirmation.');
    return { outcome: 'confirmation-required', exit: EXIT_CONFIG };
  }
  const ok = await confirmDeletion(`Delete ${plural(plan.count)} (${formatBytes(plan.bytes)})?`, args.asJson);
  return ok ? null : { outcome: 'declined', exit: 0 };
}

interface PlanView {
  count: number;
  bytes: number;
  refusalExit: number;
  named: boolean;
}

function runDeletions(workspace: string, plan: ReturnType<typeof planSessionDeletion>, args: DeleteArgs) {
  const deleted: string[] = [];
  const failed: Result['failed'] = [];
  let freed = 0;
  for (const entry of plan.planned) {
    const outcome = deletePlannedSession(workspace, entry);
    if (outcome.ok) {
      freed += outcome.bytesFreed;
      deleted.push(entry.session_id);
      if (!args.asJson) out(`Deleted ${entry.session_id}`);
    } else {
      failed.push({ session_id: entry.session_id, error: outcome.error });
      printError(`Could not delete ${entry.session_id}: ${outcome.error}`);
      if (outcome.hidden === true) {
        printNotice(`Session ${entry.session_id} is already hidden; the next \`migent session delete\` reclaims its space.`);
      }
    }
  }
  return { deleted, failed, freed };
}

/** Clear earlier leftovers. Returns an exit code when the sweep fails containment. */
function sweep(workspace: string, plan: ReturnType<typeof planSessionDeletion>): number | null {
  const skip = plan.planned.filter((entry) => entry.leftover).map((entry) => entry.session_id);
  try {
    const cleared = sweepDeletionLeftovers(workspace, skip);
    if (cleared.length > 0) printNotice(`Cleared leftovers of earlier deletions: ${cleared.join(', ')}.`);
    return null;
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    printError(error.message);
    return EXIT_CONFIG;
  }
}

export async function deleteSessions(workspace: string, args: DeleteArgs): Promise<number> {
  const plan = resolvePlan(workspace, args);
  if (typeof plan === 'number') return plan;
  for (const id of plan.skippedLinks) printError(`Skipped ${id}: it is a link, not a session directory.`);
  const named = args.ids.length > 0;
  const base = { planned: publicPlanned(plan.planned), deleted: [] as string[], failed: [] as Result['failed'], refused: plan.refused };
  const view: PlanView = {
    count: plan.planned.length,
    bytes: sum(plan.planned),
    refusalExit: named && plan.refused.length > 0 ? EXIT_FAILED : 0,
    named,
  };
  printPlan(plan.planned, plan.refused, args.asJson);

  const stop = args.dryRun ? { outcome: 'dry-run' as const, exit: 0 } : await stopBeforeDeleting(args, plan, view);
  if (stop !== null) {
    emit(args, { outcome: stop.outcome, ...base, total_bytes: stop.outcome === 'deleted' ? 0 : view.bytes });
    return stop.exit;
  }
  const swept = sweep(workspace, plan);
  if (swept !== null) return swept;
  const { deleted, failed, freed } = runDeletions(workspace, plan, args);
  if (!args.asJson) {
    out(`Deleted ${plural(deleted.length)}, freed ${formatBytes(freed)}.${failed.length > 0 ? ` ${failed.length} failed.` : ''}`);
  }
  emit(args, { outcome: 'deleted', ...base, deleted, failed, total_bytes: freed });
  return failed.length > 0 ? EXIT_FAILED : view.refusalExit;
}

/** Ends the run before any mutation, or returns null to go on. An empty plan with --yes still sweeps. */
async function stopBeforeDeleting(
  args: DeleteArgs,
  plan: ReturnType<typeof planSessionDeletion>,
  view: PlanView,
): Promise<{ outcome: Result['outcome']; exit: number } | null> {
  if (plan.planned.length > 0) return confirmStep(args, view);
  if (!view.named) printNotice('No sessions match.');
  return args.yes ? null : { outcome: 'deleted', exit: view.refusalExit };
}
