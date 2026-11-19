import path from 'node:path';

import type { PluginSessionSnapshot } from '@nodeint/migent-contracts';
import { extensionKeys, PLUGIN_EXTENSIONS } from '@nodeint/migent-contracts';
import type { ClientRegistry } from '@nodeint/migent-kernel';
import { MIGENT_DIRNAME, SESSIONS_DIRNAME } from '@nodeint/migent-kernel';
import type { WorkflowDocument } from '@nodeint/migent-workflow';
import { withoutOwnedKeys } from '@nodeint/migent-workflow';

import { exitAnomaliesOf } from './exit-anomaly.js';
import { readStatusFileState } from './query.js';
import type { ParsedEvent } from './session-events.js';
import { loadSessionWorkflow, orderedEvents, readExecutions, sessionIsCorrupt } from './session-facts.js';
import { readWorkflowFreeze } from './session-freeze.js';
import { normalizeTurns, resolveExecutionClients } from './usage-normalize.js';

/** Agent-level keys no plugin may read here: the current catalog's and those recorded in the freeze. */
function agentOwnedKeys(sessionDirectory: string): string[] {
  const records = readWorkflowFreeze(sessionDirectory)?.extensions.records ?? {};
  const recorded = Object.values(records).flatMap((record) => record.keys.agent);
  return [...new Set([...extensionKeys(PLUGIN_EXTENSIONS, 'agent'), ...recorded])];
}

/** The workflow without extension data: no `extensions` field, and no owned key on an inline stage agent. */
function withoutExtensionData(workflow: WorkflowDocument, ownedAgentKeys: readonly string[]): Record<string, unknown> {
  const stages = Object.entries(workflow.stages).map(([id, stage]) => {
    const core = withoutOwnedKeys({ ...stage }, ['extensions']) as unknown as typeof stage;
    const { agent } = core;
    const cleaned = agent?.kind === 'inline' ? { ...agent, value: withoutOwnedKeys(agent.value, ownedAgentKeys) } : agent;
    return [id, { ...core, agent: cleaned }];
  });
  return { ...withoutOwnedKeys({ ...workflow }, ['extensions', 'stages']), stages: Object.fromEntries(stages) };
}

const directoryOf = (workspace: string, sessionId: string): string =>
  path.join(workspace, MIGENT_DIRNAME, SESSIONS_DIRNAME, sessionId);

/**
 * The last event seq that is not a `plugin.*` event, or null. Plugin events are excluded so that a plugin's own
 * records never make its own evidence stale.
 */
export function lastBasisSeq(events: readonly ParsedEvent[]): number | null {
  let last: number | null = null;
  for (const event of events) {
    if (event.event.startsWith('plugin.') || event.seq === null) continue;
    if (last === null || event.seq > last) last = event.seq;
  }
  return last;
}

/** The basis seq of a session as it is on disk now. */
export function readBasisSeq(workspace: string, sessionId: string): number | null {
  return lastBasisSeq(orderedEvents(directoryOf(workspace, sessionId)));
}

/**
 * What a plugin may read of a session. Usage is normalized here, by the same `normalizeTurns` path the resume
 * facts use, so a plugin owns aggregation and nothing else.
 */
export function readSessionSnapshot(
  workspace: string,
  sessionId: string,
  clients: ClientRegistry,
): PluginSessionSnapshot {
  const sessionDirectory = directoryOf(workspace, sessionId);
  const events = orderedEvents(sessionDirectory);
  const basisSeq = lastBasisSeq(events);
  if (sessionIsCorrupt(sessionDirectory)) {
    return {
      basis_seq: basisSeq, status: {}, corrupt: true, executions: [], events: [], workflow: null, turns: [],
      execution_clients: {}, exit_anomalies: [],
    };
  }
  const statusRead = readStatusFileState(path.join(sessionDirectory, 'status.json'));
  const status = statusRead.state === 'ok' ? statusRead.status : {};
  const executions = readExecutions(sessionDirectory);
  const known = new Set(executions.map((execution) => execution.id));
  const executionClients = resolveExecutionClients(events, executions, status);
  const turns = normalizeTurns(events, executionClients, clients)
    .filter((turn) => known.has(turn.executionId))
    .map((turn) => ({
      execution_id: turn.executionId,
      client: executionClients.get(turn.executionId) ?? null,
      usage: { ...turn.usage },
      captured: turn.captured,
    }));
  const workflow = loadSessionWorkflow(workspace, sessionDirectory, status);
  return {
    basis_seq: basisSeq,
    status,
    corrupt: false,
    executions: executions as unknown as Record<string, unknown>[],
    events: events.map((event) => ({
      v: event.v, seq: event.seq, event: event.event, timestamp: event.timestamp, executionId: event.executionId,
      stageId: event.stageId, summary: event.summary, data: event.data, raw: event.raw,
    })),
    workflow: workflow === null ? null : withoutExtensionData(workflow, agentOwnedKeys(sessionDirectory)),
    turns,
    execution_clients: Object.fromEntries(executionClients),
    exit_anomalies: exitAnomaliesOf(events) as unknown as Record<string, unknown>[],
  };
}
