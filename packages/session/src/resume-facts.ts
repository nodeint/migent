import path from 'node:path';

import type { ClientRegistry } from '@nodeint/migent-kernel';
import { MIGENT_DIRNAME, SESSIONS_DIRNAME } from '@nodeint/migent-kernel';

import { normalizeTurns, resolveExecutionClients } from './metrics.js';
import { orderedEvents, readExecutions } from './metrics-read.js';
import { readStatusFileState } from './query.js';

export interface ResumeFacts {
  /** When the source execution ended (a cancelled one uses the cancel's time); null when unknown. */
  completedAt: string | null;
  /** Input, cache read and cache write tokens of the last turn that captured usage; null when none did. */
  contextTokens: number | null;
}

const NO_FACTS: ResumeFacts = { completedAt: null, contextTokens: null };

/**
 * What the resume gate needs to know about the execution that would be resumed. The context is the
 * last turn with captured usage: `input + cache_read + cache_write`, normalized as the metrics are.
 * Nothing here throws on missing or partial records; they read as unknown.
 */
export function resumeFacts(
  workspace: string,
  source: { sessionId: string; executionId: string },
  clients: ClientRegistry,
): ResumeFacts {
  const { sessionId, executionId } = source;
  const sessionDirectory = path.join(workspace, MIGENT_DIRNAME, SESSIONS_DIRNAME, sessionId);
  const execution = readExecutions(sessionDirectory).find((row) => row.id === executionId);
  if (execution === undefined) return NO_FACTS;
  const statusRead = readStatusFileState(path.join(sessionDirectory, 'status.json'));
  const status = statusRead.state === 'ok' ? statusRead.status : {};
  const events = orderedEvents(sessionDirectory);
  const executionClients = resolveExecutionClients(events, [execution], status);
  const turns = normalizeTurns(events, executionClients, clients).filter(
    (turn) => turn.executionId === executionId && turn.captured,
  );
  const last = turns.at(-1);
  const { usage } = last ?? {};
  const contextTokens =
    usage === undefined
      ? null
      : (usage.input_tokens ?? 0) + (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0);
  return { completedAt: execution.completedAt, contextTokens };
}
