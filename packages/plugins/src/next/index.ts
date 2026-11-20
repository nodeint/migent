import type { Plugin, PluginEventProposal, PluginHandler, PluginManifest } from '@nodeint/migent-contracts';
import { PLUGIN_EXTENSIONS } from '@nodeint/migent-contracts';

import { buildRecommendations, downstreamIds, hasPayload, type RecommendationDocument } from './build.js';
import { nextResponseContract } from './contract.js';

export { buildRecommendations } from './build.js';
export { nextResponseContract } from './contract.js';

export const NEXT_PLUGIN_ID = 'next';
export const NEXT_ARTIFACT_NAME = 'recommendations.json';

/** Same bytes as the core's atomic JSON writer. */
const JSON_INDENT = 2;
const CONFIG_SCHEMA: PluginManifest['configSchema'] = { type: 'object', properties: {}, additionalProperties: true };

export const nextManifest: PluginManifest = {
  id: NEXT_PLUGIN_ID,
  version: '1.0.0',
  apiVersion: { major: 1, minor: 2 },
  advisory: false,
  defaultEnabled: true,
  uses: {
    operations: [],
    events: ['execution.finished'],
    session: ['snapshot'],
    artifacts: [{ name: NEXT_ARTIFACT_NAME, mode: 'replace', media_type: 'application/json' }],
    agents: false,
    config: [],
  },
  configSchema: CONFIG_SCHEMA,
  defaults: { on_error: 'ignore' },
  extensions: PLUGIN_EXTENSIONS.find((entry) => entry.plugin === NEXT_PLUGIN_ID),
};

const NONE: readonly PluginEventProposal[] = [{ kind: 'none' }];

/**
 * Rebuilds the document from the whole snapshot. A session that never carried a payload gets no file. Once
 * `downstream` is gone, earlier recommendations are no longer offered, so the list is empty.
 */
const onFinished: PluginHandler = async (_input, call) => {
  const snapshot = await call.session.snapshot();
  if (snapshot.corrupt || !hasPayload(snapshot)) return NONE;
  const document: RecommendationDocument = downstreamIds(snapshot).length === 0
    ? { schema_version: 1, recommendations: [] }
    : buildRecommendations(snapshot);
  return [call.artifacts.propose(NEXT_ARTIFACT_NAME, JSON.stringify(document, null, JSON_INDENT))];
};

export const nextPlugin: Plugin = {
  manifest: nextManifest,
  responseContract: nextResponseContract,
  activate: (_options, migent) => {
    migent.events.on('execution.finished', onFinished);
  },
};
