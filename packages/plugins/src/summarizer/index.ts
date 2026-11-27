import type { Plugin, PluginEventProposal, PluginHandler, PluginManifest } from '@nodeint/migent-contracts';

import { buildPrompt } from './build.js';
import { renderSummary } from './render.js';
import { validateTriggers } from './validate.js';

export { buildPrompt } from './build.js';
export { renderSummary, summaryHeader, summaryTitle } from './render.js';

export const SUMMARIZER_PLUGIN_ID = 'summarizer';
export const SUMMARIZER_ARTIFACT_NAME = 'summary.md';

const SUMMARY_TRIGGERS = ['completed', 'question', 'blocked', 'expired', 'execution'] as const;
type Trigger = (typeof SUMMARY_TRIGGERS)[number];
const DEFAULT_TRIGGERS: readonly Trigger[] = ['completed', 'question', 'blocked', 'expired'];
const STOP_STATUSES: readonly Trigger[] = ['question', 'blocked', 'expired'];

const CONFIG_SCHEMA: PluginManifest['configSchema'] = {
  type: 'object',
  properties: { triggers: { type: 'array', items: { enum: [...SUMMARY_TRIGGERS] } } },
  additionalProperties: true,
};

export const summarizerManifest: PluginManifest = {
  id: SUMMARIZER_PLUGIN_ID,
  version: '1.0.0',
  apiVersion: { major: 1, minor: 3 },
  advisory: true,
  uses: {
    operations: [],
    events: ['execution.finished', 'session.stopped', 'session.completed'],
    session: ['snapshot', 'artifacts'],
    artifacts: [{ name: SUMMARIZER_ARTIFACT_NAME, mode: 'replace', media_type: 'text/markdown' }],
    agents: true,
    config: [],
  },
  configSchema: CONFIG_SCHEMA,
};

const NONE: readonly PluginEventProposal[] = [{ kind: 'none' }];

/** One agent call per invocation. A corrupt snapshot, an agent error or blank output throws: `plugin.failed`. */
function summarize(only: readonly Trigger[] | null): PluginHandler {
  return async (input, call) => {
    const snapshot = await call.session.snapshot();
    if (snapshot.corrupt) throw new Error('The session is corrupt; no summary was written.');
    if (snapshot.executions.length === 0) return NONE;
    if (only !== null && !only.includes(String(snapshot.status.status) as Trigger)) return NONE;
    const artifacts = await call.session.artifacts();
    const result = await call.agents.invoke(buildPrompt(input.session.id, snapshot, artifacts));
    if (result.error !== null) throw new Error(`The summary agent failed: ${result.error}`);
    if (result.text === null || result.text.trim() === '') throw new Error('The summary agent returned no text.');
    return [call.artifacts.propose(SUMMARIZER_ARTIFACT_NAME, renderSummary(input.session.id, snapshot, result.text))];
  };
}

function triggersOf(options: Readonly<Record<string, unknown>>): readonly Trigger[] {
  const { triggers } = options;
  return Array.isArray(triggers) ? (triggers as Trigger[]) : DEFAULT_TRIGGERS;
}

export const summarizerPlugin: Plugin = {
  manifest: summarizerManifest,
  validate: validateTriggers,
  activate: (options, migent) => {
    const triggers = new Set(triggersOf(options));
    if (triggers.has('execution')) migent.events.on('execution.finished', summarize(null));
    if (triggers.has('completed')) migent.events.on('session.completed', summarize(null));
    const stops = STOP_STATUSES.filter((status) => triggers.has(status));
    if (stops.length > 0) migent.events.on('session.stopped', summarize(stops));
  },
};
