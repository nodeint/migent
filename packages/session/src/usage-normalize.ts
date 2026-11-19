import type { CliClient, ClientRegistry, TurnUsage, UsageCapture } from '@nodeint/migent-kernel';
import { clientOfCommand, normalizeUsage } from '@nodeint/migent-kernel';
import { isRecord } from '@nodeint/migent-workflow';

import { coerceNumber, detailsOf } from './fact-values.js';
import { executionCommands, legacyExecutionClient } from './legacy-execution-client.js';
import { type ParsedEvent } from './session-events.js';
import type { ExecutionRow } from './session-facts.js';

export interface NormalizedTurn {
  executionId: string;
  usage: TurnUsage;
  captured: boolean;
}

function blankUsage(): TurnUsage {
  return {
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    cost_usd: null,
  };
}

function coerceUsage(value: TurnUsage): TurnUsage {
  return {
    input_tokens: coerceNumber(value?.input_tokens),
    output_tokens: coerceNumber(value?.output_tokens),
    reasoning_tokens: coerceNumber(value?.reasoning_tokens),
    cache_read_tokens: coerceNumber(value?.cache_read_tokens),
    cache_write_tokens: coerceNumber(value?.cache_write_tokens),
    cost_usd: coerceNumber(value?.cost_usd),
  };
}

// Old sessions recorded turn_completed with no details.turn. Progress never emits
// turn_completed, so those still count. A turn_failed counts only with details.turn,
// because the progress path emits the same event without it.
function isRunnerTurn(event: ParsedEvent): boolean {
  if (event.event === 'provider.turn_completed') return true;
  if (event.event !== 'provider.turn_failed') return false;
  return typeof detailsOf(event).turn === 'number';
}

export function resolveExecutionClients(
  events: ParsedEvent[],
  executions: ExecutionRow[],
  status: Record<string, unknown>,
): Map<string, string | null> {
  const executables = executionCommands(events);
  const roleSession = status.workflow_id === 'agent';
  return new Map(executions.map((execution) => {
    const {client} = legacyExecutionClient({
      recorded: execution.client,
      provider: execution.provider,
      executables: executables.get(execution.id),
      roleSession,
    });
    return [execution.id, client];
  }));
}

function turnClientId(details: Record<string, unknown>, recorded: string | null | undefined): string | null {
  const {argv} = details;
  const command = Array.isArray(argv) && typeof argv[0] === 'string' ? argv[0] : null;
  // A conflicting history cannot be resumed, but each turn still proves its own output format.
  return clientOfCommand(command) ?? recorded ?? null;
}

function usageReader(clients: ClientRegistry, clientId: string | null): Pick<CliClient, 'readUsage'> | null {
  if (clientId === null) return null;
  try {
    return clients.get(clientId);
  } catch {
    return null;
  }
}

function turnUsage(
  reader: Pick<CliClient, 'readUsage'> | null,
  capture: Record<string, unknown> | null,
  prior: UsageCapture | null,
): TurnUsage {
  if (capture === null || reader === null) return blankUsage();
  try {
    return coerceUsage(normalizeUsage(reader, capture, prior));
  } catch {
    return blankUsage();
  }
}

export function normalizeTurns(
  events: ParsedEvent[],
  executionClients: ReadonlyMap<string, string | null>,
  clients: ClientRegistry,
): NormalizedTurn[] {
  const previous = new Map<string, UsageCapture>();
  const turns: NormalizedTurn[] = [];
  for (const event of events) {
    if (!isRunnerTurn(event) || event.executionId === null) continue;
    const details = detailsOf(event);
    // Usage is read with the CLI that actually ran the turn. Legacy records name no
    // client, so this follows the same evidence policy as resume.
    const clientId = turnClientId(details, executionClients.get(event.executionId));
    const agentId = typeof details.agent_id === 'string' ? details.agent_id : null;
    const key = JSON.stringify([clientId, agentId]);
    const capture = isRecord(details.usage) ? details.usage : null;
    const reader = usageReader(clients, clientId);
    const usage = turnUsage(reader, capture, previous.get(key) ?? null);
    if (capture !== null) previous.set(key, capture);
    turns.push({ executionId: event.executionId, usage, captured: capture !== null && reader !== null });
  }
  return turns;
}
