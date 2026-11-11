import { exitCode, exitLines, type ExitName } from '@nodeint/migent-contracts';

export const EXIT_OK = exitCode('completed');
export const EXIT_BLOCKED = exitCode('blocked');
export const EXIT_QUESTION = exitCode('question');
export const EXIT_CONFIG = exitCode('config');
export const EXIT_STAGE_FAILED = exitCode('stage_failed');
export const EXIT_QUOTA = exitCode('quota');
export const EXIT_REVISIONS = exitCode('revisions_exhausted');
export const EXIT_DISPATCHES = exitCode('dispatch_limit');
export const EXIT_VERIFY = exitCode('verify_exhausted');
export const EXIT_VERIFY_FAILED = exitCode('verify_failed');
export const EXIT_CANCELLED = exitCode('cancelled');

const LOOP_ORDER: readonly ExitName[] = ['completed', 'blocked', 'question', 'config', 'stage_failed', 'quota', 'revisions_exhausted', 'dispatch_limit', 'verify_exhausted', 'verify_failed', 'cancelled'];
const STAGE_ORDER: readonly ExitName[] = ['completed', 'blocked', 'question', 'config', 'stage_failed', 'quota', 'revisions_exhausted', 'verify_exhausted', 'verify_failed', 'cancelled'];
const ROLE_ORDER: readonly ExitName[] = ['completed', 'blocked', 'config', 'verify_exhausted', 'cancelled'];

export const LOOP_EXITS = exitLines('run', LOOP_ORDER);
export const STAGE_EXITS = exitLines('run_once', STAGE_ORDER);
export const ROLE_EXITS = exitLines('role_run', ROLE_ORDER);
export const [PREFLIGHT_EXIT] = exitLines('preflight');

export function exitText(lines: readonly string[]): string {
  return `\n${lines.join('\n')}\n`;
}
