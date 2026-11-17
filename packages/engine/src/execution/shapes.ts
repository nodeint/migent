import {
  arrayOf, type Check, either, isBoolean, isNumber, isRecord, isString, nullable, oneOf, optional, shape,
} from './plain.js';

/**
 * The boundary checks of the three operations. Each substantiates its whole type: every member a consumer reads
 * is present with its kind, and every literal union is one of its members. They run on detached data only.
 */
const SOURCES = ['model', 'error', 'none'] as const;
const ORIGINS = ['provider-error', 'exit-only', 'start'] as const;
const DRAINS = ['closed', 'grace-expired'] as const;
const CORRECTION_KINDS = ['response_contract', 'stage_output', 'question_file', 'handoff'] as const;

const question: Check = shape({
  id: isString, question: isString, context: isString, selection: oneOf('single', 'multiple'),
  options: arrayOf(shape({ id: isString, label: isString, description: optional(isString) })),
  recommended: optional(arrayOf(isString)),
});

export const outcomeData: Check = shape({
  status: oneOf('complete', 'blocked', 'question'),
  blocker: nullable(isString), decision: nullable(isString), question: nullable(isString),
  questions: arrayOf(question),
});

export const gateFailureData: Check = shape({
  kind: oneOf(...CORRECTION_KINDS), errorKind: isString, detail: isString,
});

const classificationData: Check = either(
  shape({
    kind: oneOf('quota'), origin: oneOf(...ORIGINS), message: isString, resetAt: nullable(isString),
    window: nullable(isString),
  }),
  shape({ kind: oneOf('provider'), origin: oneOf(...ORIGINS), message: isString }),
);

const gateResult: Check = either(
  shape({ state: oneOf('passed'), status: optional(isString) }),
  shape({ state: oneOf('failed'), reason: isString }),
  shape({ state: oneOf('not-evaluated', 'not-applicable') }),
);

const gates: Check = shape({ outcome: gateResult, artifact: gateResult, completion_outputs: gateResult });

const executionFailure: Check = nullable(shape({
  kind: oneOf('start', 'provider-exit'), result: nullable(isRecord), phase: nullable(isString),
  code: nullable(isString), errno: nullable(isNumber), syscall: nullable(isString), path: nullable(isString),
  message: isString, stderrTail: isString, exitCode: nullable(isNumber), signal: nullable(isString),
  stderrTotalBytes: isNumber, drain: oneOf(...DRAINS), endpoint: isString, executable: isString, argCount: isNumber,
  cwd: isString, spawnedAt: isString, failedAt: isString,
}));

const processFacts: Check = nullable(shape({
  exitCode: nullable(isNumber), signal: nullable(isString), stderrTail: isString, stderrTotalBytes: isNumber,
  drain: oneOf(...DRAINS), stdoutBytes: isNumber, stdoutLines: isNumber, endpoint: isString, executable: isString,
  argCount: isNumber, cwd: isString, spawnedAt: isString, endedAt: isString,
}));

const streamSummary: Check = shape({
  stdout_bytes: isNumber, lines: isNumber, non_json_lines: isNumber, events: isRecord,
  last_events: arrayOf(isString), labelled: isBoolean, error_messages: arrayOf(isString),
});

const verifyRunResult: Check = shape({
  passed: isBoolean, infraError: nullable(isString),
  commands: arrayOf(shape({
    command: isString, status: oneOf('pass', 'fail', 'timed_out', 'skipped'), exitCode: nullable(isNumber),
    log: nullable(isString), tail: arrayOf(isString),
  })),
});

export const gateOutputCheck: Check = shape({
  responseText: isString, outcome: nullable(outcomeData), invokeError: nullable(isString),
  gateFailure: nullable(gateFailureData), eligible: isBoolean, pendingGate: isBoolean,
  anomalyReason: nullable(isString), turnError: nullable(isString), gates,
});

export const turnInputCheck: Check = shape({
  turn: isNumber, prompt: isString, agentId: nullable(isString), newAgentId: nullable(isString),
  recordAgentId: nullable(isString), keepFile: isBoolean,
});

export const turnOutputCheck: Check = shape({
  responseText: isString, sessionId: nullable(isString), invokeError: nullable(isString),
  exitCode: nullable(isNumber), parsedSource: nullable(oneOf(...SOURCES)), source: oneOf(...SOURCES),
  classification: nullable(classificationData), agentId: nullable(isString), turnDetails: isRecord,
  recordsTurn: isBoolean, exitOnly: isBoolean, candidate: isBoolean, eligible: isBoolean,
  anomalyReason: nullable(isString), exitMessage: nullable(isString), turnError: nullable(isString),
  failure: executionFailure, facts: processFacts, stream: streamSummary, gate: gateOutputCheck,
});

export const gateInputCheck: Check = shape({
  responseText: isString, invokeError: nullable(isString), gateFailure: nullable(gateFailureData),
  outcome: nullable(outcomeData),
});

export const verifyInputCheck: Check = shape({
  turn: isNumber, commands: arrayOf(isString), timeoutSec: nullable(isNumber), run: isNumber, redIfPassed: isNumber,
  redIfFailed: isNumber, maxVerify: isNumber,
});

export const verifyOutputCheck: Check = shape({ result: verifyRunResult, report: isString, reportPath: isString });
