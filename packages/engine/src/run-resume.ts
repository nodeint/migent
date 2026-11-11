import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { GateFailure, OutcomeContext } from '@nodeint/migent-kernel';
import {
  classifyGateError,
  ConfigurationError,
  flattenHistory,
  HandoffFileError,
  QuestionFileError,
  ruleForTurn,
  StageOutcome,
} from '@nodeint/migent-kernel';
import { LEGACY_RESPONSE_PROTOCOL, renderProtocolUpdate, renderProviderPrompt } from '@nodeint/migent-prompts';
import { AgentSessionRecord, type ExecutionContext, type SessionStore } from '@nodeint/migent-session';
import { isRecord, type StageSpec } from '@nodeint/migent-workflow';

import { savedOutcome, savedResponse, storedTurn } from './run-facts.js';
import { stageFacts } from './run-setup.js';
import {
  handoffPath,
  type PendingVerify,
  promptArtifactFiles,
  questionRequestPath,
  sessionPaths,
} from './turn-types.js';

/** Helpers that reopen a cancelled execution and rebuild the state its turn loop resumes from. */

export function loadRunningExecution(
  store: SessionStore,
  sessionId: string,
  executionId: string,
): { context: ExecutionContext; metadata: Record<string, unknown> } {
  const context = store.executionContext(sessionId, executionId);
  if (context === null) throw new Error(`Execution ${executionId} was not found in session ${sessionId}.`);
  const metadata = JSON.parse(readFileSync(path.join(context.directory, 'execution.json'), 'utf8')) as unknown;
  if (!isRecord(metadata)) throw new Error(`Execution ${executionId} is unreadable.`);
  if (metadata.status !== 'running') {
    throw new Error(`Execution ${executionId} is ${String(metadata.status)}, not running.`);
  }
  return { context, metadata };
}

// Rebuilds the prompt of a reopened execution whose last message is the unanswered user prompt.
export function resumePendingPrompt(
  run: {
    store: SessionStore;
    context: ExecutionContext;
    record: AgentSessionRecord;
    metadata: Record<string, unknown>;
    sessionId: string;
    stage: StageSpec | null;
    protocol: number;
    stamped: number;
  },
  resume: { executionId: string; assistants: number; last: string },
): { currentPrompt: string; keepFile: boolean } {
  const { store, context, record, metadata, sessionId, stage, protocol, stamped } = run;
  const { executionId, assistants, last } = resume;
  const { agentId } = record;
  const { decisionValues, ask, artifactFiles, artifactName } = stageFacts(stage);
  const questionFile = questionRequestPath(context);
  const handoffFile = handoffPath(context);
  // The first turn is sent as prompt.md, contract included. A later repair turn
  // stores only the repair text, and the loop adds the contract again before sending.
  let currentPrompt: string;
  // The file a pending correction repairs must survive the first turn's cleanup.
  let keepFile = false;
  // The saved first prompt applies only while the history holds just that prompt. A correction
  // queued after an empty reply adds a user message without an assistant one.
  const userTurns = record.history.filter((item) => item.role === 'user').length;
  const pendingCorrection = ruleForTurn(storedTurn(metadata));
  if (assistants === 0 && userTurns <= 1) {
    try {
      currentPrompt = readFileSync(path.join(context.directory, 'prompt.md'), 'utf8');
    } catch {
      throw new ConfigurationError(`Execution ${executionId} has no prompt to resume.`);
    }
    // A first prompt saved under an older protocol carries the old question instructions.
    if (sessionId !== null && ask !== null && stamped < LEGACY_RESPONSE_PROTOCOL) {
      currentPrompt += renderProtocolUpdate({ ...sessionPaths(context, sessionId), turn: storedTurn(metadata),
        decisionValues, decisionInstructions: stage?.decisionInstructions, ask, questionFile,
      });
      // The stamp now says protocol 2, so the saved prompt must carry the update for the next resume.
      store.savePrompt(context, currentPrompt);
    }
  } else {
    currentPrompt = agentId
      ? last
      : flattenHistory(record.history as { role: string; content: string }[]);
    const contract = agentId && stamped >= LEGACY_RESPONSE_PROTOCOL
      ? (pendingCorrection?.contract ?? 'reminder') : 'full';
    keepFile = pendingCorrection?.keepFile ?? false;
    currentPrompt = renderProviderPrompt(currentPrompt, {
      ...sessionPaths(context, sessionId), contract, turn: storedTurn(metadata), decisionValues,
      decisionInstructions: stage?.decisionInstructions, ask, protocol, questionFile, handoffFile,
      artifactDirectory: context.artifactDirectory, artifactName, artifactFiles: promptArtifactFiles(artifactFiles),
    });
  }
  return { currentPrompt, keepFile };
}

// Re-reads the saved response of a reopened execution so the loop resumes at its verdict.
export function savedVerdict(
  saved: { store: SessionStore; context: ExecutionContext; turn: number; last: AgentSessionRecord['history'][number] },
  outcomeContext: OutcomeContext,
): PendingVerify {
  const { store, context, turn, last } = saved;
  const responseText = savedResponse(context, last);
  let outcome: StageOutcome | null = null;
  let invokeError: string | null = null;
  let gateFailure: GateFailure | null = null;
  try {
    outcome = savedOutcome({ store, context, turn }, responseText, outcomeContext);
  } catch (error) {
    if (error instanceof QuestionFileError || error instanceof HandoffFileError) {
      gateFailure = classifyGateError(error);
    } else if (error instanceof Error) {
      invokeError = error.message;
      gateFailure = classifyGateError(error);
    } else throw error;
  }
  return { responseText, outcome, invokeError, gateFailure };
}

// Loads the conversation of a reopened execution and marks it running again.
export function reopenConversation(
  target: { store: SessionStore; context: ExecutionContext },
  owner: { clientId: string; model: string; workspace: string },
): AgentSessionRecord {
  const { store, context } = target;
  const { clientId, model, workspace } = owner;
  const record = AgentSessionRecord.fromJson(
    JSON.parse(readFileSync(context.conversationReadPath, 'utf8')) as unknown,
    { client: clientId, model, workspace },
  );
  record.client = clientId;
  record.status = 'running';
  store.save(record, context);
  return record;
}
