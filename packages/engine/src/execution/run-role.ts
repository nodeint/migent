import { log, type VerifyRunner } from '@nodeint/migent-kernel';
import { HANDOFF_FILE_PROTOCOL } from '@nodeint/migent-prompts';
import type { ExecutionContext, SessionStore } from '@nodeint/migent-session';

import { stageExtensions } from '../response-extensions.js';
import type { InterceptorChain } from '../runtime/interception.js';
import { OperationRuntime } from '../runtime/operation-runtime.js';
import type { TraceSink } from '../runtime/trace.js';
import type { RunResult, RunTurnArgs, TurnDrive, TurnResult } from '../turn-types.js';
import { handoffPath, questionRequestPath } from '../turn-types.js';
import { ExecutionApplier } from './applier.js';
import {
  createAgentTurnOperation, createReplyGateOperation, createVerifyRunOperation, type GateServices,
} from './handlers.js';
import { toOutcomeData } from './outcome-data.js';
import { roleDefinition } from './role-definition.js';
import { savedGateRequest, turnRequest } from './role-requests.js';
import type { RoleFacts, RoleState } from './role-state.js';
import { buildRunResult } from './run-result.js';
import { toGateFailureData } from './types.js';

type Drive = TurnDrive;

function factsOf(drive: Drive): RoleFacts {
  const questionFile = questionRequestPath(drive.context);
  const handoffFile = handoffPath(drive.context);
  return {
    context: drive.context, clientId: drive.clientId, model: drive.model, profile: drive.profile,
    workspacePath: drive.workspacePath, sessionId: drive.sessionId, stage: drive.stage,
    decisionValues: drive.decisionValues, artifactName: drive.artifactName,
    ask: drive.stage?.ask ?? (drive.stage === null ? 'human' : null), protocol: drive.protocol,
    extensions: drive.sessionId === null
      ? { prompts: [], rules: [] } : stageExtensions(drive.context, drive.store.stageId(drive.context), drive.protocol),
    files: { protocol: drive.protocol, questionFile, handoffFile }, verifyCommands: drive.verifyCommands,
    maxVerify: drive.maxVerify, verifyTimeoutSec: drive.verifyTimeoutSec,
  };
}

function initialState(drive: Drive, facts: RoleFacts): RoleState {
  return {
    facts, turn: drive.turn, red: drive.red, verifyRuns: drive.verifyRuns, lastReport: drive.lastReport,
    lastResult: drive.lastResult, corrections: drive.corrections, classification: null, failureReason: '',
    failureDetail: '', currentAgentId: drive.currentAgentId, recordAgentId: drive.record.agentId,
    history: drive.record.history.map((item) => ({
      role: item.role === 'assistant' ? 'assistant' : 'user', content: item.content ?? '',
    })),
    status: drive.record.status, reply: null,
  };
}

/** Writes each runtime decision to the execution's debug log and stderr, as the turn steps always did. */
export function debugTrace(store: SessionStore, context: ExecutionContext): TraceSink {
  return {
    record: (entry) => {
      const line = `${new Date().toISOString()} runtime ${JSON.stringify(entry)}`;
      log(`debug: ${line}`);
      store.appendDebugLog(context, line);
    },
  };
}

/** Runs one role execution through the operation runtime and returns its result. */
export async function runRoleExecution(
  drive: Drive,
  services: {
    runTurn: (args: RunTurnArgs) => Promise<TurnResult>;
    verifyRunner: VerifyRunner;
    interceptors?: InterceptorChain;
  },
): Promise<RunResult> {
  const { client, model, workspacePath, resolvedOptions, store, context, record, eventReporter } = drive;
  const facts = factsOf(drive);
  const applier = new ExecutionApplier({ record, store, context, eventReporter });
  const signalFile = drive.protocol >= HANDOFF_FILE_PROTOCOL ? facts.files.handoffFile : facts.files.questionFile;
  const gates: GateServices = {
    sessionId: drive.sessionId, stage: drive.stage, decisionValues: drive.decisionValues,
    artifactName: drive.artifactName, ask: facts.ask, protocol: drive.protocol,
    extensions: facts.extensions?.rules ?? [], files: facts.files, store, context,
  };
  const runtime = new OperationRuntime({
    applier,
    ...(services.interceptors === undefined ? {} : { interceptors: services.interceptors }),
    trace: debugTrace(store, context),
    operations: [
      createAgentTurnOperation({
        client, model, workspace: workspacePath, options: resolvedOptions, store, context, eventReporter,
        signalFile, applier, runTurn: services.runTurn, gates,
      }),
      createReplyGateOperation(gates),
      createVerifyRunOperation({
        store, context, eventReporter, verifyRunner: services.verifyRunner, workspace: workspacePath, applier,
        cancel: 'role',
      }),
    ],
  });
  const state = initialState(drive, facts);
  const { pendingVerify } = drive;
  const request = pendingVerify === null
    ? turnRequest(state, {
      prompt: drive.currentPrompt, keepFile: drive.keepFile ?? false, newAgentId: drive.currentSession?.agentId ?? null,
    })
    : savedGateRequest(state, {
      responseText: pendingVerify.responseText, invokeError: pendingVerify.invokeError,
      gateFailure: toGateFailureData(pendingVerify.gateFailure),
      outcome: pendingVerify.outcome === null ? null : toOutcomeData(pendingVerify.outcome),
    });
  const end = await runtime.run({
    scope: { sessionId: context.sessionId, stageId: store.stageId(context), role: drive.stage?.role ?? '' },
    definition: roleDefinition, state, request,
  });
  return buildRunResult({ record, store, context, eventReporter }, end);
}
