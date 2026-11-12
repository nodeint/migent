import type { WorkflowDocument } from '@nodeint/migent-workflow';

import type { ParsedEvent } from './session-events.js';
import type { TitleRecord } from './session-title.js';

export interface SessionManifest {
  sessionId: string;
  title: string | null;
  workflowId: string | null;
  workflowPath: string | null;
  role: string | null;
  task: string | null;
  createdAt: string | null;
  priorSessionId: string | null;
  manifestStatus: string | null;
  schemaVersion: number;
}

export interface FoldExecution {
  executionId: string;
  executionOrder: number;
  stageId: string;
  stageAttempt: number;
  client: string;
  model: string;
  resumesExecutionId: string | null;
  status: string;
  outcome: Record<string, unknown> | null;
  error: string | null;
  failureReason: string | null;
  createdAt: string | null;
  completedAt: string | null;
  artifactDirectory?: string;
}

export interface FoldInputs {
  schemaVersion: number;
  manifest: SessionManifest;
  events: readonly ParsedEvent[];
  executions: readonly FoldExecution[];
  /** Present execution ids. An `execution.started` whose file is absent is not in this set. */
  presentExecutionIds: ReadonlySet<string>;
  previousStatus: Record<string, unknown> | null;
  outputFiles: readonly string[];
  workflow: WorkflowDocument | null;
  /** The rename record (`title.json`), or null. */
  titleRecord: TitleRecord | null;
}
