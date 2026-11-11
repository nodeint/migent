/** Facts read from persisted execution state and from the workspace: protocol stamps, saved replies, git and CLI versions. */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { CliClient, OutcomeContext } from '@nodeint/migent-kernel';
import { resolveStageOutcome, spawnProviderSync } from '@nodeint/migent-kernel';
import { StageOutcome } from '@nodeint/migent-kernel';
import type { TurnKind } from '@nodeint/migent-prompts';
import type { ExecutionContext, SessionStore } from '@nodeint/migent-session';
import { isRecord } from '@nodeint/migent-workflow';

/** The protocol a stored stamp runs under. A missing or legacy stamp is read as 1. */
export function storedProtocol(metadata: Record<string, unknown> | null): number {
  const value = metadata?.response_protocol;
  return typeof value === 'number' && value >= 2 ? value : 1;
}

const TURN_KINDS: readonly TurnKind[] = [
  'start', 'continue', 'reply', 'answers', 'repair', 'correction', 'response_correction', 'output_correction', 'handoff_correction',
];

/** The kind of the execution's latest user turn, as saved in execution.json. */
export function storedTurn(metadata: Record<string, unknown>): TurnKind | null {
  const value = metadata.turn_kind;
  return TURN_KINDS.find((kind) => kind === value) ?? null;
}

/**
 * Empty replies leave no assistant message, so the count can fall short of the real turn. A queued
 * correction saves the turn it runs as; the real turn is never lower than that.
 */
export function persistedTurn(metadata: Record<string, unknown>, counted: number): number {
  const saved = metadata.pending_turn;
  return typeof saved === 'number' && saved > counted ? saved : counted;
}

export function readExecutionJson(directory: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path.join(directory, 'execution.json'), 'utf8')) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function verifyProgress(metadata: Record<string, unknown>): {
  red: number;
  runs: number;
  lastReport: string | null;
  lastResult: 'pass' | 'fail' | null;
} {
  const verify = isRecord(metadata.verify) ? metadata.verify : null;
  const lastResult = verify?.last_result === 'pass' || verify?.last_result === 'fail' ? verify.last_result : null;
  return {
    red: typeof verify?.red === 'number' ? verify.red : 0,
    runs: typeof verify?.runs === 'number' ? verify.runs : 0,
    lastReport: typeof verify?.last_report === 'string' ? verify.last_report : null,
    lastResult,
  };
}

export function savedResponse(context: ExecutionContext, last: Record<string, string>): string {
  try {
    return readFileSync(path.join(context.directory, 'response.md'), 'utf8');
  } catch {
    return typeof last.content === 'string' ? last.content : '';
  }
}

export function savedOutcome(
  saved: { store: SessionStore; context: ExecutionContext; turn: number },
  responseText: string,
  outcomeContext: OutcomeContext,
): StageOutcome | null {
  const { store, context, turn } = saved;
  try {
    const raw = JSON.parse(
      readFileSync(path.join(store.turnDirectory(context, turn), 'outcome.json'), 'utf8'),
    ) as unknown;
    if (isRecord(raw) && raw.status === 'complete') {
      return new StageOutcome(raw.status, {
        blocker: typeof raw.blocker === 'string' && raw.blocker ? raw.blocker : null,
        decision: typeof raw.decision === 'string' && raw.decision ? raw.decision : null,
      });
    }
  } catch {
    // The saved response is the fallback.
  }
  return resolveStageOutcome(responseText, outcomeContext);
}

export function readCliVersion(client: CliClient, workspace: string): string | null {
  const spec = client.versionCommand();
  const [command] = spec.argv;
  if (command === undefined) return null;
  const result = spawnProviderSync(command, spec.argv.slice(1), {
    encoding: 'utf8',
    timeout: 10_000,
    cwd: workspace,
  });
  if (result.error || result.status !== 0) return null;
  return client.parseVersion(result.stdout ?? '');
}

export function readGitFacts(workspace: string): { git_head: string | null; git_dirty: boolean | null } {
  const head = gitOutput(workspace, ['rev-parse', 'HEAD']);
  const porcelain = gitOutput(workspace, ['status', '--porcelain']);
  if (head === null || porcelain === null || head.trim() === '') return { git_head: null, git_dirty: null };
  return { git_head: head.trim(), git_dirty: porcelain.trim() !== '' };
}

function gitOutput(workspace: string, args: string[]): string | null {
  const result = spawnProviderSync('git', args, {
    encoding: 'utf8',
    timeout: 10_000,
    cwd: workspace,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}
