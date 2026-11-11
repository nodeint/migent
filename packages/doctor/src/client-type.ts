import type { ClientRegistry } from '@nodeint/migent-kernel';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The CLI client of an agent definition: `client.type`, else the one client that lists its model.
 * Undefined when absent, not inferable, or ambiguous; the structural check reports those once.
 */
export function agentClientType(definition: Record<string, unknown>, clients: ClientRegistry): string | undefined {
  const {client} = definition;
  if (isRecord(client) && typeof client.type === 'string' && client.type.trim() !== '') return client.type.trim();
  if (isRecord(client) && client.options != null) return undefined;
  if (clients.clientsForModel === undefined || typeof definition.model !== 'string' || !definition.model.trim()) {
    return undefined;
  }
  try {
    const { matches } = clients.clientsForModel(definition.model.trim());
    return matches.length === 1 ? matches[0] : undefined;
  } catch {
    return undefined;
  }
}
