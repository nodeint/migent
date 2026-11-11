import type { CliClient, CommandResult, StreamSummarizer, UsageCapture } from '@nodeint/migent-kernel';
import { debugEnabled, log } from '@nodeint/migent-kernel';
import type { ExecutionContext, SessionStore } from '@nodeint/migent-session';
import { isRecord } from '@nodeint/migent-workflow';

import type { ProviderEventReporter } from './provider-events.js';
import { classifyFinishedProcess } from './run-setup.js';
import type { TurnResult } from './turn-types.js';

/** Helpers for one provider turn: debug logging, stream event forwarding, and the finished result. */

export function turnDebugStep(
  store: SessionStore,
  context: ExecutionContext,
  turn: number,
): ((step: string, fromWrapper?: boolean) => void) | null {
  return debugEnabled()
    ? (step: string, fromWrapper = false) => {
        const line = `${new Date().toISOString()} turn=${turn} ${fromWrapper ? 'wrapper: ' : ''}${step}`;
        // Wrapper lines already reached stderr through the tee.
        if (!fromWrapper) log(`debug: ${line}`);
        store.appendDebugLog(context, line);
      }
    : null;
}

// The runner alone decides whether a turn failed. A protocol-level failure the CLI
// announces mid-stream stays visible as a diagnostic, never as a second verdict.
export function forwardProviderEvent(eventReporter: ProviderEventReporter, event: unknown): void {
  if (!isRecord(event) || typeof event.event !== 'string') return;
  eventReporter.emit(
    event.event === 'provider.turn_failed' || event.event === 'provider.turn_completed'
      ? 'provider.error'
      : event.event,
    typeof event.summary === 'string' ? event.summary : null,
    isRecord(event.details) ? event.details : null,
  );
}

export function captureUsage(client: CliClient, stdout: string): UsageCapture | null {
  try {
    const captured = client.captureUsage(stdout);
    return isRecord(captured) ? captured : null;
  } catch {
    return null;
  }
}

// Parses the finished process into the turn result, classifying failures the exit code hides.
export function finishTurn(
  client: CliClient,
  turn: { result: CommandResult; argv: string[]; lastMessageFile: string; summarizer: StreamSummarizer },
  reportMismatch: (reported: string) => void,
): TurnResult {
  const { result, argv, lastMessageFile, summarizer } = turn;
  const { stdout, error: executorError, exitCode, failure } = result;
  const parsed = client.parseRun(stdout, lastMessageFile);
  if (parsed.sessionId) reportMismatch(parsed.sessionId);
  const classification = classifyFinishedProcess(client, { stdout, exitCode, executorError });
  let invokeError = executorError;
  if (exitCode === 0 && classification !== null) invokeError = classification.message;
  const usage = captureUsage(client, stdout);
  return {
    responseText: parsed.text,
    sessionId: parsed.sessionId,
    invokeError,
    argv,
    usage,
    classification,
    source: parsed.source,
    exitCode,
    ...(failure ? { failure } : {}),
    ...(result.process ? { facts: result.process } : {}),
    summarizer,
  };
}
