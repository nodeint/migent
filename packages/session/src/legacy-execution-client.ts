import { readFileSync } from 'node:fs';
import path from 'node:path';

import { clientOfCommand, legacyClientOf } from '@nodeint/migent-kernel';
import { isRecord } from '@nodeint/migent-workflow';

import { type ParsedEvent,readParsedEvents } from './session-events.js';

export type LegacyProvenance = 'recorded' | 'executable' | 'code-path';

export type LegacyExecutionClient =
  | { client: string; provenance: LegacyProvenance }
  | { client: null; reason: string };

export interface LegacyExecutionEvidence {
  /** The `client` field of a new execution record. */
  recorded?: string | null;
  /** The `provider` field of a legacy record, for the role-session code-path only. */
  provider?: string | null;
  /** `argv[0]` of the execution's turn events, the executable Migent launched. */
  executable?: string | null;
  /** All recorded turn executables; each must agree with the other evidence. */
  executables?: readonly string[];
  /** A frozen target's client, used only to corroborate other evidence. */
  frozen?: string | null;
  /** True for a `session run --role` execution, whose runner always used the provider's own client. */
  roleSession?: boolean;
}

/**
 * Decide which CLI ran one historical execution, following the evidence
 * matrix in the plan. Exactly one client must survive; a conflict or no
 * evidence refuses resume rather than guessing.
 */
export function legacyExecutionClient(evidence: LegacyExecutionEvidence): LegacyExecutionClient {
  const candidates: { client: string; provenance: LegacyProvenance }[] = [];
  const recorded = nonempty(evidence.recorded);
  if (recorded !== null) candidates.push({ client: recorded, provenance: 'recorded' });
  for (const command of [evidence.executable, ...(evidence.executables ?? [])]) {
    const executable = clientOfCommand(command);
    if (executable !== null) candidates.push({ client: executable, provenance: 'executable' });
  }
  if (evidence.roleSession === true) {
    const roleClient = legacyClientOf(evidence.provider);
    if (roleClient !== null) candidates.push({ client: roleClient, provenance: 'code-path' });
  }
  const clients = [...new Set(candidates.map((candidate) => candidate.client))];
  if (clients.length === 0) {
    return { client: null, reason: 'no execution record names the CLI that ran it' };
  }
  if (clients.length > 1) {
    return { client: null, reason: `the recorded evidence names conflicting CLIs: ${clients.join(', ')}` };
  }
  const client = clients[0] as string;
  const frozen = nonempty(evidence.frozen);
  if (frozen !== null && frozen !== client) {
    return {
      client: null,
      reason: `the frozen target names ${frozen}, but the execution ran ${client}`,
    };
  }
  const strongest = candidates.find((candidate) => candidate.client === client) as { provenance: LegacyProvenance };
  return { client, provenance: strongest.provenance };
}

/** Keep evidence from every runner turn, including a later turn on a different CLI. */
export function executionCommands(events: readonly ParsedEvent[]): Map<string, string[]> {
  const commands = new Map<string, string[]>();
  for (const event of events) {
    if (event.executionId === null) continue;
    if (event.event !== 'provider.turn_completed' && event.event !== 'provider.turn_failed') continue;
    const details = isRecord(event.raw.details) ? event.raw.details : {};
    const {argv} = details;
    if (!Array.isArray(argv) || typeof argv[0] !== 'string' || argv[0] === '') continue;
    const own = commands.get(event.executionId) ?? [];
    if (!own.includes(argv[0])) own.push(argv[0]);
    commands.set(event.executionId, own);
  }
  return commands;
}

/** The shared execution reader for resume and status repair. */
export function readExecutionClient(
  sessionDirectory: string,
  execution: { executionId: string; metadata: Record<string, unknown>; frozen?: string | null },
): LegacyExecutionClient {
  return executionClientReader(sessionDirectory)(execution.executionId, execution.metadata, execution.frozen);
}

/** Read a session's history once when folding many execution records. */
export function executionClientReader(sessionDirectory: string): (
  executionId: string,
  metadata: Record<string, unknown>,
  frozen?: string | null,
) => LegacyExecutionClient {
  const commands = executionCommands(readParsedEvents(path.join(sessionDirectory, 'events.jsonl')));
  let roleSession = false;
  try {
    const status: unknown = JSON.parse(readFileSync(path.join(sessionDirectory, 'status.json'), 'utf8'));
    roleSession = isRecord(status) && status.workflow_id === 'agent';
  } catch {
    // A missing status cannot prove a role-session code path.
  }
  return (executionId, metadata, frozen) => legacyExecutionClient({
    recorded: typeof metadata.client === 'string' ? metadata.client : null,
    provider: typeof metadata.provider === 'string' ? metadata.provider : null,
    executables: commands.get(executionId),
    roleSession,
    frozen,
  });
}

function nonempty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
