import path from 'node:path';

import { WORKFLOW_SCHEMA_VERSION } from '@nodeint/migent-contracts';

import { SCHEMA_V2 } from './constants.js';

/** The recipient is separate from the question outcome; more recipients can be added later. */
export type AskTarget = 'human';

export const VERIFY_ARTIFACT = 'verify.md';

/** Run the stage only when a changed Git path matches one of the globs. */
export interface RunWhen {
  changedPaths: string[];
}

/**
 * The agent a stage selects: a name in `agents`, or a complete inline definition kept as the raw
 * mapping for the config loader to validate. `null` means the role's own agent.
 */
export type StageAgent =
  | { kind: 'named'; name: string }
  | { kind: 'inline'; value: Record<string, unknown> };

export interface StageFields {
  ask?: AskTarget;
  id: string;
  description: string | null;
  /** Stage-level artifacts the stage writes on every `complete`. */
  artifacts: StageArtifact[];
  /** Artifacts a decision adds, keyed by decision name (schema 7 only). */
  decisionArtifacts: Record<string, StageArtifact[]>;
  decisionValues: string[];
  decisionInstructions?: Record<string, string>;
  dependsOn: string[];
  resumeFrom: string | null;
  instructions: string[];
  agent: StageAgent | null;
  /** Stage option layer of schema_version 4 and earlier. Always empty from version 5 on. */
  options: Record<string, string>;
  maxRevisions: number | null;
  routes: Record<string, string | string[]>;
  verify: string[];
  maxVerify: number;
  verifyTimeoutSec: number | null;
  runWhen: RunWhen | null;
}

export interface RoleStageSpec extends StageFields {
  kind: 'role';
  role: string;
}

export interface VerifyOnlyStageSpec extends StageFields {
  kind: 'verify';
  role: null;
  verify: string[];
  maxVerify: 0;
}

export type StageSpec = RoleStageSpec | VerifyOnlyStageSpec;

export function isRoleStage(stage: StageSpec): stage is RoleStageSpec {
  return stage.kind === 'role';
}

/** One file a stage writes into its artifacts directory. */
export interface StageArtifact {
  id: string;
  file: string;
  description: string | null;
  required: boolean;
  /** `published` artifacts come from the registry; `local` ones are defined inline on a decision. */
  scope: 'published' | 'local';
}

/** A top-level (published) artifact of a schema 7 workflow and its single producer. */
export interface ArtifactSpec extends StageArtifact {
  producer: { stage: string; decision: string | null };
}

export interface WorkflowOutput {
  name: string;
  fromStage: string;
  artifact: string;
  /** Schema 7 only: guaranteed at completion. Absent means required. */
  required?: boolean;
  /** Schema 7 only: the decision that produces it; null for stage-level artifacts. */
  decision?: string | null;
}

/** Files a `complete` turn of `stage` writes: stage-level plus those of the chosen decision. */
export function stageArtifactsFor(stage: StageSpec, decision: string | null): StageArtifact[] {
  const chosen = decision === null ? undefined : stage.decisionArtifacts[decision.toLowerCase()];
  return chosen === undefined ? stage.artifacts : [...stage.artifacts, ...chosen];
}

/** Every file a stage may write, with the decision that adds it (null for stage-level). */
export function allStageArtifacts(stage: StageSpec): { artifact: StageArtifact; decision: string | null }[] {
  const all: { artifact: StageArtifact; decision: string | null }[] = stage.artifacts.map((artifact) => ({ artifact, decision: null }));
  for (const [decision, list] of Object.entries(stage.decisionArtifacts)) {
    for (const artifact of list) all.push({ artifact, decision });
  }
  return all;
}

export interface WorkflowCompletion {
  stage: string;
  decision: string | null;
  outputs: WorkflowOutput[];
}

/** Historical schema <=3 only; retained for frozen-session compatibility. */
export interface WorkflowRequires {
  workflow: string;
  decision: string | null;
}

export interface WorkflowDownstream {
  workflow: string;
  task: string;
  /** Absent means every published artifact is passed under its own id. */
  artifacts?: Record<string, string>;
}

export interface WorkflowDocument {
  id: string;
  stages: Record<string, StageSpec>;
  completion: WorkflowCompletion | null;
  requires: WorkflowRequires | null;
  constraints: string[];
  source: string | null;
  /** Missing on hand-built documents means version 1 behavior. */
  schemaVersion?: number;
  concurrency?: number;
  outputs?: WorkflowOutput[];
  /** Schema 7 artifact registry, in declaration order. */
  artifacts?: ArtifactSpec[];
  downstream?: WorkflowDownstream[];
  /** Authoring diagnostics from parsing; not part of the document schema. */
  warnings?: string[];
}

/** Accepted workflow and config document version. */
export const SCHEMA_VERSION = WORKFLOW_SCHEMA_VERSION;

export function isWorkflowV2(workflow: WorkflowDocument | null | undefined): boolean {
  return (workflow?.schemaVersion ?? 1) >= SCHEMA_V2;
}

export interface WorkflowCatalog {
  documents: Record<string, WorkflowDocument>;
  problems: string[];
}

export function isPathReference(reference: string): boolean {
  return (
    reference.endsWith('.yaml') ||
    reference.endsWith('.yml') ||
    reference.includes('/') ||
    reference.includes('\\') ||
    path.isAbsolute(reference)
  );
}
