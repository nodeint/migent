import type { Plugin, PluginEventProposal, PluginHandler, PluginManifest } from '@nodeint/migent-contracts';

import { buildMetrics } from './build.js';

export { buildMetrics } from './build.js';

export const METRICS_PLUGIN_ID = 'metrics';
export const METRICS_ARTIFACT_NAME = 'metrics.json';

/** Same bytes as the core's atomic JSON writer. */
const JSON_INDENT = 2;
const CONFIG_SCHEMA: PluginManifest['configSchema'] = { type: 'object', properties: {}, additionalProperties: true };

export const metricsManifest: PluginManifest = {
  id: METRICS_PLUGIN_ID,
  version: '1.0.0',
  apiVersion: { major: 1, minor: 0 },
  advisory: false,
  defaultEnabled: true,
  uses: {
    operations: [],
    events: ['session.completed'],
    session: ['snapshot'],
    artifacts: [{ name: METRICS_ARTIFACT_NAME, mode: 'create_only', media_type: 'application/json' }],
    agents: false,
    config: [],
  },
  configSchema: CONFIG_SCHEMA,
  defaults: { on_error: 'ignore' },
};

const NONE: readonly PluginEventProposal[] = [{ kind: 'none' }];

/** Seals the metrics of a completed session once. Agent, corrupt and not-yet-completed sessions get none. */
const onCompleted: PluginHandler = async (input, call) => {
  const snapshot = await call.session.snapshot();
  if (snapshot.corrupt) return NONE;
  if (snapshot.status.workflow_id === 'agent' || snapshot.status.status !== 'completed') return NONE;
  const document = buildMetrics(input.session.id, snapshot);
  return [call.artifacts.propose(METRICS_ARTIFACT_NAME, JSON.stringify(document, null, JSON_INDENT))];
};

export const metricsPlugin: Plugin = {
  manifest: metricsManifest,
  activate: (_options, migent) => {
    migent.events.on('session.completed', onCompleted);
  },
};
