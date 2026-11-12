import path from 'node:path';

import type { ExecutionSnapshot } from '@nodeint/migent-kernel';
import { flattenHistory } from '@nodeint/migent-kernel';
import { renderProviderPrompt } from '@nodeint/migent-prompts';

import type { verifyProgress } from './run-facts.js';
import type { RunRequest, StageFacts } from './run-setup.js';
import { handoffPath, promptArtifactFiles, questionRequestPath, sessionPaths, type TurnDrive } from './turn-types.js';

export type DriveBaseRun = Pick<
  TurnDrive,
  'client' | 'clientId' | 'model' | 'workspacePath' | 'resolvedOptions' | 'profile' | 'store' | 'context'
  | 'record' | 'eventReporter' | 'sessionId'
>;

export interface PriorExecution {
  protocol: number;
  previous: ExecutionSnapshot | undefined;
  progress: ReturnType<typeof verifyProgress> | null;
  sameConversation: boolean;
}

export type StageDriveKey = 'stage' | 'decisionValues' | 'artifactName' | 'verifyCommands' | 'maxVerify' | 'verifyTimeoutSec';

export type ContinuedDrive = Omit<TurnDrive, 'turn' | 'currentPrompt' | 'currentAgentId' | 'pendingVerify' | 'keepFile'>;

export interface OpenedRun extends DriveBaseRun {
  stageId: string;
  isNew: boolean;
  newSession: TurnDrive['currentSession'];
  agentId: string | null;
}

// The drive fields shared by a fresh run and a continued cancelled execution.
export function driveBase(
  run: DriveBaseRun,
  stage: TurnDrive['stage'],
  facts: StageFacts,
): DriveBaseRun & Pick<TurnDrive, StageDriveKey> {
  const { client, clientId, model, workspacePath, resolvedOptions, profile } = run;
  const { store, context, record, eventReporter, sessionId } = run;
  return {
    client, clientId, model, workspacePath, resolvedOptions, profile, store, context, record, eventReporter, sessionId,
    stage,
    decisionValues: facts.decisionValues,
    artifactName: facts.artifactName,
    verifyCommands: facts.verifyCommands,
    maxVerify: stage?.maxVerify ?? 0,
    verifyTimeoutSec: stage?.verifyTimeoutSec ?? null,
  };
}

// Renders the first turn's provider prompt, flattening history when a continued run has no agent id.
export function renderFirstPrompt(run: {
  request: RunRequest;
  opened: OpenedRun;
  stage: TurnDrive['stage'];
  facts: StageFacts;
  prior: PriorExecution;
}): string {
  const { request, opened, stage, facts, prior } = run;
  const { context, sessionId, record, isNew, agentId } = opened;
  const basePrompt = !isNew && !agentId
    ? flattenHistory(record.history as { role: string; content: string }[])
    : request.prompt;
  const conversationContract = prior.sameConversation ? 'reminder' : 'full';
  return renderProviderPrompt(basePrompt, { ...sessionPaths(context, sessionId),
    contract: sessionId === null ? false : conversationContract, turn: request.turn ?? null,
    decisionValues: facts.decisionValues,
    decisionInstructions: stage?.decisionInstructions, ask: facts.ask,
    protocol: prior.protocol, questionFile: questionRequestPath(context), handoffFile: handoffPath(context),
    artifactDirectory: context.artifactDirectory, artifactName: facts.artifactName,
    artifactFiles: promptArtifactFiles(facts.artifactFiles),
    previousArtifactDirectory: prior.previous?.artifactDirectory ?? null,
    previousVerifyReport: previousReportPath(prior.previous, prior.progress),
  });
}

/** The previous execution's last verify report, absolute or relative to `from` when given. */
export function previousReportPath(
  previous: ExecutionSnapshot | undefined,
  progress: { lastReport: string | null } | null,
  from?: string,
): string | null {
  if (!previous || !progress?.lastReport) return null;
  const report = path.resolve(path.dirname(previous.artifactDirectory), progress.lastReport);
  return from === undefined ? report : path.relative(from, report);
}
