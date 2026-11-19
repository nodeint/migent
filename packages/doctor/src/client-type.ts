import type { ClientRegistry } from '@nodeint/migent-kernel';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The CLI client of an agent definition: `client.type`, else the one client that lists its model.
 * Undefined when absent, not inferable, or ambiguous; the structural check reports those once.
 */
export function agentClientType(definition: Record<string, unknown>, clients: ClientRegistry): string | undefined {
  const {client} = definition;
  if (isRecord(client) && typeof client.type === 'string' && client.type.trim() !== '') return client.type.trim();
  if (isRecord(client) && (client.options !== null && client.options !== undefined)) return undefined;
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

/** True when `client` is present but is not a mapping with a usable `type`: the structural check explains it. */
export function clientUnusable(definition: Record<string, unknown>): boolean {
  const {client} = definition;
  if ((client === null || client === undefined)) return false;
  if (!isRecord(client)) return true;
  return (client.type !== null && client.type !== undefined) && (typeof client.type !== 'string' || client.type.trim() === '');
}
