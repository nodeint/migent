import { legacyClientOf, type ResolveSpecOptions, resolveStageSpec, type StageTarget } from '@nodeint/migent-kernel';
import { isRecord, isRoleStage, SCHEMA_V2, type WorkflowDocument } from '@nodeint/migent-workflow';

import { corrupt } from './freeze-corrupt.js';
import { targetExtensionField } from './freeze-extensions.js';
import { freezeStagePolicy } from './freeze-resume-policy.js';

/** The `targets` mapping of a freeze: one client, model and option set per stage. */
export function readTargets(value: unknown, filePath: string, schemaVersion: unknown): Record<string, StageTarget> {
  if (!isRecord(value)) throw corrupt(filePath, 'targets must be a mapping');
  const legacy = typeof schemaVersion !== 'number' || schemaVersion < SCHEMA_V2;
  const targets: Record<string, StageTarget> = {};
  for (const [stageId, raw] of Object.entries(value)) {
    if (!isRecord(raw) || typeof raw.model !== 'string') {
      throw corrupt(filePath, `targets.${stageId} must name a client and model`);
    }
    const client = legacy ? legacyTargetClient(raw, filePath, stageId) : raw.client;
    if (typeof client !== 'string') {
      throw corrupt(filePath, `targets.${stageId} must name a client and model`);
    }
    if (raw.model.trim() === '') {
      throw corrupt(filePath, `targets.${stageId} must name a client and model`);
    }
    targets[stageId] = {
      client,
      model: raw.model,
      options: readOptionStrings(raw.options, filePath, stageId),
    };
  }
  return targets;
}

/** Freeze schema_version 1 named a provider and optionally the client that actually ran. */
function legacyTargetClient(
  raw: Record<string, unknown>,
  filePath: string,
  stageId: string,
): string | null {
  if ((raw.client !== null && raw.client !== undefined)) {
    if (typeof raw.client !== 'string' || raw.client.trim() === '') {
      throw corrupt(filePath, `targets.${stageId}.client must be a non-empty string`);
    }
    return raw.client;
  }
  if (typeof raw.provider !== 'string' || raw.provider.trim() === '') {
    throw corrupt(filePath, `targets.${stageId} must name a provider and model`);
  }
  return legacyClientOf(raw.provider) ?? '';
}

function readOptionStrings(value: unknown, filePath: string, stageId: string): Record<string, string> {
  if ((value === null || value === undefined)) return {};
  if (!isRecord(value)) throw corrupt(filePath, `targets.${stageId}.options must be a mapping`);
  const options: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw corrupt(filePath, `targets.${stageId}.options.${key} must be a string`);
    options[key] = item;
  }
  return options;
}

/** The targets of a freeze write: the written mapping, the resolved target per stage, and one target per role. */
export interface ResolvedFreezeTargets {
  readonly written: Record<string, Record<string, unknown>>;
  readonly resolved: Record<string, StageTarget>;
  readonly roleTargets: Record<string, StageTarget>;
}

/** Resolves every role stage of `workflow` against `config`. `resumePolicies` is null when none is configured. */
export function resolveFreezeTargets(
  workflow: WorkflowDocument,
  resolve: {
    config: Record<string, unknown>;
    spec: ResolveSpecOptions;
    resumePolicies: Record<string, unknown> | null;
  },
): ResolvedFreezeTargets {
  const { config, spec, resumePolicies } = resolve;
  const out: ResolvedFreezeTargets = { written: {}, resolved: {}, roleTargets: {} };
  for (const stage of Object.values(workflow.stages)) {
    if (!isRoleStage(stage)) continue;
    const target = resolveStageSpec(config, stage, spec);
    out.resolved[stage.id] = target;
    out.roleTargets[stage.role] = target;
    out.written[stage.id] = {
      client: target.client,
      model: target.model,
      options: { ...target.options },
      ...targetExtensionField(target),
      ...(resumePolicies === null ? {} : { resume_policy: freezeStagePolicy(config, stage, target) }),
    };
  }
  return out;
}
