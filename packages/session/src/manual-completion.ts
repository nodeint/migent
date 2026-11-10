import path from "node:path";
import {
  isArtifactSchema,
  missingCompletionOutputNames,
  missingWorkflowOutputNames,
  publishOutputFiles,
  resolveArtifactSources,
  selectSourceExecution,
  type ExecutionSnapshot,
} from "./outputs.js";
import { currentCompleteByStage } from "./selection.js";
import type { LedgerOutput } from "./session-ledger.js";
import { isWorkflowV2, type WorkflowDocument } from "@nodeint/migent-workflow";

/** `published_by_execution_id` for outputs published by `migent session complete`. */
export const MANUAL_PUBLISHER = "manual";

export interface ManualCompletionPlan {
  outputs: LedgerOutput[];
  /** Required outputs that cannot be resolved or are empty. */
  missing: string[];
}

/**
 * Publish what a normal completion would publish, from the current completions.
 * Schema 7 resolves the artifact registry (skip-aware); schema 2-6 use top-level `outputs`;
 * version 1 uses `completion.outputs`. Empty or unresolvable sources are not published.
 * Returns empty plan with no missing artifacts when workflow is null (caller validates).
 */
export function publishManualCompletion(
  sessionDirectory: string,
  workflow: WorkflowDocument | null,
  snapshots: readonly ExecutionSnapshot[],
): ManualCompletionPlan {
  if (workflow === null) return { outputs: [], missing: [] };
  const sources: Record<string, readonly [string, string]> = {};
  let missing: string[];
  if (isWorkflowV2(workflow)) {
    if (isArtifactSchema(workflow)) {
      const current = currentCompleteByStage(workflow, snapshots);
      for (const item of resolveArtifactSources(workflow, current)) {
        if (item.source === null) continue;
        sources[item.name] = [path.join(item.source.artifactDirectory, item.file), item.source.executionId];
      }
      missing = missingWorkflowOutputNames(workflow, snapshots, current);
    } else {
      for (const output of workflow.outputs ?? []) {
        const source = selectSourceExecution(snapshots, output.fromStage, Number.POSITIVE_INFINITY);
        if (source === null) continue;
        sources[output.name] = [path.join(source.artifactDirectory, output.artifact), source.executionId];
      }
      missing = missingWorkflowOutputNames(workflow, snapshots);
    }
  } else {
    for (const output of workflow.completion?.outputs ?? []) {
      const source = selectSourceExecution(snapshots, output.fromStage, Number.POSITIVE_INFINITY);
      if (source === null) continue;
      sources[output.name] = [path.join(source.artifactDirectory, output.artifact), source.executionId];
    }
    missing = missingCompletionOutputNames({ workflow, snapshots, beforeOrder: Number.POSITIVE_INFINITY });
  }
  const outputs = Object.entries(publishOutputFiles(sessionDirectory, sources, MANUAL_PUBLISHER)).map(([name, output]) => ({
    name,
    path: output.path,
    source_execution_id: output.sourceExecutionId,
    published_by_execution_id: output.publishedByExecutionId,
  }));
  return { outputs, missing };
}
