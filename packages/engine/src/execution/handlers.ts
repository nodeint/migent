import { rmSync } from 'node:fs';

import {
  type CliClient, type CorrectionFiles, formatVerifyReport, type Gates, type NewSession, type StageOutcome,
  type VerifyRunner,
  type VerifyRunResult,
} from '@nodeint/migent-kernel';
import type { ExecutionContext, SessionStore } from '@nodeint/migent-session';
import type { StageSpec } from '@nodeint/migent-workflow';

import type { ProviderEventReporter } from '../provider-events.js';
import type { Operation } from '../runtime/operation.js';
import type { ChangeApplier } from '../runtime/operation.js';
import {
  assessProviderTurn, checkOutputs, evaluateGates, type Iteration, type OutputCheck, type TurnAssessment,
} from '../turn-steps.js';
import type { RunTurnArgs, TurnResult } from '../turn-types.js';
import { commitCancelled } from './cancel.js';
import type { Change } from './changes.js';
import { toOutcomeData, toStageOutcome } from './outcome-data.js';
import { detach, detachRecord } from './plain.js';
import {
  gateInputCheck, gateOutputCheck, turnInputCheck, turnOutputCheck, verifyInputCheck, verifyOutputCheck,
} from './shapes.js';
import {
  AGENT_TURN, type GateInput, type GateOutput, REPLY_GATE, toClassificationData, toGateFailureData, type TurnInput,
  type TurnOutput, VERIFY_RUN, type VerifyInput, type VerifyOutput,
verifyReportPath,
} from './types.js';

type AgentTurnOperation = Operation<TurnInput, TurnOutput, Change>;

/** Live services of the provider turn. They reach the handler through its construction, never the request. */
export type TurnServices = {
  readonly client: CliClient;
  readonly model: string;
  readonly workspace: string;
  readonly options: Record<string, string>;
  readonly store: SessionStore;
  readonly context: ExecutionContext;
  readonly eventReporter: ProviderEventReporter;
  readonly signalFile: string;
  readonly applier: ChangeApplier<Change>;
  readonly runTurn: (args: RunTurnArgs) => Promise<TurnResult>;
  /** The stage facts the gates over the fresh reply read. */
  readonly gates: GateServices;
};

const NOT_EVALUATED: Gates = {
  outcome: { state: 'not-evaluated' },
  artifact: { state: 'not-evaluated' },
  completion_outputs: { state: 'not-evaluated' },
};

/** The provider turn: signal-file cleanup, the provider process, its assessment, and the gates over its reply. */
export function createAgentTurnOperation(services: TurnServices): AgentTurnOperation {
  return {
    id: AGENT_TURN,
    interceptable: { before: ['prompt'] },
    acceptsInput: (input): input is TurnInput => turnInputCheck(input),
    producesOutput: (output): output is TurnOutput => turnOutputCheck(output),
    handle: async (input) => ({ kind: 'succeeded', output: await runAgentTurn(services, input), changes: [] }),
  };
}

async function runAgentTurn(services: TurnServices, input: TurnInput): Promise<TurnOutput> {
  const { client, model, workspace, options, store, context, eventReporter } = services;
  // A request file left by an earlier turn must not be read as a new question. The
  // correction turn keeps the invalid file so the agent can repair it.
  if (!input.keepFile) rmSync(services.signalFile, { force: true });
  const newSession: NewSession | null = input.newAgentId === null ? null : { agentId: input.newAgentId };
  let result: TurnResult;
  try {
    result = await services.runTurn({
      client, model, workspace, prompt: input.prompt, agentId: input.agentId, newSession, options, eventReporter,
      store, context, turn: input.turn,
    });
  } catch (error) {
    return commitCancelled({ applier: services.applier, context, style: 'role' }, error);
  }
  const assessment = assessProviderTurn({ priorAgentId: input.recordAgentId, turn: input.turn }, result);
  return describeTurn(result, assessment, gateFresh(services.gates, assessment));
}

function describeTurn(
  result: TurnResult,
  assessment: ReturnType<typeof assessProviderTurn>,
  gate: GateOutput,
): TurnOutput {
  const errors = assessment.classification?.origin === 'provider-error' ? [assessment.classification.message] : [];
  const stream = result.summarizer.finish(
    { bytes: result.facts?.stdoutBytes ?? 0, lines: result.facts?.stdoutLines ?? 0 }, errors,
  );
  return {
    responseText: assessment.responseText,
    sessionId: result.sessionId,
    invokeError: assessment.invokeError,
    exitCode: assessment.exitCode,
    parsedSource: assessment.parsedSource ?? null,
    source: assessment.source,
    classification: toClassificationData(assessment.classification),
    agentId: assessment.agentId,
    turnDetails: detachRecord(assessment.turnDetails),
    recordsTurn: assessment.recordsTurn,
    exitOnly: assessment.exitOnly,
    candidate: assessment.candidate,
    eligible: assessment.eligible,
    anomalyReason: assessment.anomalyReason,
    exitMessage: assessment.exitMessage,
    failure: result.failure === undefined ? null : detach(result.failure),
    facts: result.facts === undefined ? null : detach(result.facts),
    stream: detach(stream),
    turnError: assessment.turnError,
    gate,
  };
}

/** The stage facts the gates read. */
export type GateServices = {
  readonly sessionId: string | null;
  readonly stage: StageSpec | null;
  readonly decisionValues: string[];
  readonly artifactName: string | null;
  readonly ask: 'human' | null;
  readonly protocol: number;
  readonly files: CorrectionFiles;
  readonly store: SessionStore;
  readonly context: ExecutionContext;
};

type ReplyGateOperation = Operation<GateInput, GateOutput, Change>;

/** The gates over a saved reply a resumed execution starts from. A fresh reply is gated inside `agent.turn`. */
export function createReplyGateOperation(services: GateServices): ReplyGateOperation {
  return {
    id: REPLY_GATE,
    acceptsInput: (input): input is GateInput => gateInputCheck(input),
    producesOutput: (output): output is GateOutput => gateOutputCheck(output),
    handle: (input) => Promise.resolve({
      kind: 'succeeded',
      output: gateSaved(services, input),
      changes: [],
    }),
  };
}

function gateFresh(services: GateServices, input: TurnAssessment): GateOutput {
  const { sessionId, decisionValues, ask, protocol, files, artifactName } = services;
  const it: Iteration = {
    responseText: input.responseText, outcome: null, invokeError: input.invokeError, gateFailure: null,
    eligible: input.eligible, pendingGate: false, needsVerify: false,
  };
  const seed = {
    gates: NOT_EVALUATED, candidate: input.candidate, anomalyReason: input.anomalyReason, turnError: input.turnError,
  };
  const loop = {
    sessionId, decisionValues, ask, protocol, questionFile: files.questionFile, handoffFile: files.handoffFile,
    artifactName, checkOutputs: (reply: StageOutcome): OutputCheck => outputCheck(services, reply),
  };
  const evaluated = evaluateGates(loop, it, seed);
  const { iteration } = evaluated;
  return {
    responseText: iteration.responseText,
    outcome: iteration.outcome === null ? null : toOutcomeData(iteration.outcome),
    invokeError: iteration.invokeError,
    gateFailure: toGateFailureData(iteration.gateFailure),
    eligible: iteration.eligible,
    pendingGate: false,
    anomalyReason: evaluated.seed.anomalyReason,
    turnError: evaluated.seed.turnError,
    gates: detach(evaluated.seed.gates),
  };
}

// A saved reply passes the same output gates a fresh one does before it is accepted.
function gateSaved(services: GateServices, input: GateInput): GateOutput {
  let { invokeError, gateFailure } = input;
  if (invokeError === null && gateFailure === null && input.outcome !== null) {
    const bad = outputCheck(services, toStageOutcome(input.outcome)).failure;
    if (bad !== null) {
      gateFailure = toGateFailureData(bad);
      invokeError = bad.detail;
    }
  }
  return {
    responseText: input.responseText, outcome: input.outcome, invokeError, gateFailure, eligible: true,
    pendingGate: true, anomalyReason: null, turnError: null, gates: detach(NOT_EVALUATED),
  };
}

function outputCheck(services: GateServices, reply: StageOutcome): OutputCheck {
  const { stage, artifactName, context, store } = services;
  return checkOutputs({ stage, artifactName, context, store }, reply);
}

type VerifyRunOperation = Operation<VerifyInput, VerifyOutput, Change>;

/** Live services of the verify run. */
export type VerifyServices = {
  readonly store: SessionStore;
  readonly context: ExecutionContext;
  readonly eventReporter: ProviderEventReporter;
  readonly verifyRunner: Pick<VerifyRunner, 'run'>;
  readonly workspace: string;
  readonly applier: ChangeApplier<Change>;
  readonly cancel: 'role' | 'verify-only';
};

/** Runs the verify commands and proposes saving the report. Verdict events are the definition's. */
export function createVerifyRunOperation(services: VerifyServices): VerifyRunOperation {
  return {
    id: VERIFY_RUN,
    acceptsInput: (input): input is VerifyInput => verifyInputCheck(input),
    producesOutput: (output): output is VerifyOutput => verifyOutputCheck(output),
    handle: async (input) => {
      const output = await runVerify(services, input);
      return {
        kind: 'succeeded', output, changes: [{ kind: 'saveTurnVerify', turn: input.turn, report: output.report }],
      };
    },
  };
}

async function runVerify(services: VerifyServices, input: VerifyInput): Promise<VerifyOutput> {
  const { store, context, eventReporter } = services;
  // A role execution clears the stale process endpoint first; verify-only never had one.
  if (services.cancel === 'role') store.clearProcessEndpoint(context);
  eventReporter.emit('verify.started', `${input.commands.length} command(s)`, {
    turn: input.turn, commands: input.commands,
  });
  let result: VerifyRunResult;
  try {
    result = await services.verifyRunner.run({
      commands: [...input.commands],
      workspace: services.workspace,
      executionDirectory: context.directory,
      turnDirectory: store.turnDirectory(context, input.turn),
      timeoutSec: input.timeoutSec,
      onStart: (info) => {
        store.saveProcessMetadata(context, info);
      },
      onEnd: () => {
        store.clearProcessEndpoint(context);
      },
      onHeartbeat: (command, elapsed) => {
        eventReporter.emit('verify.heartbeat', `${command} running for ${elapsed}s`, {
          turn: input.turn, command, elapsed_seconds: elapsed,
        });
      },
    });
  } catch (error) {
    return commitCancelled({ applier: services.applier, context, style: services.cancel }, error);
  }
  const report = formatVerifyReport(result, {
    run: input.run, red: result.passed ? input.redIfPassed : input.redIfFailed, maxVerify: input.maxVerify,
    timeoutSec: input.timeoutSec,
  });
  return { result: detach(result), report, reportPath: verifyReportPath(input.turn) };
}
