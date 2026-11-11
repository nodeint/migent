/** Shapes and path helpers shared by the turn loop and the agent runner. */
import { statSync } from 'node:fs';
import path from 'node:path';

import type { CliClient, CorrectionLedger, ExecutionFailure, FailureClassification, GateFailure, Gates, NewSession, ProcessFacts, Question, ResponseSource, StageOutcome, StreamSummarizer, UsageCapture } from '@nodeint/migent-kernel';
import type { AgentSessionRecord, ExecutionContext, SessionStore } from '@nodeint/migent-session';
import { loadFrozenWorkflow } from '@nodeint/migent-session';
import type { StageArtifact, StageSpec } from '@nodeint/migent-workflow';

import type { ProviderEventReporter } from './provider-events.js';

export interface RunResult {
  questions?: Question[];
  questions_file?: string;
  agent_id: string;
  options: Record<string, string>;
  session_id: string;
  execution_id: string;
  artifact_directory: string;
  outcome_status: string;
  outcome_decision: string;
  session_status: string;
  response: string;
  failure_reason: string;
  /** Readable diagnostic for a correction-policy failure reason: the problem and how to recover. Absent otherwise. */
  failure_detail?: string;
  /** `quota`, `provider`, or empty when the turn was not a provider failure. */
  failure_kind: string;
  /** UTC ISO instant for a quota failure. Empty otherwise. */
  reset_at: string;
  client: string;
  /** Final status of this execution, e.g. `failed` when the provider exited non-zero without a classified failure. */
  execution_status?: string;
}

/** Task file and session directory of a workflow execution, for the prompt's Execution block. */
export function sessionPaths(
  context: ExecutionContext,
  sessionId: string | null,
): { taskFile?: string; sessionDirectory?: string } {
  if (sessionId === null) return {};
  const sessionDirectory = path.dirname(path.dirname(context.directory));
  const taskFile = path.join(sessionDirectory, 'task.md');
  try {
    return statSync(taskFile).isFile() ? { taskFile, sessionDirectory } : {};
  } catch {
    return {};
  }
}

const QUESTION_FILE_NAME = 'question-request.json';

const HANDOFF_FILE_NAME = 'handoff.json';

/** Absolute, native path the agent writes its handoff to (protocol 3). It sits outside `artifacts/`. */
export function handoffPath(context: ExecutionContext): string {
  return path.resolve(context.directory, HANDOFF_FILE_NAME);
}

/** Absolute, native path the agent writes questions to. It sits outside `artifacts/`. */
export function questionRequestPath(context: ExecutionContext): string {
  return path.resolve(context.directory, QUESTION_FILE_NAME);
}

/** What one CLI process turn produced, for the turn loop. Internal. */
export interface TurnResult {
  responseText: string;
  sessionId: string | null;
  invokeError: string | null;
  argv: string[];
  usage: UsageCapture | null;
  classification: FailureClassification | null;
  source: ResponseSource | undefined;
  exitCode: number | null;
  failure?: ExecutionFailure;
  facts?: ProcessFacts;
  summarizer: StreamSummarizer;
}

export interface PendingVerify {
  responseText: string;
  outcome: StageOutcome | null;
  invokeError: string | null;
  gateFailure: GateFailure | null;
}

export interface TurnDrive {
  client: CliClient;
  clientId: string;
  model: string;
  workspacePath: string;
  resolvedOptions: Record<string, string>;
  profile: Record<string, string>;
  store: SessionStore;
  context: ExecutionContext;
  record: AgentSessionRecord;
  eventReporter: ProviderEventReporter;
  sessionId: string | null;
  stage: StageSpec | null;
  decisionValues: string[];
  artifactName: string | null;
  verifyCommands: string[];
  maxVerify: number;
  verifyTimeoutSec: number | null;
  turn: number;
  red: number;
  verifyRuns: number;
  lastReport: string | null;
  lastResult: 'pass' | 'fail' | null;
  currentPrompt: string;
  currentAgentId: string | null;
  currentSession: NewSession | null;
  pendingVerify: PendingVerify | null;
  corrections: CorrectionLedger;
  /** Response protocol the execution runs under. */
  protocol: number;
  /** The first turn must not delete the file a resumed correction asks the agent to repair. */
  keepFile?: boolean;
}

export function frozenDocument(context: ExecutionContext): ReturnType<typeof loadFrozenWorkflow> {
  return loadFrozenWorkflow(path.dirname(path.dirname(context.directory)));
}

export function promptArtifactFiles(
  files: readonly { artifact: StageArtifact; decision: string | null }[],
): { file: string; description: string | null; required: boolean; decision: string | null }[] {
  return files.map(({ artifact, decision }) => ({
    file: artifact.file,
    description: artifact.description,
    required: artifact.required,
    decision,
  }));
}

/** Arguments of one provider turn, passed to the injected runner. */
export interface RunTurnArgs {
  client: CliClient;
  model: string;
  workspace: string;
  prompt: string;
  agentId: string | null;
  newSession: NewSession | null;
  options: Record<string, string>;
  eventReporter: ProviderEventReporter;
  store: SessionStore;
  context: ExecutionContext;
  turn: number;
}

/** What one pass of the loop produced. Created at the top of each pass and passed to every step. */
export interface Iteration {
  readonly responseText: string;
  readonly outcome: StageOutcome | null;
  readonly invokeError: string | null;
  readonly gateFailure: GateFailure | null;
  readonly eligible: boolean;
  readonly pendingGate: boolean;
  readonly needsVerify: boolean;
}

/** What the steps of one fresh provider turn share. Separate from the loop's persistent state. */
export interface FreshTurn {
  readonly turnResult: TurnResult;
  readonly parsedSource: ResponseSource | undefined;
  readonly source: ResponseSource;
  readonly recordsTurn: boolean;
  readonly exitOnly: boolean;
  readonly candidate: boolean;
  readonly exitMessage: string | null;
  readonly anomalyReason: string | null;
  readonly turnError: string | null;
  readonly gates: Gates;
  readonly turnDetails: Record<string, unknown>;
  readonly modelResponded: boolean;
  readonly recordedClassification: FailureClassification | null;
}
