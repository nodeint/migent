import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  CliClient,
  CommandExecutor,
  CommandResult,
  InterruptPolicy,
  InterruptReport,
  NewSession,
  ProcessStartInfo,
  StopReason,
  UsageCapture,
} from '@nodeint/migent-kernel';
import { debugEnabled, interruptSession, isSettled, log, StreamSummarizer } from '@nodeint/migent-kernel';
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
export function forwardProviderEvent(eventReporter: TurnEvents, event: unknown): void {
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

/** The slice of `ProviderEventReporter` a turn uses. */
export interface TurnEvents {
  readonly emit: ProviderEventReporter['emit'];
}

// Tracks every session id a turn may own on the CLI's server and interrupts them on stop.
function trackTurnSessions(
  turn: { client: CliClient; workspace: string; eventReporter: TurnEvents; interruptPolicy: InterruptPolicy },
  expectedId: string | null,
): {
    observe: (reported: string) => void;
    reportMismatch: (reported: string) => void;
    cleanup: (phase: 'before' | 'after', reason: StopReason) => Promise<boolean>;
  } {
    const { client, workspace, eventReporter, interruptPolicy } = turn;
    // Every id this turn may own on the CLI's server: the one Migent holds, and any
    // different one the CLI reports. Cleanup targets all of them.
    const knownIds = new Set<string>(expectedId ? [expectedId] : []);
    const reports = new Map<string, InterruptReport>();
    let mismatchReported = false;
    const reportMismatch = (reported: string) => {
      if (expectedId === null || reported === expectedId || mismatchReported) return;
      mismatchReported = true;
      eventReporter.emit(
        'provider.warning',
        `provider reported session ${reported}, not the expected ${expectedId}; both are targeted for cleanup`,
        { expected_agent_id: expectedId, reported_agent_id: reported },
      );
    };
    const cleanup = async (phase: 'before' | 'after', reason: StopReason): Promise<boolean> => {
      let attempted = false;
      for (const id of [...knownIds]) {
        // After the process is gone, only sessions not yet seen interrupted are asked again.
        if (phase === 'after' && reports.get(id)?.outcome === 'interrupted') continue;
        const report = await interruptSession(client, { agentId: id, cwd: workspace }, interruptPolicy);
        if (report === null) continue;
        attempted = true;
        reports.set(id, report);
        const details = { agent_id: id, reason, phase, outcome: report.outcome, attempts: report.attempts };
        if (isSettled(report)) {
          eventReporter.emit('provider.interrupt', `session ${id}: ${report.outcome}`, details);
        } else if (phase === 'after') {
          eventReporter.emit(
            'provider.warning',
            `could not confirm session ${id} stopped (${report.detail}); agent id retained for recovery`,
            details,
          );
        }
      }
      return attempted;
    };
    const observe = (reported: string): void => {
      if (knownIds.has(reported)) return;
      knownIds.add(reported);
      reportMismatch(reported);
    };
    return { observe, reportMismatch, cleanup };
  }

/** What one provider turn needs. Both `AgentToolRunner.runTurn` and `invokeOnce` build this. */
export interface ProviderTurnCall {
  readonly client: CliClient;
  readonly model: string;
  readonly workspace: string;
  readonly prompt: string;
  readonly agentId: string | null;
  readonly newSession: NewSession | null;
  readonly options: Record<string, string>;
  readonly events: TurnEvents;
  readonly onDebug: ((step: string, fromWrapper?: boolean) => void) | null;
  readonly onStart: (info: ProcessStartInfo) => void;
  /** Aborting stops this turn's process group. */
  readonly signal?: AbortSignal;
}

/** Runs one provider process and parses its result. The single turn-execution path. */
export async function runProviderTurn(
  runner: { executor: CommandExecutor; interruptPolicy: InterruptPolicy },
  call: ProviderTurnCall,
): Promise<TurnResult> {
  const { client, model, workspace, prompt, agentId, newSession, options, events, onDebug, onStart, signal } = call;
  const tmp = mkdtempSync(path.join(tmpdir(), 'migent_'));
  try {
    const promptFile = path.join(tmp, 'prompt.txt');
    const lastMessageFile = path.join(tmp, 'last_message.txt');
    writeFileSync(promptFile, prompt, 'utf8');
    const spec = client.runCommand({
      model,
      workspace,
      prompt,
      agentId,
      newAgentId: newSession?.agentId ?? null,
      promptFile,
      lastMessageFile,
      options,
    });
    // One parser per turn: a client's parser may keep state between lines.
    const parseEvent = client.createEventParser();
    const sessions = trackTurnSessions(
      { client, workspace, eventReporter: events, interruptPolicy: runner.interruptPolicy },
      agentId || newSession?.agentId || null,
    );
    const summarizer = new StreamSummarizer(client.eventLabel !== undefined);
    const result = await runner.executor.run(spec, workspace, {
      onDebug,
      ...(signal === undefined ? {} : { signal }),
      // Only a client with a server-side interrupt gets hooks, and so the exit grace period.
      ...(client.interruptCommand === undefined
        ? {}
        : {
            onInterrupt: (reason: StopReason) => sessions.cleanup('before', reason),
            onStopped: (reason: StopReason) => sessions.cleanup('after', reason),
          }),
      onOutput: (line) => {
        summarizer.add(line, client.eventLabel?.(line) ?? null);
        const reported = client.sessionIdFromLine?.(line) ?? null;
        if (reported !== null) sessions.observe(reported);
        forwardProviderEvent(events, parseEvent(line));
      },
      onHeartbeat: (elapsed) => {
        events.emit('provider.heartbeat', `running for ${elapsed}s`, { elapsed_seconds: elapsed });
      },
      onStart,
    });
    return finishTurn(client, { result, argv: spec.argv, lastMessageFile, summarizer }, sessions.reportMismatch);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
